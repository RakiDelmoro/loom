/**
 * The agent loop: what turns a model into an agent.
 *
 * One turn is: assemble the conversation, call the model, and act on what comes
 * back. A tool call is dispatched and its result appended; a `finish` call ends
 * the role; a reply with no tool call is an implicit finish. Everything the
 * model or a tool can get wrong comes back as a result the model can read, so
 * the loop keeps going instead of throwing.
 *
 * Two control tools are intercepted here rather than dispatched as ordinary
 * tools, because only the loop can implement them: `agent` needs the scheduler,
 * and `finish` ends the role.
 */

import type { LoopCheck, RoutingProfile } from '../blueprint/types.ts'
import { isRecord } from '../guards.ts'
import type { ChatResult, Message, Provider, ToolCall, ToolSpec, Usage } from '../model/types.ts'
import type { RunControl } from '../runs/control.ts'
import type { RunEventSink } from '../runs/events.ts'
import type { ToolPolicy } from '../tools/policy.ts'
import type { ToolRegistry } from '../tools/types.ts'
import type { AgentOutcome, ResultCard } from './types.ts'
import { isResultStatus } from './types.ts'

export const AGENT_TOOL = 'agent'
export const FINISH_TOOL = 'finish'

const DEFAULT_MAX_TOKENS = 4096

/** Mutable while a role runs; `Usage` is the frozen shape the outcome carries. */
interface UsageTotals {
	inputTokens: number
	cachedInputTokens: number
	outputTokens: number
}

export interface DelegationRequest {
	readonly role: string
	readonly task: string
}

export interface AgentLoopDependencies {
	readonly provider: Provider
	readonly tools: ToolRegistry
	/** What the run permits, independent of what the role was granted. */
	readonly policy: ToolPolicy
	/** The operator's channel into a running role. */
	readonly control: RunControl
	/** Hands a sub-task to another role and resolves with that role's card. */
	readonly delegate: (request: DelegationRequest) => Promise<ResultCard>
	readonly events: RunEventSink
	readonly now: () => number
	/**
	 * A monotonic millisecond reading, for durations only.
	 *
	 * `now` is a wall clock, and a wall clock steps: NTP corrects it, a resumed VM
	 * re-syncs it, and it can go backwards. An absolute timestamp should follow it;
	 * an elapsed time must not, or a run reports a negative latency.
	 */
	readonly monotonicNow: () => number
	/** Waits, for the backoff between attempts. Injected so tests do not wait. */
	readonly sleep: (milliseconds: number) => Promise<void>
	/**
	 * The loop detector's cadence, from the Blueprint. `null` means the Blueprint
	 * has no detector, so the engine never checks.
	 */
	readonly loopCheck: LoopCheck | null
	/**
	 * Whether a role other than the writer has verified the work — a tester or
	 * reviewer finished successfully after the last successful writer. The gate
	 * consults this; the scheduler owns the record.
	 */
	readonly verified: () => boolean
}

export interface AgentLoopRequest {
	/** The role instance running; every event the loop emits is attributed to it. */
	readonly agentId: string
	readonly systemPrompt: string
	readonly task: string
	readonly profile: RoutingProfile
	readonly toolSpecs: readonly ToolSpec[]
	/** The tool names this role may call. A call outside this list is refused. */
	readonly allowedTools: readonly string[]
	readonly workspaceRoot: string
	/** How many `agent` calls this role may have in flight at once. */
	readonly maxChildren: number
	/** 0 for the entry role — the verification gate applies only there. */
	readonly depth?: number
	/**
	 * The loop-check handler is exempt from the cadence: a handler that triggered
	 * checks on itself would recurse into itself. Undefined means not exempt.
	 */
	readonly loopCheckExempt?: boolean
}

interface ToolCallOutcome {
	readonly serialized: string
	readonly kind: string
	/** What the tool produced, for the audit log. */
	readonly payload: unknown
}

