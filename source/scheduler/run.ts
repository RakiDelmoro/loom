/**
 * The scheduler: runs a task as a tree of agents.
 *
 * It owns the three things the agent loop deliberately does not know about —
 * worktrees, the depth limit, and concurrency — and it owns the run's record of
 * what happened. A child is delegated through the loop's `delegate` callback,
 * so the recursion is the same code path at every depth.
 */

import { runAgentLoop } from '../agent/loop.ts'
import type { ResultCard } from '../agent/types.ts'
import type { LoadedBlueprint, LoadedRole } from '../blueprint/types.ts'
import { routeRole } from '../model/router.ts'
import type { Provider, ToolSpec } from '../model/types.ts'
import type { RunEventSink } from '../runs/events.ts'
import type { ToolRegistry } from '../tools/types.ts'
import type { WorktreeManager, WorktreeRef } from '../workspace/worktree.ts'
import { createLimitedProvider, createPool } from './pool.ts'
import type { AgentNode, RunResult } from './types.ts'

const MAX_TURNS_PER_ROLE = 24

export interface SchedulerDependencies {
	readonly provider: Provider
	readonly tools: ToolRegistry
	readonly worktrees: WorktreeManager
	readonly blueprint: LoadedBlueprint
	readonly now: () => number
	readonly events: RunEventSink
}

export interface SchedulerOptions {
	/** The repository agents branch from. `shared` roles work here directly. */
	readonly repoPath: string
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
}

export function createScheduler(
	dependencies: SchedulerDependencies,
	options: SchedulerOptions,
): { run(request: RunRequest): Promise<RunResult> } {
	const { blueprint } = dependencies
	const provider = createLimitedProvider(
		dependencies.provider,
		createPool({ maxConcurrent: blueprint.budgets.maxConcurrentAgents }),
	)

	/** Only the tools the role was granted, in the order the Blueprint declares them. */
	function toolSpecsFor(role: LoadedRole): ToolSpec[] {
		const granted = new Set(role.tools)
		return blueprint.tools
			.filter((manifest) => granted.has(manifest.name))
			.map((manifest) => ({ name: manifest.name, description: manifest.description, parameters: manifest.parameters }))
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

		state.counter += 1
		const agentId = `${roleName}-${String(depth)}-${String(state.counter)}`
		const startedAt = dependencies.now()

		let workspaceRoot = options.repoPath
		let worktree: WorktreeRef | null = null
		if (role.isolation === 'worktree') {
			const created = dependencies.worktrees.create(state.runId, agentId, state.baseSha)
			if (created.kind !== 'ok') {
				dependencies.events({ type: 'error', agentId, kind: 'worktree_failed', message: created.message })
				return errorCard('worktree_failed', created.message)
			}
			worktree = created.value
			workspaceRoot = created.value.path
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
				provider,
				tools: dependencies.tools,
				delegate: (request) => execute(state, request.role, request.task, agentId, depth + 1),
				events: dependencies.events,
				now: dependencies.now,
			},
			{
				agentId,
				systemPrompt: role.systemPrompt,
				task,
				profile: routeRole(blueprint, roleName),
				toolSpecs: toolSpecsFor(role),
				workspaceRoot,
				maxTurns: MAX_TURNS_PER_ROLE,
				maxChildren: role.maxChildren,
			},
		)

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
			usage: outcome.usage,
		})

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

			const state: RunState = { runId: request.runId, baseSha: base.value, agents: [], counter: 0 }
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
