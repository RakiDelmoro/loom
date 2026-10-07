import { describe, expect, test } from 'bun:test'
import { parseBlueprintFile } from '../blueprint/parse.ts'
import { createMemoryFileSystem } from '../test-support/memory-fs.ts'
import { BLUEPRINT_FILE, blueprintFiles, createBranchManager, readBlueprintFiles } from './branch.ts'
import type { BlueprintChange } from './types.ts'

const WORKSPACE = '/repo/.loom/tuner'

function guildFiles(): Record<string, string> {
	return {
		'/repo/loom.json': JSON.stringify({
			entryRole: 'orchestrator',
			roles: {
				orchestrator: { prompt: 'prompts/orchestrator.md', model: 'default', tools: ['finish'] },
				coder: { prompt: 'prompts/coder.md', model: 'default', tools: ['finish'], styleGuide: 'prompts/style.md' },
			},
			tools: ['tools/finish.json'],
			routing: { default: { provider: 'test', model: 'test-model', temperature: 0 } },
			budgets: { maxAgentDepth: 2, maxConcurrentAgents: 2, toolTimeoutSeconds: 30 },
			permissions: { mode: 'workspace-write' },
		}),
		'/repo/prompts/orchestrator.md': 'You are the orchestrator.\n',
		'/repo/prompts/coder.md': 'You are the coder.\n',
		'/repo/prompts/style.md': 'Use tabs.\n',
		'/repo/tools/finish.json': JSON.stringify({ name: 'finish', description: 'End the role.', parameters: { type: 'object' } }),
	}
}

function createHarness() {
	const memory = createMemoryFileSystem(guildFiles(), ['/repo', '/repo/prompts', '/repo/tools'])
	const branch = createBranchManager({ fs: memory.fs, removeDirectory: () => {} }, { workspacePath: WORKSPACE })
	return { memory, branch }
}

describe('blueprintFiles', () => {
	test('covers the document, every prompt, every style guide, and every tool manifest', () => {
		const parsed = parseBlueprintFile(JSON.parse(guildFiles()['/repo/loom.json'] ?? '{}'))
		expect(blueprintFiles(parsed)).toEqual([
			BLUEPRINT_FILE,
			'prompts/coder.md',
			'prompts/orchestrator.md',
			'prompts/style.md',
			'tools/finish.json',
		])
	})
})

describe('readBlueprintFiles', () => {
	test('reads the file set out of a guild directory', () => {
		const memory = createMemoryFileSystem(guildFiles(), [])
		expect(readBlueprintFiles(memory.fs, '/repo')).toHaveLength(5)
	})

	test('reports nothing for a directory with no Blueprint', () => {
		expect(readBlueprintFiles(createMemoryFileSystem().fs, '/repo')).toEqual([])
	})

	test('reports nothing for a guild that will not parse', () => {
		const memory = createMemoryFileSystem({ '/repo/loom.json': '{ not json' }, [])
		expect(readBlueprintFiles(memory.fs, '/repo')).toEqual([])
	})
})

describe('create', () => {
	test('copies exactly the referenced files and applies the changes', () => {
		const { memory, branch } = createHarness()
		const result = branch.create('h-1', [{ path: 'prompts/coder.md', content: 'Always iterate.\n' }], '/repo')

		expect(result.kind).toBe('ok')
		// The referenced files came along...
		expect(memory.files.get(`${WORKSPACE}/branches/h-1/guild/prompts/style.md`)).toBe('Use tabs.\n')
		expect(memory.files.get(`${WORKSPACE}/branches/h-1/guild/tools/finish.json`)).toBeTruthy()
		// ...the change was applied...
		expect(memory.files.get(`${WORKSPACE}/branches/h-1/guild/prompts/coder.md`)).toBe('Always iterate.\n')
		// ...and nothing else was swept up.
		expect(memory.files.has(`${WORKSPACE}/branches/h-1/guild/source/cli.ts`)).toBe(false)
	})

	test('the branch is validated end to end, so a run could use it', () => {
		const { branch } = createHarness()
		const result = branch.create('h-1', [{ path: 'prompts/coder.md', content: 'Always iterate.\n' }], '/repo')
		if (result.kind !== 'ok') throw new Error(result.message)
		// The style guide was appended to the prompt at load time, exactly as a run would.
		expect(result.value.roles['coder']?.systemPrompt).toBe('Always iterate.\n\nUse tabs.\n')
	})

	test('reports a candidate whose Blueprint does not load, rather than throwing', () => {
		const { branch } = createHarness()
		const result = branch.create('h-bad', [{ path: BLUEPRINT_FILE, content: '{ not json' }], '/repo')
		expect(result.kind).toBe('failed')
		if (result.kind === 'failed') expect(result.message).toContain('not valid JSON')
	})

	test('reports a candidate whose Blueprint is structurally invalid', () => {
		const { branch } = createHarness()
		const result = branch.create('h-bad', [{ path: BLUEPRINT_FILE, content: JSON.stringify({ entryRole: 'ghost' }) }], '/repo')
		expect(result.kind).toBe('failed')
	})

	test('refuses an edit outside the guild directory', () => {
		const { branch } = createHarness()
		const escape: BlueprintChange = { path: '../outside.md', content: 'x' }
		expect(branch.create('h-escape', [escape], '/repo').kind).toBe('failed')
	})

	test('a change to a path the Blueprint does not reference is refused, not silently ignored', () => {
		// The bug this defends against: the proposer guessed the Blueprint's
		// filename — 'blueprint.json' for 'loom.json' — so every candidate was the
		// baseline plus a file nothing read. Each scored identically and looked like
		// a hypothesis that did not help. Three cycles ran that way in silence.
		const { branch } = createHarness()
		const result = branch.create('h-noop', [{ path: 'blueprint.json', content: '{}' }], '/repo')

		expect(result.kind).toBe('failed')
		if (result.kind === 'failed') {
			expect(result.message).toContain('not referenced by the Blueprint')
			// The message has to say what the files are, or the next guess is as bad.
			expect(result.message).toContain(BLUEPRINT_FILE)
			expect(result.message).toContain('prompts/coder.md')
		}
	})

	test('a change may add a file the baseline did not have, when the Blueprint references it', () => {
		const { memory, branch } = createHarness()
		// A test fixture, so the shape is asserted once here rather than parsed.
		const blueprint = JSON.parse(guildFiles()['/repo/loom.json'] ?? '{}') as {
			roles: Record<string, { prompt: string; model: string; tools: string[] }>
		}
		const orchestrator = blueprint.roles['orchestrator']
		if (orchestrator === undefined) throw new Error('the fixture has no orchestrator')
		orchestrator.prompt = 'prompts/extra.md'

		const result = branch.create(
			'h-new',
			[
				{ path: BLUEPRINT_FILE, content: JSON.stringify(blueprint) },
				{ path: 'prompts/extra.md', content: 'You are the orchestrator, briefly.\n' },
			],
			'/repo',
		)

		expect(result.kind).toBe('ok')
		expect(memory.files.get(`${WORKSPACE}/branches/h-new/guild/prompts/extra.md`)).toBe('You are the orchestrator, briefly.\n')
	})
})

describe('listBranches', () => {
	test('lists branches once they exist', () => {
		const { branch } = createHarness()
		expect(branch.listBranches()).toEqual([])
		branch.create('h-2', [{ path: 'prompts/coder.md', content: 'b\n' }], '/repo')
		branch.create('h-1', [{ path: 'prompts/coder.md', content: 'a\n' }], '/repo')
		expect(branch.listBranches()).toEqual(['h-1', 'h-2'])
	})
})