export async function runAgentLoop(
	dependencies: AgentLoopDependencies,
	request: AgentLoopRequest,
): Promise<AgentOutcome> {
	const startedAt = dependencies.now()
	const messages: Message[] = [
		// The role's own prompt says what to do and never *where*. Left to guess, a
		// model recites a path from its training data — /testbed, someone else's
		// Windows desktop — and spends its whole turn budget discovering, one shell
		// command at a time, that the guess was wrong.
		{ role: 'system', content: `${request.systemPrompt}\n\n${workspaceBriefing(request.workspaceRoot)}` },
		{ role: 'user', content: request.task },
	]
	const usage: UsageTotals = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }
	let turns = 0
	/** How many times the role has been told it must call `finish` rather than going quiet. */
	let nudges = 0
	/** Tool calls and output tokens since the last loop-check cadence crossing. */
	let toolCallsSinceCheck = 0
	let outputSinceCheck = 0
	/**
	 * Every tool call this role has made, for the loop detector. The handler's
	 * verdict is only as good as the history it sees: the last turn's calls show
	 * one write, while the role may have written the identical file nine times.
	 */
	const toolCallTrace: { readonly name: string; readonly arguments: string }[] = []
	/** The pressure notice fires once per role; the conversation only grows. */
	let contextNoticeSent = false
	/** Success finishes the verification gate has refused; bounded by MAX_NUDGES. */
	let gateRefusals = 0

	// No turn cap. A role runs until it calls `finish`, or until the loop detector
	// or the deployment container stops it: a fixed count fires on healthy
	// long-horizon work long before the context window fills.
	for (;;) {
		turns += 1

		// The safe point. A held run waits here, and anything the operator sent
		// arrives as a user message the model actually sees.
		for (const notice of await dependencies.control.drain()) {
			messages.push({ role: 'user', content: `[Operator notice] ${notice}` })
			dependencies.events({ type: 'operator_notice', agentId: request.agentId, message: notice })
		}

		// The endpoint may not answer usefully the first time: a local server 500s on
		// a tool call it cannot parse, a provider rate-limits, a quantised model
		// finishes a sentence having emitted nothing. A role that gave up on one of
		// those would make autonomy impossible — and a role that called an empty
		// answer "Completed." would report work it never did, which is how a coder
		// came back successful with no commit at all.
		const ask = async (): Promise<ChatResult> => {
			const answer = await dependencies.provider.chat({
				model: request.profile.model,
				messages,
				tools: request.toolSpecs,
				temperature: request.profile.temperature,
				maxTokens: request.profile.maxTokens ?? DEFAULT_MAX_TOKENS,
			})
			// Every attempt is billed, the discarded ones included: a retry that cost
			// nothing would make the run's total a lie.
			if (answer.kind === 'success') {
				usage.inputTokens += answer.response.usage.inputTokens
				usage.cachedInputTokens += answer.response.usage.cachedInputTokens
				usage.outputTokens += answer.response.usage.outputTokens
			}
			return answer
		}

		const callStartedAt = dependencies.monotonicNow()
		let result = await ask()
		for (let attempt = 1; attempt <= MODEL_RETRY_LIMIT && isRetryable(result); attempt += 1) {
			const delayMs = MODEL_RETRY_BASE_MS * 2 ** (attempt - 1)
			dependencies.events({
				type: 'model_retry',
				agentId: request.agentId,
				attempt,
				delayMs,
				reason: describeUnusable(result),
			})
			await dependencies.sleep(delayMs)
			result = await ask()
		}
		const callFinishedAt = dependencies.monotonicNow()

		if (result.kind !== 'success') {
			// A prompt the window cannot hold will never succeed on retry: the role
			// is finished with the kind the parent's recovery logic routes on.
			const contextOverflow = result.kind === 'context_exceeded'
			return settle(
				{
					status: 'error',
					summary: contextOverflow
						? 'the conversation no longer fits the model context window'
						: `the model could not be reached: ${result.message}`,
					error: {
						kind: contextOverflow ? 'context_budget_exceeded' : result.kind,
						message: result.message,
					},
				},
				turns,
				usage,
				startedAt,
				dependencies.now(),
			)
		}

		dependencies.events({
			type: 'model_call',
			agentId: request.agentId,
			model: request.profile.model,
			usage: result.response.usage,
			messageCount: messages.length,
			// Whole milliseconds: the field is named for them, and a monotonic clock's
			// sub-millisecond precision is not something the record claims to carry.
			durationMs: Math.round(callFinishedAt - callStartedAt),
		})

		// Context pressure. The endpoint's own reported usage is the only truth —
		// the engine estimates nothing. Past the threshold, a one-shot notice asks
		// the role to wrap up and hand off while requests still succeed; the parent
		// re-delegates a fresh instance with the brief.
		const window = request.profile.contextWindow
		const pressure = request.profile.contextPressure ?? 0.8
		if (window !== undefined && !contextNoticeSent && result.response.usage.inputTokens >= window * pressure) {
			contextNoticeSent = true
			dependencies.events({
				type: 'context_pressure',
				agentId: request.agentId,
				inputTokens: result.response.usage.inputTokens,
				contextWindow: window,
			})
			messages.push({
				role: 'user',
				content:
					`[Context pressure] This conversation has reached ${String(result.response.usage.inputTokens)} of about ${String(window)} tokens. ` +
					'Stop starting new work. Call `finish` with status "error", error.kind "context_handoff", and a summary that is a handoff brief: ' +
					'what is done, what remains, the key file paths, and the immediate next step. A fresh instance will replace you and continue from it.',
			})
		}

		// A reply cut off at the output cap is not a usable answer, even when the
		// tool call inside it parsed. It is refused as a typed error rather than
		// dispatched, so a half-written file never reaches the workspace.
		if (result.response.finishReason === 'length') {
			return settle(
				{
					status: 'error',
					summary: `the model's reply was cut off at the output limit (${String(request.profile.maxTokens ?? DEFAULT_MAX_TOKENS)} tokens)`,
					error: { kind: 'output_truncated', message: 'the reply reached the output token limit before it finished' },
				},
				turns,
				usage,
				startedAt,
				dependencies.now(),
			)
		}

		const toolCalls = result.response.toolCalls
		messages.push({
			role: 'assistant',
			content: result.response.content,
			...(toolCalls.length > 0 ? { toolCalls } : {}),
		})

		if (toolCalls.length === 0) {
			// A role ends by calling `finish`. Reading prose as a finish let a run
			// report `success` having done nothing at all: the orchestrator failed to
			// delegate, then said "I'll read the test files directly to understand the
			// failing tests" and stopped — two model calls, no file touched.
			//
			// The engine cannot tell a conclusion from a statement of intent, and it
			// should not try. It says what shape it needs instead, which is what it
			// already does for a malformed `finish` — one turn for the model to say
			// something the engine can read, before the role is called unfinished.
			nudges += 1
			if (nudges > MAX_NUDGES) {
				const said = result.response.content.trim()
				return settle(
					{
						status: 'error',
						summary:
							said === ''
								? `the role went quiet ${String(nudges)} times running without finishing`
								: `the role would not finish, saying: ${said.slice(0, 240)}`,
						error: {
							kind: 'unfinished',
							message: 'the model answered without calling a tool, repeatedly, instead of calling finish',
						},
					},
					turns,
					usage,
					startedAt,
					dependencies.now(),
				)
			}

			messages.push({
				role: 'user',
				content:
					'You answered without calling a tool, which the engine cannot use as a result. ' +
					'Call `finish` with a status and a summary if you are done, or call a tool if you are not.',
			})
			continue
		}

		const finishCall = toolCalls.find((call) => call.name === FINISH_TOOL)
		if (finishCall !== undefined) {
			// The finish card routes the parent's next move — a handler's
			// `loop_detected`, a `context_handoff` brief — so its raw arguments
			// are logged: without them a misrouted verdict is undiagnosable.
			dependencies.events({
				type: 'tool_call',
				agentId: request.agentId,
				tool: finishCall.name,
				arguments: finishCall.arguments,
			})
			const card = cardFromFinish(finishCall)
			if (card !== null) {
				// The verification gate. A success the entry role reports on work only
				// its author inspected is a false report — both failed benchmark runs
				// ended this way, `success` with red tests. If a writer succeeded and
				// no read-only role (tester, reviewer) finished after it, the success
				// is refused and the role is told exactly what is missing. A run where
				// nothing was written has nothing to verify. depth 0 is the entry
				// role: children are tasks whose parents verify. A role that keeps
				// claiming success regardless is settled as an error after MAX_NUDGES
				// refusals — the same bound as a role that will not call finish.
				if (request.depth === 0 && card.status === 'success' && !dependencies.verified()) {
					gateRefusals += 1
					if (gateRefusals > MAX_NUDGES) {
						return settle(
							{
								status: 'error',
								summary: `the role reported success ${String(gateRefusals)} times without verification, and was refused each time`,
								error: {
									kind: 'unverified_success',
									message: 'a role other than the one that wrote the change must run the checks before success',
								},
							},
							turns,
							usage,
							startedAt,
							dependencies.now(),
						)
					}
					dependencies.events({ type: 'error', agentId: request.agentId, kind: 'unverified_success', message: 'success refused pending verification' })
					messages.push({
						role: 'user',
						content:
							'[Verification gate] You called finish with success, but no role other than the writer has run the checks. ' +
							'Delegate to `tester` (build, tests, typecheck) and then to `reviewer` with the original task; call finish again after they report.',
					})
					continue
				}
				return settle(card, turns, usage, startedAt, dependencies.now())
			}
			// A malformed `finish` is reported back like any other tool error, so
			// the model can correct it rather than the run dying on a typo.
		}

		const results = await dispatchToolCalls(dependencies, request, toolCalls)
		for (const [index, call] of toolCalls.entries()) {
			messages.push({ role: 'tool', toolCallId: call.id, content: results[index] ?? '' })
		}

		// The loop detector. With no turn limit, a stuck role would spin forever,
		// so on the cadence the engine asks the handler role to judge the work so
		// far; a `loop_detected` verdict ends this role with that card.
		if (dependencies.loopCheck !== null && request.loopCheckExempt !== true) {
			toolCallTrace.push(...toolCalls.map((callItem) => ({ name: callItem.name, arguments: callItem.arguments })))
			toolCallsSinceCheck += toolCalls.length
			outputSinceCheck += result.response.usage.outputTokens
			if (toolCallsSinceCheck >= dependencies.loopCheck.everyToolCalls || outputSinceCheck >= dependencies.loopCheck.everyTokens) {
				toolCallsSinceCheck = 0
				outputSinceCheck = 0
				const verdict = await dependencies.delegate({
					role: dependencies.loopCheck.handlerRole,
					task: loopCheckTask(request, toolCallTrace),
				})
				// A handler that ends in error without a structured kind is treated
				// as a verdict to stop: an undecidable check must fail toward
				// aborting, or a malformed finish turns the detector off.
				const detected = verdict.status === 'error' && (verdict.error?.kind === 'loop_detected' || verdict.error?.kind === 'unfinished')
				dependencies.events({
					type: 'loop_check',
					agentId: request.agentId,
					handler: dependencies.loopCheck.handlerRole,
					verdict: detected ? 'loop_detected' : 'continue',
					summary: verdict.summary,
				})
				if (detected) {
					return settle(verdict, turns, usage, startedAt, dependencies.now())
				}
			}
		}
	}
}

