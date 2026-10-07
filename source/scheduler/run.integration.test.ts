import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, rmSync } from 'node:fs'
import * as path from 'node:path'
import { createFakeProvider } from '../model/fake.ts'
import { createRunControl } from '../runs/control.ts'
import { createNodeFileSystem } from '../node-fs.ts'
import { createTestBlueprint } from '../test-support/blueprint.ts'
import { createCounterClock } from '../test-support/clock.ts'
import { createTemporaryRepository, gitOutput } from '../test-support/git-repository.ts'
import { call, toolCallResponse } from '../test-support/model.ts'
import { createFakeRegistry } from '../test-support/providers.ts'
import { createToolRegistry } from '../tools/registry.ts'
import { createWorkspaceToolHandlers } from '../tools/workspace.ts'
import { createGitRunner } from '../workspace/git.ts'
import { createWorktreeManager } from '../workspace/worktree.ts'
import { createScheduler } from './run.ts'

/**
 * The scheduler driving real git: real worktrees, real commits, real branches.
 *
 * Opt-in — `bun run test:git` sets LOOM_GIT_TESTS. This is the end-to-end proof
 * that the concurrency built in M2 produces isolated, reviewable work.
 */
const enabled = process.env['LOOM_GIT_TESTS'] === '1'
const suite = enabled ? describe : describe.skip

