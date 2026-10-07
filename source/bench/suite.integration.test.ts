import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { isRecord } from '../guards.ts'
import { runBench } from '../run-bench.ts'

/**
 * The Bench against real git, a real suite, and a stub model.
 *
 * Opt-in — `bun run test:git` sets LOOM_GIT_TESTS. The model is scripted, so
 * this proves the *harness* — isolation, validation, scoring, the split — and
 * not that a model can code.
 */
const enabled = process.env['LOOM_GIT_TESTS'] === '1'
const suite = enabled ? describe : describe.skip

const SUITE_PATH = path.join(import.meta.dir, '..', '..', 'benchmarks')

/** The fix for each benchmark, keyed by a phrase unique to its task text. */
const FIXES: ReadonlyArray<{ readonly match: string; readonly path: string; readonly content: string }> = [
	{
		match: 'range(3) returns one value too many',
		path: 'src/range.ts',
		content: `/** The integers from 0 up to (but not including) \`count\`. */
export function range(count: number): number[] {
	const values: number[] = []
	for (let index = 0; index < count; index += 1) values.push(index)
	return values
}
`,
	},
	{
		match: "imports './helper.ts'",
		path: 'src/format.ts',
		content: `import { shout } from './helpers.ts'

export function announce(message: string): string {
	return shout(message)
}
`,
	},
	{
		match: 'returns its argument unchanged',
		path: 'src/clamp.ts',
		content: `/** Restricts \`value\` to the inclusive range [min, max]. */
export function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max)
}
`,
	},
	{
		match: 'greet requires two',
		path: 'src/greet.ts',
		content: `export function greet(name: string, greeting = 'Hello'): string {
	return \`\${greeting}, \${name}!\`
}
`,
	},
	{
		match: 'lower-case, dash-separated',
		path: 'src/slug.ts',
		content: `/** A lower-case, dash-separated form of \`title\`. */
export function slug(title: string): string {
	return title.trim().replace(/\\s+/g, '-').toLowerCase()
}
`,
	},
	{
		match: 'cannot import `total`',
		path: 'src/stats.ts',
		content: `export function total(values: number[]): number {
	return values.reduce((sum, value) => sum + value, 0)
}
`,
	},
]

function readMessages(body: unknown): Array<{ readonly role: string; readonly content: string }> {
	if (!isRecord(body) || !Array.isArray(body['messages'])) return []
	const messages: Array<{ role: string; content: string }> = []
	for (const entry of body['messages']) {
		if (!isRecord(entry)) continue
		const role = entry['role']
		if (typeof role !== 'string') continue
		const content = entry['content']
		messages.push({ role, content: typeof content === 'string' ? content : '' })
	}
	return messages
}

/** A model that reads the task and writes the fix it knows for that benchmark. */
function createSolver() {
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const messages = readMessages(await request.json())
			const hasToolResult = messages.some((message) => message.role === 'tool')
			const task = messages.find((message) => message.role === 'user')?.content ?? ''

			const toolCall = (name: string, args: unknown) => ({
				choices: [
					{
						message: {
							role: 'assistant',
							content: '',
							tool_calls: [{ id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } }],
						},
						finish_reason: 'tool_calls',
					},
				],
				usage: { prompt_tokens: 10, completion_tokens: 5 },
			})

			if (hasToolResult) return Response.json(toolCall('finish', { status: 'success', summary: 'applied the fix' }))

			const fix = FIXES.find((entry) => task.includes(entry.match))
			if (fix === undefined) {
				return Response.json(toolCall('finish', { status: 'error', summary: 'no fix known for this task' }))
			}
			return Response.json(toolCall('write_file', { path: fix.path, content: fix.content }))
		},
	})
	return { server, baseUrl: `http://localhost:${String(server.port)}/v1` }
}

/** A Blueprint and deployment in a temp directory — the configuration under test. */
function createConfig(modelBaseUrl: string, options: { readonly grantWriteTool: boolean } = { grantWriteTool: true }): string {
	const directory = mkdtempSync(path.join(tmpdir(), 'loom-bench-config-'))
	mkdirSync(path.join(directory, 'tools'), { recursive: true })
	mkdirSync(path.join(directory, 'prompts'), { recursive: true })
	for (const tool of ['write_file', 'finish']) {
		writeFileSync(
			path.join(directory, 'tools', `${tool}.json`),
			JSON.stringify({ name: tool, description: `${tool} tool`, parameters: { type: 'object' } }),
		)
	}
	writeFileSync(path.join(directory, 'prompts', 'orchestrator.md'), 'You are the orchestrator.\n')
	writeFileSync(
		path.join(directory, 'loom.json'),
		JSON.stringify({
			entryRole: 'orchestrator',
			roles: {
				orchestrator: {
					prompt: 'prompts/orchestrator.md',
					model: 'default',
					tools: options.grantWriteTool ? ['write_file', 'finish'] : ['finish'],
				},
			},
			tools: ['tools/write_file.json', 'tools/finish.json'],
			routing: { default: { provider: 'stub', model: 'test-model', temperature: 0 } },
			budgets: { maxAgentDepth: 2, maxConcurrentAgents: 2, toolTimeoutSeconds: 60 },
			permissions: { mode: 'workspace-write', requireApproval: [] },
		}),
	)
	writeFileSync(
		path.join(directory, 'loom.deployment.json'),
		JSON.stringify({
			providers: { stub: { baseUrl: modelBaseUrl } },
			prices: { 'test-model': { inputPer1M: 0, cachedInputPer1M: 0, outputPer1M: 0 } },
		}),
	)
	return directory
}