/**
 * The handler's briefing: what the target was asked, and its **full** tool-call
 * history — the handler reads nothing else, so the evidence has to be complete.
 * The last turn alone hides a loop: nine identical writes look like one. The
 * window keeps the briefing bounded on long-horizon roles, and the repeat
 * counts name the signature directly, so "same call, N times" is legible
 * without the handler diffing lines itself.
 */
function loopCheckTask(request: AgentLoopRequest, trace: readonly { readonly name: string; readonly arguments: string }[]): string {
	const WINDOW = 40
	const recent = trace.slice(-WINDOW)
	const counts = new Map<string, number>()
	for (const callItem of trace) {
		const signature = `${callItem.name} ${callItem.arguments}`
		counts.set(signature, (counts.get(signature) ?? 0) + 1)
	}
	const repeats = [...counts.entries()]
		.filter(([, count]) => count > 1)
		.sort((left, right) => right[1] - left[1])
		.slice(0, 5)
		.map(([signature, count]) => `  ${String(count)}x identical: ${signature.slice(0, 100)}`)
		.join('\n')
	const calls = recent.map((callItem) => `${callItem.name}(${callItem.arguments.slice(0, 120)})`).join('\n')
	return [
		`Role "${request.agentId}" may be stuck in a loop. Its task: ${request.task}`,
		`Its last ${String(recent.length)} tool calls (of ${String(trace.length)} total):`,
		calls,
		repeats === '' ? 'No tool call was repeated with identical arguments.' : 'Calls repeated with byte-identical arguments:',
		repeats,
		'Decide whether this role is making progress or repeating itself without progress.',
		'Identical repeated calls with the same failing result are a loop; similar calls whose results differ are progress.',
		'If it repeats without progress, call finish with status "error" and error.kind "loop_detected".',
		'If it is making progress, call finish with status "success" and a one-line summary.',
	].join('\n')
}


