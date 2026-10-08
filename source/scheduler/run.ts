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
import { attemptKey } from '../runs/types.ts'
import { createToolPolicy } from '../tools/policy.ts'
import type { ToolRegistry } from '../tools/types.ts'
import type { CreatedWorktree, WorktreeManager } from '../workspace/worktree.ts'
import { createLimitedProvider, createPool } from './pool.ts'
import type { AgentNode, RunResult } from './types.ts'

const MAX_TURNS_PER_ROLE = 24

export interface SchedulerDependencies {
	readonly providers: ProviderRegistry
	readonly tools: ToolRegistry
	readonly worktrees: WorktreeManager
	readonly blueprint: LoadedBlueprint
	readonly now: () => number
	readonly monotonicNow: () => number
	readonly sleep: (milliseconds: number) => Promise<void>
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
	/** What this role was asked; with role and parent, it identifies a retry. */
	task: string
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
	/** One integration at a time per workspace; siblings finish concurrently. */
	readonly integrations: Map<string, Promise<void>>
	/** Requests whose work has already been accepted into a caller's tree. */
	readonly accepted: Set<string>
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

	/**
	 * Runs `body` with no other integration in flight against the same workspace.
	 *
	 * Siblings finish concurrently — a parent may delegate to three children at
	 * once — and two merges into one working tree would race. The queue is per
	 * workspace because that is the resource being contended for.
	 */
	async function withWorkspaceLock<T>(
		state: RunState,
		workspace: string,
		body: () => T | Promise<T>,
	): Promise<T> {
		const previous = state.integrations.get(workspace) ?? Promise.resolve()
		const next = previous.then(
			() => body(),
			() => body(),
		)
		// Stored already-settled: the queue is only ever used for ordering, and a
		// failed integration must not reject the next waiter.
		state.integrations.set(
			workspace,
			next.then(
				() => undefined,
				() => undefined,
			),
		)
		return next
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
		/**
		 * The workspace the caller is working in. A `shared` role works here too —
		 * sharing means sharing *the caller's* tree, not the base repository, which
		 * is what makes a reviewer able to see the work it was asked to review.
		 */
		callerWorkspace: string,
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

		let workspaceRoot = callerWorkspace
		let worktree: CreatedWorktree | null = null
		if (role.isolation === 'worktree') {
			// Branch from the caller, not from where the run began. The caller is
			// carrying its other children's work, and a child that cannot see it
			// re-does work that is already merged — then conflicts with the very
			// commit it duplicated, which is how one benchmark became thirteen
			// agents and two hundred model calls. An unreadable caller falls back to
			// the run's base, which is the old behaviour and still correct for a root.
			const fromCaller = dependencies.worktrees.headOf(callerWorkspace)
			const base = fromCaller.kind === 'ok' ? fromCaller.value : state.baseSha

			const worktreeResult = dependencies.worktrees.create(state.runId, agentId, base)
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
			task,
			depth,
			startedAt,
			finishedAt: startedAt,
			card: errorCard('running', 'still running'),
			branch: worktree === null ? null : worktree.branch,
			sha: null,
		}
		state.agents.push(node)
		dependencies.events({ type: 'agent_start', agentId, role: roleName, parentId, depth, task })

		const outcome = await runAgentLoop(
			{
				provider: createLimitedProvider(created.value, pool),
				tools: dependencies.tools,
				policy,
				control: dependencies.control,
				delegate: (request) => execute(state, request.role, request.task, agentId, depth + 1, workspaceRoot),
				events: dependencies.events,
				now: dependencies.now,
				monotonicNow: dependencies.monotonicNow,
				sleep: dependencies.sleep,
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

		// The child's work travels to the caller. A sub-task whose result cannot be
		// seen by the agent that asked for it is not a sub-task the caller can use,
		// so this happens before the card is returned rather than at the end of the
		// run. A `shared` role works in the caller's tree, which is why it is now
		// able to review a sibling's work at all.
		let card = outcome.card
		// Only a role that succeeded has work worth carrying. A failed attempt's
		// commits stay on its own branch: three coders that hit their turn limit
		// were having their work folded into the caller's tree and then merged.
		if (worktree !== null && sha !== null && parentId !== null && outcome.card.status === 'success') {
			// A second attempt at the same request *replaces* the first. The caller
			// asked again because the first answer was not good enough, so the newer
			// attempt wins the conflicts rather than losing the merge to its
			// predecessor — merging both is what made persistence self-defeating.
			//
			// Both the decision and the record of it happen inside the lock: two
			// attempts issued in the same turn finish concurrently, and a check made
			// outside would let them both conclude they were first.
			const acceptedKey = attemptKey({ parentId, role: roleName, task })
			const integrated = await withWorkspaceLock(state, callerWorkspace, () => {
				const supersedes = state.accepted.has(acceptedKey)
				const result = dependencies.worktrees.integrate(callerWorkspace, worktree.branch, {
					onConflict: supersedes ? 'incoming' : 'refuse',
				})
				if (result.kind === 'ok') state.accepted.add(acceptedKey)
				return result
			})
			const ok = integrated.kind === 'ok'
			dependencies.events({
				type: 'integration',
				agentId,
				branch: worktree.branch,
				into: callerWorkspace,
				status: ok ? 'merged' : 'conflict',
				message: ok ? '' : integrated.message,
			})
			card = ok
				? { ...card, integration: { kind: 'merged' } }
				: { ...card, integration: { kind: 'conflict', message: integrated.message } }
		}

		node.finishedAt = dependencies.now()
		node.card = card
		node.sha = sha
		dependencies.events({
			type: 'agent_finish',
			agentId,
			role: roleName,
			parentId,
			depth,
			task,
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

		return card
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
				integrations: new Map(),
				accepted: new Set(),
			}
			const card = await execute(state, blueprint.entryRole, request.task, null, 0, options.repoPath)

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
