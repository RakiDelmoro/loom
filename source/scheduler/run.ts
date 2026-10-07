/**
 * The scheduler: runs a task as a tree of agents.
 *
 * It owns the four things the agent loop deliberately does not know about —
 * worktrees, the depth limit, concurrency, and what a run costs — and it owns
 * the run's record of what happened. A child is delegated through the loop's
 * `delegate` callback, so the recursion is the same code path at every depth.
 *
 * Cost is **measured, never enforced**: an `alerts` threshold emits an event and
 * nothing else. What bounds a runaway run is recursion depth, the per-role turn
 * limit, the tool timeout, and the deployment container.
 */

import { runAgentLoop } from '../agent/loop.ts'
import type { ResultCard } from '../agent/types.ts'
import type { LoadedBlueprint, LoadedRole } from '../blueprint/types.ts'
import { computeCost, ZERO_PRICE } from '../deployment/cost.ts'
import type { ModelPrice } from '../deployment/types.ts'
import type { ProviderRegistry } from '../deployment/registry.ts'
import { routeRole } from '../model/router.ts'
import type { ToolSpec } from '../model/types.ts'
import type { RunControl } from '../runs/control.ts'
import type { RunEventSink } from '../runs/events.ts'
import { createToolPolicy } from '../tools/policy.ts'
import type { ToolRegistry } from '../tools/types.ts'
import type { WorktreeManager, WorktreeRef } from '../workspace/worktree.ts'
import { createLimitedProvider, createPool } from './pool.ts'
import type { AgentNode, RunResult } from './types.ts'

const MAX_TURNS_PER_ROLE = 24

export interface SchedulerDependencies {
	readonly providers: ProviderRegistry
	readonly tools: ToolRegistry
	readonly worktrees: WorktreeManager
	readonly blueprint: LoadedBlueprint
	readonly now: () => number
	readonly events: RunEventSink
	readonly control: RunControl
}

export interface SchedulerOptions {
	/** The repository agents branch from. `shared` roles work here directly. */
	readonly repoPath: string
	/** What each model costs. A model absent here is priced at zero. */
	readonly prices: Readonly<Record<string, ModelPrice>>
	/** Role → profile, overriding the Blueprint for this run only. */
	readonly modelOverrides: Readonly<Record<string, string>>
	/** Tools this run has been granted approval for. */
	readonly approvals: readonly string[]
}

export interface RunRequest {
	readonly runId: string
	readonly task: string
}

/** Mutable while an agent runs; frozen into an `AgentNode` when the run ends. */
interface MutableAgentNode {
	agentId: string
	role: string
	parentId: string | null
	depth: number
	startedAt: number
	finishedAt: number
	card: ResultCard
	branch: string | null
	sha: string | null
}

interface RunState {
	readonly runId: string
	readonly baseSha: string
	readonly agents: MutableAgentNode[]
	counter: number
	costUsd: number
	tokens: number
	costAlertFired: boolean
	tokenAlertFired: boolean
}

