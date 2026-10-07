/**
 * A self-contained demo: a throwaway repository, a stub model, two finished runs,
 * and the UI server on top.
 *
 * This is the onboarding path. Seeing Loom work otherwise needs a repository, a
 * Blueprint, a deployment file, and a credentialed model endpoint; this needs
 * `bun source/demo.ts`. It touches nothing outside its own temporary directory.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { createNodeFileSystem } from './node-fs.ts'
import { generateRunId, runTask } from './run-task.ts'
import { createRunControl } from './runs/control.ts'
import { serve } from './serve.ts'

const AGENT_MANIFEST = {
	name: 'agent',
	description: 'Delegate a task to another role. The child runs to completion and returns its result card.',
	parameters: {
		type: 'object',
		properties: {
			role: { type: 'string', description: 'The role to delegate to.' },
			task: { type: 'string', description: 'A self-contained task for the child.' },
		},
		required: ['role', 'task'],
		additionalProperties: false,
	},
}

const FINISH_MANIFEST = {
	name: 'finish',
	description: 'End the role.',
	parameters: {
		type: 'object',
		properties: {
			status: { type: 'string', enum: ['success', 'error', 'needs_clarification'] },
			summary: { type: 'string' },
		},
		required: ['status', 'summary'],
		additionalProperties: false,
	},
}

const WRITE_MANIFEST = {
	name: 'write_file',
	description: 'Write a file.',
	parameters: {
		type: 'object',
		properties: { path: { type: 'string' }, content: { type: 'string' } },
		required: ['path', 'content'],
		additionalProperties: false,
	},
}

interface StubMessage {
	readonly role: string
	readonly content: string
}

/**
 * A stub OpenAI-compatible endpoint that makes the demo worth looking at: one
 * task delegates to a second role, so the trace shows real nesting, and the other
 * writes a file directly.
 *
 * The behaviour is derived from the conversation rather than from call order, so
 * it does not matter how the engine interleaves concurrent agents.
 */
function createStubModel(): { readonly server: ReturnType<typeof Bun.serve>; readonly baseUrl: string } {
	const server = Bun.serve({
		port: 0,
		fetch: async (request) => {
			const body = (await request.json()) as { messages?: readonly StubMessage[] } | null
			const messages = body?.messages ?? []
			const system = messages.find((message) => message.role === 'system')?.content ?? ''
			const user = messages.find((message) => message.role === 'user')?.content ?? ''
			const replies = messages.filter((message) => message.role === 'assistant').length
			const sawToolResult = messages.some((message) => message.role === 'tool')

			// A model is slow enough here that the run is visible while it is going.
			await new Promise((resolve) => setTimeout(resolve, 250))

			const delegating = replies === 0 && system.includes('orchestrator') && /delegate/i.test(user)
			const role = system.includes('worker') ? 'worker' : 'orchestrator'

			let toolCall: { id: string; type: string; function: { name: string; arguments: string } }
			if (delegating) {
				toolCall = {
					id: 'r0',
					type: 'function',
					function: {
						name: 'agent',
						arguments: JSON.stringify({ role: 'worker', task: 'write the summary file' }),
					},
				}
			} else if (!sawToolResult) {
				toolCall = {
					id: 'r1',
					type: 'function',
					function: {
						name: 'write_file',
						arguments: JSON.stringify({
							path: role === 'worker' ? 'summary.md' : 'notes.md',
							content: `# ${role === 'worker' ? 'Summary' : 'Notes'}\n\nWritten by the ${role}.\n`,
						}),
					},
				}
			} else {
				toolCall = {
					id: 'r2',
					type: 'function',
					function: {
						name: 'finish',
						arguments: JSON.stringify({ status: 'success', summary: `${role} wrote its file` }),
					},
				}
			}

			return Response.json({
				choices: [{ message: { role: 'assistant', content: '', tool_calls: [toolCall] }, finish_reason: 'tool_calls' }],
				usage: { prompt_tokens: 900, completion_tokens: 220 },
			})
		},
	})
	const origin = `http://localhost:${String(server.port)}/v1`
	return { server, baseUrl: origin }
}