/**
 * Runs the turn's tool calls and returns one serialized result per call, in the
 * order the model asked for them.
 *
 * Ordinary tools run one at a time: they share one worktree, so running them
 * concurrently would race. Delegations fan out — bounded by the role's own
 * ceiling, and again by the run-wide pool — because separate agents have
 * separate worktrees and nothing to race over.
 */
async function dispatchToolCalls(
	dependencies: AgentLoopDependencies,
	request: AgentLoopRequest,
	toolCalls: readonly ToolCall[],
): Promise<string[]> {
	const results = new Map<string, string>()

	for (const call of toolCalls) {
		if (call.name === AGENT_TOOL) continue
		results.set(call.id, (await runToolCall(dependencies, request, call)).serialized)
	}

	const delegations = toolCalls.filter((call) => call.name === AGENT_TOOL)
	for (let index = 0; index < delegations.length; index += request.maxChildren) {
		const batch = delegations.slice(index, index + request.maxChildren)
		const settled = await Promise.all(batch.map((call) => runToolCall(dependencies, request, call)))
		for (const [offset, call] of batch.entries()) results.set(call.id, settled[offset]?.serialized ?? '')
	}

	return toolCalls.map((call) => results.get(call.id) ?? '')
}

async function runToolCall(
	dependencies: AgentLoopDependencies,
	request: AgentLoopRequest,
	call: ToolCall,
): Promise<ToolCallOutcome> {
	dependencies.events({
		type: 'tool_call',
		agentId: request.agentId,
		tool: call.name,
		arguments: call.arguments,
	})
	const outcome = await executeToolCall(dependencies, request, call)
	dependencies.events({
		type: 'tool_result',
		agentId: request.agentId,
		tool: call.name,
		kind: outcome.kind,
		result: outcome.payload,
	})
	return outcome
}