suite('the bench against real git and a stub model', () => {
	let cleanup: string[] = []

	afterEach(() => {
		for (const directory of cleanup) rmSync(directory, { recursive: true, force: true })
		cleanup = []
	})

	test('scores the optimization split end to end, and never runs the held-out half', async () => {
		const solver = createSolver()
		const config = createConfig(solver.baseUrl)
		cleanup.push(config)

		try {
			const result = await runBench({
				suitePath: SUITE_PATH,
				split: 'optimization',
				blueprintPath: path.join(config, 'loom.json'),
				deploymentPath: path.join(config, 'loom.deployment.json'),
				repetitions: 1,
				resultsDirectory: path.join(config, 'results'),
				env: {},
				fetch: (url, init) => fetch(url, init),
			})

			// The suite's four optimization benchmarks all pass with a working Blueprint.
			expect(result.benchmarks).toHaveLength(4)
			expect(result.score).toBe(1)

			// 4 of 4 is not certainty, and the interval says so.
			expect(result.interval.low).toBeLessThan(0.9)
			expect(result.interval.high).toBe(1)

			// The structural guarantee: the held-out half is not run at all.
			const serialized = JSON.stringify(result)
			expect(serialized).not.toContain('fix_string_case')
			expect(serialized).not.toContain('add_export')

			// The result is persisted, for regression tracking.
			expect(readdirSync(path.join(config, 'results'))).toHaveLength(1)
		} finally {
			solver.server.stop(true)
		}
	})

	test('the held-out split is runnable on its own', async () => {
		const solver = createSolver()
		const config = createConfig(solver.baseUrl)
		cleanup.push(config)

		try {
			const result = await runBench({
				suitePath: SUITE_PATH,
				split: 'held-out',
				blueprintPath: path.join(config, 'loom.json'),
				deploymentPath: path.join(config, 'loom.deployment.json'),
				repetitions: 1,
				resultsDirectory: null,
				env: {},
				fetch: (url, init) => fetch(url, init),
			})

			expect(result.benchmarks.map((summary) => summary.benchmark)).toEqual(['fix_string_case', 'add_export'])
			expect(result.score).toBe(1)
		} finally {
			solver.server.stop(true)
		}
	})

	test('a degraded Blueprint scores measurably lower, with non-overlapping intervals', async () => {
		const solver = createSolver()
		const working = createConfig(solver.baseUrl)
		// The same Blueprint, minus the tool that does the work.
		const degraded = createConfig(solver.baseUrl, { grantWriteTool: false })
		cleanup.push(working, degraded)

		try {
			const options = {
				suitePath: SUITE_PATH,
				split: 'optimization' as const,
				repetitions: 1,
				resultsDirectory: null,
				env: {},
				fetch: (url: string, init: RequestInit) => fetch(url, init),
			}

			const baseline = await runBench({ ...options, blueprintPath: path.join(working, 'loom.json'), deploymentPath: path.join(working, 'loom.deployment.json') })
			const broken = await runBench({ ...options, blueprintPath: path.join(degraded, 'loom.json'), deploymentPath: path.join(degraded, 'loom.deployment.json') })

			expect(baseline.score).toBe(1)
			expect(broken.score).toBe(0)
			// The gap is wider than the noise: this is the check that makes the
			// scoreboard trustworthy.
			expect(broken.interval.high).toBeLessThan(baseline.interval.low)
		} finally {
			solver.server.stop(true)
		}
	})

	test('the same Blueprint scores the same twice', async () => {
		const solver = createSolver()
		const config = createConfig(solver.baseUrl)
		cleanup.push(config)

		try {
			const options = {
				suitePath: SUITE_PATH,
				split: 'held-out' as const,
				blueprintPath: path.join(config, 'loom.json'),
				deploymentPath: path.join(config, 'loom.deployment.json'),
				repetitions: 2,
				resultsDirectory: null,
				env: {},
				fetch: (url: string, init: RequestInit) => fetch(url, init),
			}

			const first = await runBench(options)
			const second = await runBench(options)

			expect(second.score).toBe(first.score)
			expect(second.benchmarks).toEqual(first.benchmarks)
			expect(second.outcomes.map((outcome) => outcome.status)).toEqual(first.outcomes.map((outcome) => outcome.status))
		} finally {
			solver.server.stop(true)
		}
	})
})