function createDemoRepository(): string {
	const repo = mkdtempSync(path.join(tmpdir(), 'loom-demo-'))
	mkdirSync(path.join(repo, 'tools'), { recursive: true })
	mkdirSync(path.join(repo, 'prompts'), { recursive: true })

	writeFileSync(path.join(repo, 'tools', 'agent.json'), JSON.stringify(AGENT_MANIFEST, null, '\t'))
	writeFileSync(path.join(repo, 'tools', 'finish.json'), JSON.stringify(FINISH_MANIFEST, null, '\t'))
	writeFileSync(path.join(repo, 'tools', 'write_file.json'), JSON.stringify(WRITE_MANIFEST, null, '\t'))
	writeFileSync(path.join(repo, 'prompts', 'orchestrator.md'), 'You are the orchestrator.\n')
	writeFileSync(path.join(repo, 'prompts', 'worker.md'), 'You are the worker.\n')

	const git = (args: string[]): void => {
		const result = Bun.spawnSync(['git', '-C', repo, ...args])
		if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`)
	}
	git(['init', '-q', '-b', 'main'])
	git(['config', 'user.name', 'Loom demo'])
	git(['config', 'user.email', 'demo@localhost'])
	return repo
}

const args = process.argv.slice(2)
const portIndex = args.indexOf('--port')
const port = portIndex === -1 ? 8787 : Number.parseInt(args[portIndex + 1] ?? '8787', 10)

const repo = createDemoRepository()
const stub = createStubModel()
const fs = createNodeFileSystem()

writeFileSync(
	path.join(repo, 'loom.json'),
	JSON.stringify(
		{
			entryRole: 'orchestrator',
			roles: {
				orchestrator: { prompt: 'prompts/orchestrator.md', model: 'default', tools: ['agent', 'write_file', 'finish'] },
				worker: { prompt: 'prompts/worker.md', model: 'default', tools: ['write_file', 'finish'] },
			},
			tools: ['tools/agent.json', 'tools/finish.json', 'tools/write_file.json'],
			routing: { default: { provider: 'stub', model: 'demo-model', temperature: 0 } },
			budgets: { maxAgentDepth: 2, maxConcurrentAgents: 3, toolTimeoutSeconds: 30 },
			permissions: { mode: 'workspace-write', requireApproval: [] },
		},
		null,
		'\t',
	),
)
writeFileSync(
	path.join(repo, 'loom.deployment.json'),
	JSON.stringify(
		{
			providers: { stub: { baseUrl: stub.baseUrl } },
			// Priced so the cost columns show something without being alarming.
			prices: { 'demo-model': { inputPer1M: 0.4, cachedInputPer1M: 0.1, outputPer1M: 1.2 } },
		},
		null,
		'\t',
	),
)

const git = (gitArgs: string[]): void => {
	Bun.spawnSync(['git', '-C', repo, ...gitArgs])
}
git(['add', '-A'])
git(['-c', 'user.name=Loom demo', '-c', 'user.email=demo@localhost', 'commit', '-q', '-m', 'blueprint'])

const runOptions = {
	repoPath: repo,
	blueprintPath: path.join(repo, 'loom.json'),
	deploymentPath: path.join(repo, 'loom.deployment.json'),
	autonomy: 'supervised' as const,
	modelOverrides: {},
	approvals: [],
	env: {},
	fetch: (url: string, init?: RequestInit) => fetch(url, init),
}

for (const task of ['write the notes file', 'delegate the summary to the worker']) {
	const outcome = await runTask({
		...runOptions,
		runId: generateRunId(new Date()),
		control: createRunControl(),
		task,
	})
	process.stdout.write(`  ${outcome.status}  ${task}\n`)
}

const handle = await serve({
	repoPath: repo,
	blueprintPath: path.join(repo, 'loom.json'),
	deploymentPath: path.join(repo, 'loom.deployment.json'),
	hostname: '127.0.0.1',
	port,
	token: process.env['LOOM_TOKEN'] ?? null,
	autonomy: 'auto',
	fs,
	env: {},
	fetch: (url, init) => fetch(url, init),
	write: () => {},
})

process.stdout.write(
	[
		'',
		`  Loom demo — repository ${repo}`,
		`  open ${handle.url}`,
		'',
		'  Two runs are already recorded. Start another from the box at the bottom;',
		'  while it is going, use pause, resume, and the steer box.',
		'',
	].join('\n'),
)

await new Promise(() => {})