async function executeToolCall(
	dependencies: AgentLoopDependencies,
	request: AgentLoopRequest,
	call: ToolCall,
): Promise<ToolCallOutcome> {
	// The grant list is the capability model: a role may call only what the
	// Blueprint gave it, whatever the model asks for. Reviewer roles hold no
	// mutating tools, and that has to hold against a model that calls one anyway.
	if (!request.allowedTools.includes(call.name)) {
		const denied = { kind: 'unknown_tool', message: `no tool named "${call.name}" is available to this role` }
		return { serialized: JSON.stringify(denied), kind: 'unknown_tool', payload: denied }
	}

	// The run's policy is a second gate, independent of the role's grants: a grant
	// describes intent, the mode describes containment.
	const decision = dependencies.policy.decide(call.name)
	if (decision.kind === 'deny') {
		// Audited as well as returned, so a blocked command is something an operator
		// can find after the fact rather than only in a transcript they must replay.
		dependencies.events({
			type: 'error',
			agentId: request.agentId,
			kind: 'permission_denied',
			message: decision.reason,
		})
		const denied = { kind: 'permission_denied', message: decision.reason }
		return { serialized: JSON.stringify(denied), kind: 'permission_denied', payload: denied }
	}

	if (call.name === AGENT_TOOL) {
		const delegation = parseDelegation(call.arguments)
		if (delegation.kind !== 'ok') {
			const invalid = { kind: 'invalid_arguments', message: delegation.message }
			return { serialized: JSON.stringify(invalid), kind: 'invalid_arguments', payload: invalid }
		}
		const card = await dependencies.delegate(delegation.value)
		return { serialized: JSON.stringify(card), kind: card.status, payload: card }
	}

	if (call.name === FINISH_TOOL) {
		const invalid = {
			kind: 'invalid_arguments',
			message: 'finish needs status "success" | "error" | "needs_clarification" and a non-empty summary',
		}
		return { serialized: JSON.stringify(invalid), kind: 'invalid_arguments', payload: invalid }
	}

	const result = await dependencies.tools.run(call.name, parseArguments(call.arguments), {
		workspaceRoot: request.workspaceRoot,
	})
	return { serialized: JSON.stringify(result), kind: result.kind, payload: result }
}

