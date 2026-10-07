import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import { createNodeFileSystem } from '../node-fs.ts'
import { isRecord } from '../guards.ts'
import { noRedaction } from '../redact.ts'
import { runTask, type RunTaskOptions } from '../run-task.ts'
import type { AutonomyLevel } from './types.ts'
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
 * that merge, undo, and clean do what they claim, and that cost is recorded
 * without ever stopping the run.
 */
const enabled = process.env['LOOM_GIT_TESTS'] === '1'
const suite = enabled ? describe : describe.skip

/** A repository whose base commit already contains the Blueprint and deployment. */
function createRepositoryWithBlueprint(modelBaseUrl: string): string {
	const repo = createTemporaryRepository()

	mkdirSync(path.join(repo, 'tools'), { recursive: true })
	mkdirSync(path.join(repo, 'prompts'), { recursive: true })
	writeFileSync(
		path.join(repo, 'tools', 'write_file.json'),
		JSON.stringify({ name: 'write_file', description: 'Write a file.', parameters: { type: 'object' } }),
	)
	writeFileSync(
		path.join(repo, 'tools', 'finish.json'),
		JSON.stringify({ name: 'finish', description: 'End the role.', parameters: { type: 'object' } }),
	)
	writeFileSync(path.join(repo, 'prompts', 'orchestrator.md'), 'You are the orchestrator.\n')
	writeFileSync(
		path.join(repo, 'loom.json'),
		JSON.stringify({
			entryRole: 'orchestrator',
			roles: {
				orchestrator: { prompt: 'prompts/orchestrator.md', model: 'default', tools: ['write_file', 'finish'] },
			},
			tools: ['tools/write_file.json', 'tools/finish.json'],
			routing: { default: { provider: 'stub', model: 'test-model', temperature: 0 } },
			budgets: { maxAgentDepth: 2, maxConcurrentAgents: 2, toolTimeoutSeconds: 30 },
			// A deliberately tiny threshold, so the alert fires on any real spend.
			alerts: { costUsd: 0.01 },
			permissions: { mode: 'workspace-write', requireApproval: [] },
		}),
	)
	writeFileSync(
		path.join(repo, 'loom.deployment.json'),
		JSON.stringify({
			providers: { stub: { baseUrl: modelBaseUrl } },
			// $1 per million prompt tokens, $2 per million completion tokens.
			prices: { 'test-model': { inputPer1M: 1000, cachedInputPer1M: 0, outputPer1M: 2000 } },
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
					? {
							id: 'c1',
							type: 'function',
							function: {
								name: 'write_file',
								arguments: JSON.stringify({ path: 'output.txt', content: 'hello world\n' }),
							},
						}
					: {
							id: 'c2',
							type: 'function',
							function: { name: 'finish', arguments: JSON.stringify({ status: 'success', summary: 'wrote output.txt' }) },
						}

			return Response.json({
				choices: [{ message: { role: 'assistant', content: '', tool_calls: [toolCall] }, finish_reason: 'tool_calls' }],
				usage: { prompt_tokens: 10, completion_tokens: 5 },
			})
		},
	})
	return { server, baseUrl: `http://localhost:${String(server.port)}/v1` }
}

function runOptions(repo: string, task: string, autonomy: AutonomyLevel): RunTaskOptions {
	return {
		repoPath: repo,
		blueprintPath: path.join(repo, 'loom.json'),
		deploymentPath: path.join(repo, 'loom.deployment.json'),
		task,
		autonomy,
		modelOverrides: {},
		approvals: [],
		env: {},
		fetch: (url, init) => fetch(url, init),
	}
}

