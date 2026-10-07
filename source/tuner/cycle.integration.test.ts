import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { isRecord } from '../guards.ts'
import { runTunerCommand } from '../run-tuner.ts'

/**
 * A full optimization cycle against the real Bench, real git, and a stub model.
 *
 * Opt-in — `bun run test:git` sets LOOM_GIT_TESTS. Both models are scripted, so
 * this proves the *loop* — branch, evaluate, gate, promote — and not that a
 * large model writes good hypotheses.
 */
const enabled = process.env['LOOM_GIT_TESTS'] === '1'
const suite = enabled ? describe : describe.skip

const SUITE_PATH = path.join(import.meta.dir, '..', '..', 'benchmarks')

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

/** The Blueprint the scripted big model proposes: the same document, plus the tool that does the work. */
function proposedBlueprint(): string {
	return JSON.stringify(
		{
			entryRole: 'orchestrator',
			roles: {
				orchestrator: { prompt: 'prompts/orchestrator.md', model: 'default', tools: ['write_file', 'finish'] },
			},
			tools: ['tools/write_file.json', 'tools/finish.json'],
			routing: { default: { provider: 'stub', model: 'test-model', temperature: 0 } },
			budgets: { maxAgentDepth: 2, maxConcurrentAgents: 2, toolTimeoutSeconds: 60 },
			permissions: { mode: 'workspace-write', requireApproval: [] },
		},
		null,
		'\t',
	)
}

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

/**
 * One endpoint serving both models. A request with no tools is the big model —
 * the loop calls it that way — and a request with tools is the engine.
 */
function createStubModels() {
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const body: unknown = await request.json()
			const messages = readMessages(body)
			const tools = isRecord(body) && Array.isArray(body['tools']) ? body['tools'] : []

			const reply = (content: string) =>
				Response.json({
					choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
					usage: { prompt_tokens: 10, completion_tokens: 5 },
				})

			if (tools.length === 0) {
				// The big model: propose the one change this fixture knows about.
				return reply(
					JSON.stringify([
						{
							id: 'h-001',
							motivation: 'every benchmark fails because the orchestrator cannot write files',
							mechanism: 'grant the orchestrator the write_file tool',
							predictedImpact: 'every benchmark should pass',
							changes: [{ path: 'loom.json', content: proposedBlueprint() }],
						},
					]),
				)
			}

			// The engine: write the fix for whichever benchmark is being run.
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
			if (fix === undefined) return Response.json(toolCall('finish', { status: 'error', summary: 'no fix known' }))
			return Response.json(toolCall('write_file', { path: fix.path, content: fix.content }))
		},
	})
	return { server, baseUrl: `http://localhost:${String(server.port)}/v1` }
}

/** A project whose Blueprint is deliberately missing the tool the work needs. */
function createProject(modelBaseUrl: string): string {
	const project = mkdtempSync(path.join(tmpdir(), 'loom-tune-'))
	mkdirSync(path.join(project, 'tools'), { recursive: true })
	mkdirSync(path.join(project, 'prompts'), { recursive: true })

	for (const tool of ['write_file', 'finish']) {
		writeFileSync(
			path.join(project, 'tools', `${tool}.json`),
			JSON.stringify({ name: tool, description: `${tool} tool`, parameters: { type: 'object' } }),
		)
	}
	writeFileSync(path.join(project, 'prompts', 'orchestrator.md'), 'You are the orchestrator.\n')
	writeFileSync(
		path.join(project, 'loom.json'),
		JSON.stringify({
			entryRole: 'orchestrator',
			// No write_file: every benchmark will fail until the Tuner notices.
			roles: { orchestrator: { prompt: 'prompts/orchestrator.md', model: 'default', tools: ['finish'] } },
			tools: ['tools/write_file.json', 'tools/finish.json'],
			routing: { default: { provider: 'stub', model: 'test-model', temperature: 0 } },
			budgets: { maxAgentDepth: 2, maxConcurrentAgents: 2, toolTimeoutSeconds: 60 },
			permissions: { mode: 'workspace-write', requireApproval: [] },
		}),
	)
	writeFileSync(
		path.join(project, 'loom.deployment.json'),
		JSON.stringify({
			providers: { stub: { baseUrl: modelBaseUrl } },
			prices: { 'test-model': { inputPer1M: 0, cachedInputPer1M: 0, outputPer1M: 0 } },
		}),
	)
	writeFileSync(
		path.join(project, 'tuner.json'),
		JSON.stringify({
			suitePath: SUITE_PATH,
			guildPath: '.',
			deploymentPath: 'loom.deployment.json',
			maxCycles: 1,
			maxCostUsd: 5,
			plateauLimit: 3,
			improvementMargin: 0.1,
			repetitions: 1,
			bigModel: { provider: 'stub', model: 'test-model' },
		}),
	)
	return project
}