/**
 * Where this role is working.
 *
 * The one fact a role cannot infer and is never given: its own workspace. Every
 * tool path is resolved against this root, `run_shell` starts here, and the
 * engine owns committing — so there is nothing here for a model to guess at.
 */
export function workspaceBriefing(workspaceRoot: string): string {
	return [
		'# Where you are working',
		'',
		`Your workspace is ${workspaceRoot}, a git repository. This is the only tree you`,
		'can see: every path your tools take is relative to it, and `run_shell` starts',
		'there. Do not reach for a path from somewhere else — a container layout, another',
		'machine, a parent directory — because none of them exist here.',
		'',
		'The engine commits your work and merges it. Do not run git commands to commit,',
		'and do not go looking for a build system to decide how to test: read what the',
		'repository actually contains, and when a command fails because a path was wrong,',
		'believe the error rather than trying the next guess.',
	].join('\n')
}

/**
 * How many times a role re-asks an endpoint that did not answer, and the first
 * wait. Exponential from there: 250ms, 500ms, 1s.
 */
const MODEL_RETRY_LIMIT = 3
const MODEL_RETRY_BASE_MS = 250

/**
 * How many times a role is told to call `finish` before it is called unfinished.
 *
 * A legitimate conclusion and a statement of intent read the same to the engine —
 * "The merge is already complete" against "I'll read the test files now" — so it
 * asks for the one shape it can read rather than guessing between them.
 */
const MAX_NUDGES = 2

/**
 * A call the endpoint may do better on if asked again.
 *
 * `invalid_response` is deliberately not here: it means the provider answered
 * with something unparseable, and asking the same thing again does not fix that.
 */
function isRetryable(result: ChatResult): boolean {
	switch (result.kind) {
		case 'unavailable':
		case 'timeout':
		case 'rate_limited':
			return true
		default:
			return false
	}
}

function describeUnusable(result: ChatResult): string {
	return result.kind === 'success' ? 'the endpoint returned neither content nor a tool call' : result.message
}

function settle(card: ResultCard, turns: number, usage: Usage, startedAt: number, finishedAt: number): AgentOutcome {
	return { card, turns, usage, startedAt, finishedAt }
}

/** A malformed arguments string becomes `{}`, so the tool reports the missing field itself. */
function parseArguments(raw: string): Record<string, unknown> {
	if (raw.trim() === '') return {}
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		return {}
	}
	return isRecord(parsed) ? parsed : {}
}

function parseDelegation(raw: string): { kind: 'ok'; value: DelegationRequest } | { kind: 'invalid'; message: string } {
	const args = parseArguments(raw)
	const role = args['role']
	const task = args['task']
	if (typeof role !== 'string' || role === '') return { kind: 'invalid', message: 'agent needs a non-empty role' }
	if (typeof task !== 'string' || task === '') return { kind: 'invalid', message: 'agent needs a non-empty task' }
	return { kind: 'ok', value: { role, task } }
}

function cardFromFinish(call: ToolCall): ResultCard | null {
	const args = parseArguments(call.arguments)
	const status = args['status']
	const summary = args['summary']
	if (!isResultStatus(status)) return null
	if (typeof summary !== 'string' || summary === '') return null

	const artifacts = args['artifacts']
	// An error card's kind is the routing signal the parent acts on — a handler's
	// `loop_detected` verdict dies here if the object is dropped.
	const error = args['error']
	const errorKind = isRecord(error) && typeof error['kind'] === 'string' ? error['kind'] : undefined
	const errorMessage = isRecord(error) && typeof error['message'] === 'string' ? error['message'] : ''
	return {
		status,
		summary,
		...(Array.isArray(artifacts) ? { artifacts: artifacts.filter((item): item is string => typeof item === 'string') } : {}),
		...(errorKind !== undefined ? { error: { kind: errorKind, message: errorMessage } } : {}),
	}
}
