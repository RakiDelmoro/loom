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

import type { RoutingProfile } from '../blueprint/types.ts'
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
	readonly maxTurns: number
	/** How many `agent` calls this role may have in flight at once. */
	readonly maxChildren: number
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

	while (turns < request.maxTurns) {
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
			return settle(
				{
					status: 'error',
					summary: `the model could not be reached: ${result.message}`,
					error: { kind: result.kind, message: result.message },
				},
				turns,
				usage,
				startedAt,
				dependencies.now(),
			)
		}

		if (isEmptyCompletion(result)) {
			return settle(
				{
					status: 'error',
					summary: `the model answered with nothing, ${String(MODEL_RETRY_LIMIT + 1)} times running`,
					error: {
						kind: 'empty_completion',
						message: 'the endpoint returned neither content nor a tool call, repeatedly',
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

		const toolCalls = result.response.toolCalls
		messages.push({
			role: 'assistant',
			content: result.response.content,
			...(toolCalls.length > 0 ? { toolCalls } : {}),
		})

		if (toolCalls.length === 0) {
			// Answered in prose without asking for a tool: that is a finish. An empty
			// answer is not — it was retried above, and is an error by the time we are
			// here, because "Completed." is a claim and not a default.
			return settle(
				{ status: 'success', summary: result.response.content.trim() },
				turns,
				usage,
				startedAt,
				dependencies.now(),
			)
		}

		const finishCall = toolCalls.find((call) => call.name === FINISH_TOOL)
		if (finishCall !== undefined) {
			const card = cardFromFinish(finishCall)
			if (card !== null) return settle(card, turns, usage, startedAt, dependencies.now())
			// A malformed `finish` is reported back like any other tool error, so
			// the model can correct it rather than the run dying on a typo.
		}

		const results = await dispatchToolCalls(dependencies, request, toolCalls)
		for (const [index, call] of toolCalls.entries()) {
			messages.push({ role: 'tool', toolCallId: call.id, content: results[index] ?? '' })
		}
	}

	return settle(
		{
			status: 'error',
			summary: `the role did not finish within ${String(request.maxTurns)} turns`,
			error: { kind: 'turn_limit', message: 'the role reached its turn limit without finishing' },
		},
		turns,
		usage,
		startedAt,
		dependencies.now(),
	)
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

/** An endpoint answering with neither content nor a tool call has not answered. */
function isEmptyCompletion(result: ChatResult): boolean {
	return result.kind === 'success' && result.response.toolCalls.length === 0 && result.response.content.trim() === ''
}

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
		case 'success':
			return isEmptyCompletion(result)
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
	return {
		status,
		summary,
		...(Array.isArray(artifacts) ? { artifacts: artifacts.filter((item): item is string => typeof item === 'string') } : {}),
	}
}