suite('the scheduler against real git', () => {
	let cleanupPath: string | null = null

	afterEach(() => {
		if (cleanupPath !== null) rmSync(cleanupPath, { recursive: true, force: true })
		cleanupPath = null
	})

	test('each worktree-isolated agent commits its own work to its own branch', async () => {
		const repo = createTemporaryRepository()
		cleanupPath = repo
		const fs = createNodeFileSystem()

		const blueprint = createTestBlueprint(
			{
				// The orchestrator is worktree-isolated, as the shipped Blueprint has it,
				// so a child's work stops at the orchestrator's tree and never reaches
				// the base during the run.
				orchestrator: { tools: ['agent'], maxChildren: 2 },
				worker: { tools: ['write_file'], isolation: 'worktree' },
			},
			{ entryRole: 'orchestrator', maxConcurrentAgents: 4 },
		)

		const provider = createFakeProvider((request) => {
			const system = request.messages[0]?.content ?? ''
			const sawToolResult = request.messages.some((message) => message.role === 'tool')

			if (system.includes('worker')) {
				if (!sawToolResult) {
					const task = request.messages[1]?.content ?? 'file'
					return toolCallResponse([call('w', 'write_file', { path: `${task}.txt`, content: `${task}\n` })])
				}
				return toolCallResponse([call('f', 'finish', { status: 'success', summary: 'wrote a file' })])
			}

			if (!sawToolResult) {
				return toolCallResponse([
					call('a', 'agent', { role: 'worker', task: 'alice' }),
					call('b', 'agent', { role: 'worker', task: 'bob' }),
				])
			}
			return toolCallResponse([call('f', 'finish', { status: 'success', summary: 'both wrote' })])
		})

		const scheduler = createScheduler(
			{
				providers: createFakeRegistry(provider),
				tools: createToolRegistry(createWorkspaceToolHandlers({ fs })),
				worktrees: createWorktreeManager({ git: createGitRunner({ cwd: repo }), fs }, { repoPath: repo }),
				blueprint,
				now: createCounterClock(),
				monotonicNow: createCounterClock(),
				sleep: async () => {},
				events: () => {},
				control: createRunControl(),
			},
			{ repoPath: repo, prices: {}, modelOverrides: {}, approvals: [] },
		)

		const result = await scheduler.run({ runId: 'run-1', task: 'write two files' })

		expect(result.card.status).toBe('success')

		const workers = result.agents.filter((agent) => agent.role === 'worker')
		expect(workers).toHaveLength(2)
		expect(workers.map((worker) => worker.branch)).toEqual(['loom/run-1/worker-1-2', 'loom/run-1/worker-1-3'])
		expect(workers.every((worker) => worker.sha !== null)).toBe(true)

		// Each agent's file is on its own branch, and its own branch only.
		expect(gitOutput(repo, ['show', '--name-only', '--format=', 'loom/run-1/worker-1-2']).trim()).toBe('alice.txt')
		expect(gitOutput(repo, ['show', '--name-only', '--format=', 'loom/run-1/worker-1-3']).trim()).toBe('bob.txt')

		// The base tree holds neither, and each worktree still holds its own.
		expect(existsSync(path.join(repo, 'alice.txt'))).toBe(false)
		expect(existsSync(path.join(repo, 'bob.txt'))).toBe(false)
		expect(existsSync(path.join(repo, '.loom/worktrees/run-1/worker-1-2/alice.txt'))).toBe(true)
		expect(existsSync(path.join(repo, '.loom/worktrees/run-1/worker-1-3/bob.txt'))).toBe(true)

		// And the caller has both: a child's work travels to the agent that asked
		// for it, which is what lets the caller build on it — and what lets a
		// `shared` reviewer see it at all.
		const orchestratorTree = path.join(repo, '.loom/worktrees/run-1/orchestrator-0-1')
		expect(existsSync(path.join(orchestratorTree, 'alice.txt'))).toBe(true)
		expect(existsSync(path.join(orchestratorTree, 'bob.txt'))).toBe(true)
	})

	test('a shared role sees the work a sibling committed', async () => {
		// The defect this defends against: planner and reviewer are `shared`, so
		// they worked in the BASE repository while the coder worked in a worktree.
		// The reviewer could never see the work it was asked to review, reported
		// "the change did not land", and the orchestrator retried until a coder
		// gave up and wrote into the base through a shell.
		const repo = createTemporaryRepository()
		cleanupPath = repo
		const fs = createNodeFileSystem()

		const blueprint = createTestBlueprint(
			{
				orchestrator: { tools: ['agent'], maxChildren: 1 },
				coder: { tools: ['write_file'], isolation: 'worktree' },
				reviewer: { tools: ['read_file'], isolation: 'shared' },
			},
			{ entryRole: 'orchestrator', maxConcurrentAgents: 2 },
		)

		const provider = createFakeProvider((request) => {
			const system = request.messages[0]?.content ?? ''
			const sawToolResult = request.messages.some((message) => message.role === 'tool')

			if (system.includes('coder') && !sawToolResult) {
				return toolCallResponse([call('w', 'write_file', { path: 'clamp.ts', content: 'const CAUSE = 42\n' })])
			}
			if (system.includes('coder')) {
				return toolCallResponse([call('f', 'finish', { status: 'success', summary: 'wrote clamp.ts' })])
			}
			if (system.includes('reviewer') && !sawToolResult) {
				return toolCallResponse([call('r', 'read_file', { path: 'clamp.ts' })])
			}
			if (system.includes('reviewer')) {
				// The reviewer reports what it could actually read, so the assertion
				// below is about what it saw rather than about what it was told.
				const seen = request.messages
					.filter((message) => message.role === 'tool')
					.map((message) => message.content)
					.join('\n')
				return toolCallResponse([
					call('f', 'finish', {
						status: seen.includes('CAUSE = 42') ? 'success' : 'error',
						summary: seen.includes('CAUSE = 42') ? 'the change is present' : 'the change did not land',
					}),
				])
			}
			if (!sawToolResult) return toolCallResponse([call('c', 'agent', { role: 'coder', task: 'write clamp.ts' })])
			return toolCallResponse([call('r', 'agent', { role: 'reviewer', task: 'review clamp.ts' })])
		})

		const scheduler = createScheduler(
			{
				providers: createFakeRegistry(provider),
				tools: createToolRegistry(createWorkspaceToolHandlers({ fs })),
				worktrees: createWorktreeManager({ git: createGitRunner({ cwd: repo }), fs }, { repoPath: repo }),
				blueprint,
				now: createCounterClock(),
				monotonicNow: createCounterClock(),
				sleep: async () => {},
				events: () => {},
				control: createRunControl(),
			},
			{ repoPath: repo, prices: {}, modelOverrides: {}, approvals: [] },
		)

		const result = await scheduler.run({ runId: 'run-2', task: 'write and review clamp.ts' })

		const reviewer = result.agents.find((agent) => agent.role === 'reviewer')
		expect(reviewer?.card.status).toBe('success')
		expect(reviewer?.card.summary).toBe('the change is present')

		// The coder's own branch still exists, and the base was never touched.
		expect(existsSync(path.join(repo, 'clamp.ts'))).toBe(false)
	})
})
