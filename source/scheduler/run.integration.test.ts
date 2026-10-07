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
				orchestrator: { tools: ['agent'], maxChildren: 2, isolation: 'shared' },
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
	})
})
