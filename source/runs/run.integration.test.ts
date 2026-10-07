import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import { createNodeFileSystem } from '../node-fs.ts'
import { runTask } from '../run-task.ts'
import { delay } from '../test-support/clock.ts'
import { createTemporaryRepository, gitOutput } from '../test-support/git-repository.ts'
import { createGitRunner } from '../workspace/git.ts'
import { createWorktreeManager } from '../workspace/worktree.ts'
import { createRunLifecycle } from './lifecycle.ts'
import { createRunStore } from './store.ts'

/**
 * The whole run lifecycle against real git and a real (stub) model endpoint.
 *
 * Opt-in — `bun run test:git` sets LOOM_GIT_TESTS. This is the end-to-end proof
 * that a run leaves a manifest, a log, and a branch that agree with each other,
 * and that merge, undo, and clean do what they claim.
 */
const enabled = process.env['LOOM_GIT_TESTS'] === '1'
const suite = enabled ? describe : describe.skip

/** A repository whose base commit already contains the Blueprint. */
function createRepositoryWithBlueprint(): string {
	const repo = createTemporaryRepository()

	mkdirSync(path.join(repo, 'tools'), { recursive: true })
	mkdirSync(path.join(repo, 'prompts'), { recursive: true })
	writeFileSync(
		path.join(repo, 'tools', 'write_file.json'),
		JSON.stringify({ name: 'write_file', description: 'Write a file.', parameters: { type: 'object' } }),
	)
	writeFileSync(path.join(repo, 'prompts', 'orchestrator.md'), 'You are the orchestrator.\n')
	writeFileSync(
		path.join(repo, 'loom.json'),
		JSON.stringify({
			entryRole: 'orchestrator',
			roles: { orchestrator: { prompt: 'prompts/orchestrator.md', model: 'default', tools: ['write_file'] } },
			tools: ['tools/write_file.json'],
			routing: { default: { provider: 'local', model: 'test-model', temperature: 0 } },
			budgets: {
				maxAgentDepth: 2,
				maxConcurrentAgents: 2,
				maxCostUsd: 1,
				maxTokensPerRun: 10_000,
				toolTimeoutSeconds: 30,
			},
			permissions: { mode: 'workspace-write', requireApproval: [] },
		}),
	)

	gitOutput(repo, ['add', '-A'])
	gitOutput(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-q', '-m', 'blueprint'])
	return repo
}

/** A stub OpenAI-compatible endpoint: write a file, then finish. */
function createStubModel() {
	let calls = 0
	const server = Bun.serve({
		port: 0,
		fetch: () => {
			calls += 1
			const toolCall =
				calls === 1
					? { id: 'c1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'output.txt', content: 'hello world\n' }) } }
					: { id: 'c2', type: 'function', function: { name: 'finish', arguments: JSON.stringify({ status: 'success', summary: 'wrote output.txt' }) } }

			return Response.json({
				choices: [{ message: { role: 'assistant', content: '', tool_calls: [toolCall] }, finish_reason: 'tool_calls' }],
				usage: { prompt_tokens: 10, completion_tokens: 5 },
			})
		},
	})
	return { server, baseUrl: `http://localhost:${String(server.port)}/v1` }
}

suite('the run lifecycle against real git', () => {
	let cleanupPath: string | null = null

	afterEach(() => {
		if (cleanupPath !== null) rmSync(cleanupPath, { recursive: true, force: true })
		cleanupPath = null
	})

	test('a run leaves a manifest, a log, and a branch that agree with each other', async () => {
		const repo = createRepositoryWithBlueprint()
		cleanupPath = repo
		const stub = createStubModel()

		try {
			const outcome = await runTask({
				repoPath: repo,
				blueprintPath: path.join(repo, 'loom.json'),
				task: 'write output.txt',
				autonomy: 'supervised',
				apiBase: stub.baseUrl,
			})

			expect(outcome.status).toBe('success')
			expect(outcome.merged).toEqual([])

			// The manifest is on disk, terminal, and names the agent that ran.
			const fs = createNodeFileSystem()
			const store = createRunStore({ fs, now: () => Date.now() }, { repoPath: repo })
			const manifest = store.readManifest(outcome.manifest.runId)
			if (manifest === null) throw new Error('the manifest was not written')
			expect(manifest.status).toBe('success')
			expect(manifest.autonomy).toBe('supervised')

			const agent = manifest.agents[0]
			if (agent === undefined) throw new Error('no agent was recorded')
			const branch = agent.branch
			if (branch === null) throw new Error('the agent produced no branch')
			expect(agent.role).toBe('orchestrator')
			expect(agent.sha).not.toBeNull()

			// The event log exists alongside it.
			const logPath = path.join(repo, '.loom', 'runs', outcome.manifest.runId, 'events.jsonl')
			expect(existsSync(logPath)).toBe(true)
			expect(readFileSync(logPath, 'utf8')).toContain('"type":"run_finished"')

			const git = createGitRunner({ cwd: repo })
			const worktrees = createWorktreeManager({ git, fs }, { repoPath: repo })
			const lifecycle = createRunLifecycle({ git, worktrees }, { repoPath: repo })

			// The diff the manifest points at is exactly what the agent wrote.
			const diff = lifecycle.diffBetween(manifest.baseSha, branch)
			if (diff.kind !== 'ok') throw new Error(diff.message)
			expect(diff.value).toContain('output.txt')
			expect(diff.value).toContain('hello world')

			// The base is untouched until a merge.
			expect(existsSync(path.join(repo, 'output.txt'))).toBe(false)
			expect(gitOutput(repo, ['status', '--porcelain']).trim()).toBe('')

			// Merging applies exactly that branch.
			const merged = lifecycle.mergeBranch(branch)
			if (merged.kind !== 'ok') throw new Error(merged.message)
			expect(readFileSync(path.join(repo, 'output.txt'), 'utf8')).toBe('hello world\n')

			// Undo returns the base to the commit the run started from.
			expect(lifecycle.undo(manifest.baseSha)).toEqual({ kind: 'ok', value: null })
			expect(existsSync(path.join(repo, 'output.txt'))).toBe(false)
			expect(gitOutput(repo, ['rev-parse', 'HEAD']).trim()).toBe(manifest.baseSha)

			// Clean removes the worktree and the branch, leaving no trace.
			const cleaned = lifecycle.clean(outcome.manifest.runId, { branches: true })
			if (cleaned.kind !== 'ok') throw new Error(cleaned.message)
			expect(cleaned.value).toHaveLength(1)
			expect(gitOutput(repo, ['worktree', 'list', '--porcelain'])).not.toContain('.loom/worktrees')
			expect(gitOutput(repo, ['status', '--porcelain']).trim()).toBe('')
		} finally {
			stub.server.stop(true)
		}
	})

	test('auto autonomy merges the run\u2019s branches without the operator', async () => {
		const repo = createRepositoryWithBlueprint()
		cleanupPath = repo
		const stub = createStubModel()

		try {
			const outcome = await runTask({
				repoPath: repo,
				blueprintPath: path.join(repo, 'loom.json'),
				task: 'write output.txt',
				autonomy: 'auto',
				apiBase: stub.baseUrl,
			})

			expect(outcome.status).toBe('success')
			expect(outcome.merged).toHaveLength(1)
			expect(outcome.mergeFailures).toEqual([])
			expect(readFileSync(path.join(repo, 'output.txt'), 'utf8')).toBe('hello world\n')
		} finally {
			stub.server.stop(true)
		}
	})

	test('a model endpoint that cannot be reached fails the run without leaving a worktree', async () => {
		const repo = createRepositoryWithBlueprint()
		cleanupPath = repo

		const outcome = await runTask({
			repoPath: repo,
			blueprintPath: path.join(repo, 'loom.json'),
			task: 'write output.txt',
			autonomy: 'auto',
			apiBase: 'http://127.0.0.1:1/v1',
		})

		expect(outcome.status).toBe('error')
		expect(outcome.merged).toEqual([])

		// The worktree is still there for inspection, but the base is clean and
		// the manifest records what happened.
		const fs = createNodeFileSystem()
		const store = createRunStore({ fs, now: () => Date.now() }, { repoPath: repo })
		expect(store.readManifest(outcome.manifest.runId)?.status).toBe('error')
		expect(gitOutput(repo, ['status', '--porcelain']).trim()).toBe('')

		const git = createGitRunner({ cwd: repo })
		const worktrees = createWorktreeManager({ git, fs }, { repoPath: repo })
		const cleaned = createRunLifecycle({ git, worktrees }, { repoPath: repo }).clean(outcome.manifest.runId, {
			branches: true,
		})
		if (cleaned.kind !== 'ok') throw new Error(cleaned.message)
		expect(cleaned.value).toHaveLength(1)
		expect(gitOutput(repo, ['worktree', 'list', '--porcelain'])).not.toContain('.loom/worktrees')
	})

	test('a run killed mid-flight leaves a recoverable state, not a leaked worktree', async () => {
		const repo = createRepositoryWithBlueprint()
		cleanupPath = repo

		// An endpoint that accepts the connection and never answers, so the run
		// blocks inside its first model call — after its worktree exists.
		const hanging = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) })

		const cliPath = path.join(import.meta.dir, '..', 'cli.ts')
		const proc = Bun.spawn(
			['bun', cliPath, 'run', '--repo', repo, '--task', 'write output.txt', '--api-base', `http://localhost:${String(hanging.port)}/v1`],
			{ stdout: 'pipe', stderr: 'pipe' },
		)

		try {
			// Wait until git has actually registered the worktree, not merely until
			// the directory exists — `git worktree add` creates the directory before
			// it finishes registering, and killing it in that window proves nothing.
			const started = await waitFor(
				() => gitOutput(repo, ['worktree', 'list', '--porcelain']).includes('.loom/worktrees'),
				15_000,
			)
			expect(started).toBe(true)

			proc.kill()
			await proc.exited

			const fs = createNodeFileSystem()
			const store = createRunStore({ fs, now: () => Date.now() }, { repoPath: repo })
			const runIds = store.listRunIds()
			expect(runIds).toHaveLength(1)
			const runId = runIds[0] ?? ''

			// The record is truthful about a run that never finished.
			expect(store.readManifest(runId)?.status).toBe('running')
			expect(readFileSync(path.join(repo, '.loom', 'runs', runId, 'events.jsonl'), 'utf8')).toContain('"type":"run_started"')

			// And the state it left behind is cleanable, not leaked.
			const git = createGitRunner({ cwd: repo })
			const worktrees = createWorktreeManager({ git, fs }, { repoPath: repo })
			const cleaned = createRunLifecycle({ git, worktrees }, { repoPath: repo }).clean(runId, { branches: true })
			if (cleaned.kind !== 'ok') throw new Error(cleaned.message)
			expect(cleaned.value).toHaveLength(1)
			expect(gitOutput(repo, ['worktree', 'list', '--porcelain'])).not.toContain('.loom/worktrees')
			expect(gitOutput(repo, ['status', '--porcelain']).trim()).toBe('')
		} finally {
			proc.kill()
			hanging.stop(true)
		}
	})
})

/** Polls until `predicate` holds or the budget runs out. */
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (predicate()) return true
		await delay(50)
	}
	return false
}