suite('the run lifecycle against real git', () => {
	let cleanupPath: string | null = null

	afterEach(() => {
		if (cleanupPath !== null) rmSync(cleanupPath, { recursive: true, force: true })
		cleanupPath = null
	})

	test('a run leaves a manifest, a log, and a branch that agree with each other', async () => {
		const stub = createStubModel()
		const repo = createRepositoryWithBlueprint(stub.baseUrl)
		cleanupPath = repo

		try {
			const outcome = await runTask(
				runOptions(repo, 'write output.txt', 'supervised'),
			)

			expect(outcome.status).toBe('success')
			expect(outcome.merged).toEqual([])

			// The manifest is on disk, terminal, and names the agent that ran.
			const fs = createNodeFileSystem()
			const store = createRunStore({ fs, now: () => Date.now(), redact: noRedaction }, { repoPath: repo })
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

			// The model that served the role is recorded, and its cost is real:
			// two calls at 10 prompt / 5 completion tokens each.
			expect(agent.model).toBe('test-model')
			expect(manifest.usage).toEqual({ inputTokens: 20, cachedInputTokens: 0, outputTokens: 10 })
			expect(manifest.costUsd).toBeCloseTo(0.04, 10)
			expect(manifest.models).toEqual([
				{ model: 'test-model', usage: { inputTokens: 20, cachedInputTokens: 0, outputTokens: 10 }, costUsd: 0.04 },
			])

			// The event log exists alongside it — and the alert fired without
			// stopping anything.
			const logPath = path.join(repo, '.loom', 'runs', outcome.manifest.runId, 'events.jsonl')
			expect(existsSync(logPath)).toBe(true)
			const log = readFileSync(logPath, 'utf8')
			expect(log).toContain('"type":"alert"')
			expect(log).toContain('"type":"run_finished"')

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
		const stub = createStubModel()
		const repo = createRepositoryWithBlueprint(stub.baseUrl)
		cleanupPath = repo

		try {
			const outcome = await runTask(runOptions(repo, 'write output.txt', 'auto'))

			expect(outcome.status).toBe('success')
			expect(outcome.merged).toHaveLength(1)
			expect(outcome.mergeFailures).toEqual([])
			expect(readFileSync(path.join(repo, 'output.txt'), 'utf8')).toBe('hello world\n')
		} finally {
			stub.server.stop(true)
		}
	})

	test('a run is refused when the deployment file does not price its models', async () => {
		const stub = createStubModel()
		const repo = createRepositoryWithBlueprint(stub.baseUrl)
		cleanupPath = repo

		try {
			// A price-less deployment: the run must fail loudly rather than
			// silently report a cost of zero.
			writeFileSync(
				path.join(repo, 'loom.deployment.json'),
				JSON.stringify({ providers: { stub: { baseUrl: stub.baseUrl } }, prices: {} }),
			)

			await expect(runTask(runOptions(repo, 'write output.txt', 'supervised'))).rejects.toThrow(
				/no price for: test-model/,
			)
		} finally {
			stub.server.stop(true)
		}
	})

	test('a model endpoint that cannot be reached fails the run without leaving a worktree', async () => {
		const repo = createRepositoryWithBlueprint('http://127.0.0.1:1/v1')
		cleanupPath = repo

		const outcome = await runTask(runOptions(repo, 'write output.txt', 'auto'))

		expect(outcome.status).toBe('error')
		expect(outcome.merged).toEqual([])

		// The worktree is still there for inspection, but the base is clean and
		// the manifest records what happened.
		const fs = createNodeFileSystem()
		const store = createRunStore({ fs, now: () => Date.now(), redact: noRedaction }, { repoPath: repo })
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

	test('a credential never reaches the manifest, the log, or the workspace', async () => {
		const stub = createStubModel()
		const repo = createRepositoryWithBlueprint(stub.baseUrl)
		cleanupPath = repo

		try {
			// The deployment file names the variable; only the environment holds the
			// value. A leaked deployment file therefore leaks nothing.
			writeFileSync(
				path.join(repo, 'loom.deployment.json'),
				JSON.stringify({
					providers: { stub: { baseUrl: stub.baseUrl, apiKeyEnv: 'STUB_KEY' } },
					prices: { 'test-model': { inputPer1M: 1000, cachedInputPer1M: 0, outputPer1M: 2000 } },
				}),
			)

			const outcome = await runTask({
				...runOptions(repo, 'write output.txt', 'supervised'),
				env: { STUB_KEY: 'super-secret-value' },
			})
			expect(outcome.status).toBe('success')

			// Nothing Loom wrote carries the secret — not the manifest, not the log.
			const runDirectory = path.join(repo, '.loom', 'runs', outcome.manifest.runId)
			const written = readdirSync(runDirectory)
			expect(written.length).toBeGreaterThan(0)
			for (const file of written) {
				expect(readFileSync(path.join(runDirectory, file), 'utf8')).not.toContain('super-secret-value')
			}
		} finally {
			stub.server.stop(true)
		}
	})

	test('a secret that reaches a tool result never reaches the run record', async () => {
		const SECRET = 'super-secret-value-0123456789'

		// The Blueprint only reads, and the workspace holds the secret — exactly the
		// leak a redactor exists for.
		const reader = Bun.serve({
			port: 0,
			async fetch(request) {
				const body: unknown = await request.json()
				const messages = isRecord(body) && Array.isArray(body['messages']) ? body['messages'] : []
				const read = messages.some((message) => isRecord(message) && message['role'] === 'tool')
				const toolCall = read
					? {
							id: 'c2',
							type: 'function',
							function: { name: 'finish', arguments: JSON.stringify({ status: 'success', summary: 'read it' }) },
						}
					: {
							id: 'c1',
							type: 'function',
							function: { name: 'read_file', arguments: JSON.stringify({ path: 'secrets.txt' }) },
						}
				return Response.json({
					choices: [{ message: { role: 'assistant', content: '', tool_calls: [toolCall] }, finish_reason: 'tool_calls' }],
					usage: { prompt_tokens: 10, completion_tokens: 5 },
				})
			},
		})

		const repo = createTemporaryRepository()
		cleanupPath = repo
		try {
			mkdirSync(path.join(repo, 'tools'), { recursive: true })
			mkdirSync(path.join(repo, 'prompts'), { recursive: true })
			for (const tool of ['read_file', 'finish']) {
				writeFileSync(
					path.join(repo, 'tools', `${tool}.json`),
					JSON.stringify({ name: tool, description: `${tool} tool`, parameters: { type: 'object' } }),
				)
			}
			writeFileSync(path.join(repo, 'prompts', 'orchestrator.md'), 'You are the orchestrator.\n')
			writeFileSync(
				path.join(repo, 'loom.json'),
				JSON.stringify({
					entryRole: 'orchestrator',
					roles: {
						orchestrator: { prompt: 'prompts/orchestrator.md', model: 'default', tools: ['read_file', 'finish'] },
					},
					tools: ['tools/read_file.json', 'tools/finish.json'],
					routing: { default: { provider: 'stub', model: 'test-model', temperature: 0 } },
					budgets: { maxAgentDepth: 2, maxConcurrentAgents: 2, toolTimeoutSeconds: 30 },
					permissions: { mode: 'workspace-write', requireApproval: [], egress: [] },
				}),
			)
			writeFileSync(
				path.join(repo, 'loom.deployment.json'),
				JSON.stringify({
					// The credential is *named* here and lives only in the environment.
					providers: { stub: { baseUrl: `http://localhost:${String(reader.port)}/v1`, apiKeyEnv: 'STUB_KEY' } },
					prices: { 'test-model': { inputPer1M: 0, cachedInputPer1M: 0, outputPer1M: 0 } },
				}),
			)
			writeFileSync(path.join(repo, 'secrets.txt'), `STUB_KEY=${SECRET}\n`)
			gitOutput(repo, ['add', '-A'])
			gitOutput(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-q', '-m', 'fixture'])

			const outcome = await runTask({
				...runOptions(repo, 'read secrets.txt', 'supervised'),
				env: { STUB_KEY: SECRET },
			})
			expect(outcome.status).toBe('success')

			// The read really did carry the secret into a tool result — otherwise this
			// test would pass for the wrong reason.
			const runDirectory = path.join(repo, '.loom', 'runs', outcome.manifest.runId)
			const written = readdirSync(runDirectory)
			expect(written.length).toBeGreaterThan(0)

			for (const file of written) {
				const text = readFileSync(path.join(runDirectory, file), 'utf8')
				expect(text).not.toContain(SECRET)
			}
			// The redactor ran, rather than the leak never having happened.
			expect(readFileSync(path.join(runDirectory, 'events.jsonl'), 'utf8')).toContain('[redacted]')
		} finally {
			reader.stop(true)
		}
	})

	test('a run killed mid-flight leaves a recoverable state, not a leaked worktree', async () => {
		// An endpoint that accepts the connection and never answers, so the run
		// blocks inside its first model call — after its worktree exists.
		const hanging = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) })
		const repo = createRepositoryWithBlueprint(`http://localhost:${String(hanging.port)}/v1`)
		cleanupPath = repo

		const cliPath = path.join(import.meta.dir, '..', 'cli.ts')
		const proc = Bun.spawn(['bun', cliPath, 'run', '--repo', repo, '--task', 'write output.txt'], {
			stdout: 'pipe',
			stderr: 'pipe',
		})

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
			const store = createRunStore({ fs, now: () => Date.now(), redact: noRedaction }, { repoPath: repo })
			const runIds = store.listRunIds()
			expect(runIds).toHaveLength(1)
			const runId = runIds[0] ?? ''

			// The record is truthful about a run that never finished.
			expect(store.readManifest(runId)?.status).toBe('running')
			expect(readFileSync(path.join(repo, '.loom', 'runs', runId, 'events.jsonl'), 'utf8')).toContain(
				'"type":"run_started"',
			)

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