suite('the tuner against the real bench', () => {
	let cleanup: string[] = []

	afterEach(() => {
		for (const directory of cleanup) rmSync(directory, { recursive: true, force: true })
		cleanup = []
	})

	test('a full cycle proposes, evaluates, gates, and promotes', async () => {
		const models = createStubModels()
		const project = createProject(models.baseUrl)
		cleanup.push(project)

		try {
			const report = await runTunerCommand({
				configPath: path.join(project, 'tuner.json'),
				repoPath: project,
				env: {},
				fetch: (url, init) => fetch(url, init),
			})

			expect(report.cycles).toHaveLength(1)
			const cycle = report.cycles[0]

			// The baseline is broken, so it scores nothing...
			expect(cycle?.baselineScore).toBe(0)
			// ...the hypothesis fixes it, so the candidate improves...
			expect(cycle?.branches[0]?.verdict).toBe('improved')
			// ...and it also improves on the half the loop never optimized against.
			expect(cycle?.heldOut?.verdict).toBe('improved')
			expect(cycle?.promoted).toBe(true)
		} finally {
			models.server.stop(true)
		}
	})

	test('promotion installs the candidate and archives what it replaced', async () => {
		const models = createStubModels()
		const project = createProject(models.baseUrl)
		cleanup.push(project)

		try {
			await runTunerCommand({
				configPath: path.join(project, 'tuner.json'),
				repoPath: project,
				env: {},
				fetch: (url, init) => fetch(url, init),
			})

			// The baseline now grants the tool the work needed.
			expect(readFileSync(path.join(project, 'loom.json'), 'utf8')).toContain('"write_file"')

			// And the baseline it replaced is archived, exactly as it was.
			const historyRoot = path.join(project, '.loom', 'tuner', 'history')
			const entries = readdirSync(historyRoot)
			expect(entries).toHaveLength(1)
			expect(readFileSync(path.join(historyRoot, entries[0] ?? '', 'loom.json'), 'utf8')).not.toContain('"write_file"')
		} finally {
			models.server.stop(true)
		}
	})

	test('the report is written and names the cycle it ran', async () => {
		const models = createStubModels()
		const project = createProject(models.baseUrl)
		cleanup.push(project)

		try {
			await runTunerCommand({
				configPath: path.join(project, 'tuner.json'),
				repoPath: project,
				env: {},
				fetch: (url, init) => fetch(url, init),
			})

			const reportsRoot = path.join(project, '.loom', 'tuner', 'reports')
			const entries = readdirSync(reportsRoot)
			expect(entries).toHaveLength(1)
			const directory = path.join(reportsRoot, entries[0] ?? '')

			const html = readFileSync(path.join(directory, 'index.html'), 'utf8')
			expect(html).toContain('promoted')
			expect(html).toContain('h-001')

			const summary: unknown = JSON.parse(readFileSync(path.join(directory, 'summary.json'), 'utf8'))
			if (!isRecord(summary)) throw new Error('the summary is not an object')
			expect(summary['cycles']).toHaveLength(1)
		} finally {
			models.server.stop(true)
		}
	})
})