export function createScheduler(
	dependencies: SchedulerDependencies,
	options: SchedulerOptions,
): { run(request: RunRequest): Promise<RunResult> } {
	const { blueprint } = dependencies
	const pool = createPool({ maxConcurrent: blueprint.budgets.maxConcurrentAgents })
	// One policy for the run: the mode and the approval list do not vary by role.
	const policy = createToolPolicy({
		mode: blueprint.permissions.mode,
		requireApproval: blueprint.permissions.requireApproval,
		approvals: options.approvals,
	})

	/** Only the tools the role was granted, in the order the Blueprint declares them. */
	function toolSpecsFor(role: LoadedRole): ToolSpec[] {
		const granted = new Set(role.tools)
		return blueprint.tools
			.filter((manifest) => granted.has(manifest.name))
			.map((manifest) => ({ name: manifest.name, description: manifest.description, parameters: manifest.parameters }))
	}

	/** An alert fires at most once per kind, and never stops anything. */
	function checkAlerts(state: RunState): void {
		const { alerts } = blueprint
		if (!state.costAlertFired && alerts.costUsd !== undefined && state.costUsd >= alerts.costUsd) {
			state.costAlertFired = true
			dependencies.events({ type: 'alert', kind: 'cost', threshold: alerts.costUsd, actual: state.costUsd })
		}
		if (!state.tokenAlertFired && alerts.tokens !== undefined && state.tokens >= alerts.tokens) {
			state.tokenAlertFired = true
			dependencies.events({ type: 'alert', kind: 'tokens', threshold: alerts.tokens, actual: state.tokens })
		}
	}

	async function execute(
		state: RunState,
		roleName: string,
		task: string,
		parentId: string | null,
		depth: number,
	): Promise<ResultCard> {
		// A refusal is attributed to the caller: it is the agent that asked for
		// something the run would not allow.
		const caller = parentId ?? 'run'

		const role = blueprint.roles[roleName]
		if (role === undefined) {
			const message = `role "${roleName}" is not defined in the Blueprint`
			dependencies.events({ type: 'error', agentId: caller, kind: 'role_not_found', message })
			return errorCard('role_not_found', message)
		}

		if (depth > blueprint.budgets.maxAgentDepth) {
			const message = `delegation depth ${String(depth)} exceeds the limit of ${String(blueprint.budgets.maxAgentDepth)}`
			dependencies.events({ type: 'error', agentId: caller, kind: 'depth_exceeded', message })
			return errorCard('depth_exceeded', message)
		}

		const profile = routeRole(blueprint, roleName, options.modelOverrides)
		const created = dependencies.providers.create(profile.provider)
		if (created.kind !== 'ok') {
			dependencies.events({ type: 'error', agentId: caller, kind: 'provider_unavailable', message: created.message })
			return errorCard('provider_unavailable', created.message)
		}

		state.counter += 1
		const agentId = `${roleName}-${String(depth)}-${String(state.counter)}`
		const startedAt = dependencies.now()

		let workspaceRoot = options.repoPath
		let worktree: WorktreeRef | null = null
		if (role.isolation === 'worktree') {
			const worktreeResult = dependencies.worktrees.create(state.runId, agentId, state.baseSha)
			if (worktreeResult.kind !== 'ok') {
				dependencies.events({ type: 'error', agentId, kind: 'worktree_failed', message: worktreeResult.message })
				return errorCard('worktree_failed', worktreeResult.message)
			}
			worktree = worktreeResult.value
			workspaceRoot = worktreeResult.value.path
		}

		// The node is reserved before the work starts, so `agents` records spawn
		// order — the same order every time — rather than completion order.
		const node: MutableAgentNode = {
			agentId,
			role: roleName,
			parentId,
			depth,
			startedAt,
			finishedAt: startedAt,
			card: errorCard('running', 'still running'),
			branch: worktree === null ? null : worktree.branch,
			sha: null,
		}
		state.agents.push(node)
		dependencies.events({ type: 'agent_start', agentId, role: roleName, parentId, depth })

		const outcome = await runAgentLoop(
			{
				provider: createLimitedProvider(created.value, pool),
				tools: dependencies.tools,
				policy,
				control: dependencies.control,
				delegate: (request) => execute(state, request.role, request.task, agentId, depth + 1),
				events: dependencies.events,
				now: dependencies.now,
			},
			{
				agentId,
				systemPrompt: role.systemPrompt,
				task,
				profile,
				toolSpecs: toolSpecsFor(role),
				allowedTools: role.tools,
				workspaceRoot,
				maxTurns: MAX_TURNS_PER_ROLE,
				maxChildren: role.maxChildren,
			},
		)

		// `runTask` refuses to start a run whose routed models are unpriced, so a
		// missing price here means a caller bypassed that check.
		const costUsd = computeCost(options.prices[profile.model] ?? ZERO_PRICE, outcome.usage)

		let sha: string | null = null
		if (worktree !== null) {
			const summaryLine = outcome.card.summary.split('\n')[0] ?? roleName
			const committed = dependencies.worktrees.commit(worktree, `${roleName}: ${summaryLine}`)
			if (committed.kind === 'ok') {
				sha = committed.value
				dependencies.events({ type: 'commit', agentId, branch: worktree.branch, sha })
			} else {
				dependencies.events({ type: 'error', agentId, kind: 'commit_failed', message: committed.message })
			}
		}

		node.finishedAt = dependencies.now()
		node.card = outcome.card
		node.sha = sha
		dependencies.events({
			type: 'agent_finish',
			agentId,
			role: roleName,
			parentId,
			depth,
			status: outcome.card.status,
			summary: outcome.card.summary,
			branch: node.branch,
			sha,
			startedAt: new Date(startedAt).toISOString(),
			finishedAt: new Date(node.finishedAt).toISOString(),
			model: profile.model,
			usage: outcome.usage,
			costUsd,
		})

		state.costUsd += costUsd
		state.tokens += outcome.usage.inputTokens + outcome.usage.outputTokens
		checkAlerts(state)

		return outcome.card
	}

	return {
		async run(request: RunRequest): Promise<RunResult> {
			const base = dependencies.worktrees.resolveBaseSha('HEAD')
			if (base.kind !== 'ok') {
				return {
					runId: request.runId,
					baseSha: '',
					card: errorCard('base_ref_failed', base.message),
					agents: [],
				}
			}

			const state: RunState = {
				runId: request.runId,
				baseSha: base.value,
				agents: [],
				counter: 0,
				costUsd: 0,
				tokens: 0,
				costAlertFired: false,
				tokenAlertFired: false,
			}
			const card = await execute(state, blueprint.entryRole, request.task, null, 0)

			return {
				runId: request.runId,
				baseSha: base.value,
				card,
				agents: state.agents.map((agent) => ({ ...agent })),
			}
		},
	}
}

function errorCard(kind: string, message: string): ResultCard {
	return { status: 'error', summary: message, error: { kind, message } }
}
