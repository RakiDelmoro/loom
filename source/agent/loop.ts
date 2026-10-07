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
import type { Message, Provider, ToolCall, ToolSpec, Usage } from '../model/types.ts'
import type { RunEventSink } from '../runs/events.ts'
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
	/** Hands a sub-task to another role and resolves with that role's card. */
	readonly delegate: (request: DelegationRequest) => Promise<ResultCard>
	readonly events: RunEventSink
	readonly now: () => number
}

export interface AgentLoopRequest {
	/** The role instance running; every event the loop emits is attributed to it. */
	readonly agentId: string
	readonly systemPrompt: string
	readonly task: string
	readonly profile: RoutingProfile
	readonly toolSpecs: readonly ToolSpec[]
	readonly workspaceRoot: string
	readonly maxTurns: number
	/** How many `agent` calls this role may have in flight at once. */
	readonly maxChildren: number
}

interface ToolCallOutcome {
	readonly serialized: string
	readonly kind: string
}

export async function runAgentLoop(
	dependencies: AgentLoopDependencies,
	request: AgentLoopRequest,
): Promise<AgentOutcome> {
	const startedAt = dependencies.now()
	const messages: Message[] = [
		{ role: 'system', content: request.systemPrompt },
		{ role: 'user', content: request.task },
	]
	const usage: UsageTotals = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }
	let turns = 0

	while (turns < request.maxTurns) {
		turns += 1

		const result = await dependencies.provider.chat({
			model: request.profile.model,
			messages,
			tools: request.toolSpecs,
			temperature: request.profile.temperature,
			maxTokens: request.profile.maxTokens ?? DEFAULT_MAX_TOKENS,
		})

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

		usage.inputTokens += result.response.usage.inputTokens
		usage.cachedInputTokens += result.response.usage.cachedInputTokens
		usage.outputTokens += result.response.usage.outputTokens

		const toolCalls = result.response.toolCalls
		messages.push({
			role: 'assistant',
			content: result.response.content,
			...(toolCalls.length > 0 ? { toolCalls } : {}),
		})

		if (toolCalls.length === 0) {
			// The model answered without asking for a tool: that is a finish.
			const summary = result.response.content.trim()
			return settle(
				{ status: 'success', summary: summary === '' ? 'Completed.' : summary },
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
	})
	return outcome
}

async function executeToolCall(
	dependencies: AgentLoopDependencies,
	request: AgentLoopRequest,
	call: ToolCall,
): Promise<ToolCallOutcome> {
	if (call.name === AGENT_TOOL) {
		const delegation = parseDelegation(call.arguments)
		if (delegation.kind !== 'ok') {
			return {
				serialized: JSON.stringify({ kind: 'invalid_arguments', message: delegation.message }),
				kind: 'invalid_arguments',
			}
		}
		const card = await dependencies.delegate(delegation.value)
		return { serialized: JSON.stringify(card), kind: card.status }
	}

	if (call.name === FINISH_TOOL) {
		return {
			serialized: JSON.stringify({
				kind: 'invalid_arguments',
				message: 'finish needs status "success" | "error" | "needs_clarification" and a non-empty summary',
			}),
			kind: 'invalid_arguments',
		}
	}

	const result = await dependencies.tools.run(call.name, parseArguments(call.arguments), {
		workspaceRoot: request.workspaceRoot,
	})
	return { serialized: JSON.stringify(result), kind: result.kind }
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
