import { describe, expect, test } from 'bun:test'
import { createMemoryFileSystem } from '../test-support/memory-fs.ts'
import { createPromoter } from './promote.ts'

const WORKSPACE = '/repo/.loom/tuner'

function files(): Record<string, string> {
	return {
		'/repo/loom.json': JSON.stringify({
			entryRole: 'orchestrator',
			roles: { orchestrator: { prompt: 'prompts/orchestrator.md', model: 'default', tools: ['finish'] } },
			tools: ['tools/finish.json'],
			routing: { default: { provider: 'test', model: 'test-model', temperature: 0 } },
			budgets: { maxAgentDepth: 2, maxConcurrentAgents: 2, toolTimeoutSeconds: 30 },
			permissions: { mode: 'workspace-write' },
		}),
		'/repo/prompts/orchestrator.md': 'the baseline prompt\n',
		'/repo/tools/finish.json': JSON.stringify({ name: 'finish', description: 'End.', parameters: { type: 'object' } }),
		// A branch waiting to be promoted.
		[`${WORKSPACE}/branches/h-1/guild/loom.json`]: JSON.stringify({
			entryRole: 'orchestrator',
			roles: { orchestrator: { prompt: 'prompts/orchestrator.md', model: 'default', tools: ['finish'] } },
			tools: ['tools/finish.json'],
			routing: { default: { provider: 'test', model: 'test-model', temperature: 0 } },
			budgets: { maxAgentDepth: 2, maxConcurrentAgents: 2, toolTimeoutSeconds: 30 },
			permissions: { mode: 'workspace-write' },
		}),
		[`${WORKSPACE}/branches/h-1/guild/prompts/orchestrator.md`]: 'the candidate prompt\n',
	}
}

function createHarness() {
	const memory = createMemoryFileSystem(files(), [
		WORKSPACE,
		`${WORKSPACE}/branches`,
		`${WORKSPACE}/branches/h-1`,
		`${WORKSPACE}/branches/h-1/guild`,
	])
	const promoter = createPromoter({ fs: memory.fs, now: () => 1_700_000_000_000 }, { guildPath: '/repo', workspacePath: WORKSPACE })
	return { memory, promoter }
}

describe('promote', () => {
	test('installs the branch and archives the outgoing baseline', () => {
		const { memory, promoter } = createHarness()
		const result = promoter.promote('h-1')

		expect(result).toEqual({ kind: 'ok', value: '2023-11-14T22-13-20-000Z' })
		expect(memory.files.get('/repo/prompts/orchestrator.md')).toBe('the candidate prompt\n')
		expect(memory.files.get(`${WORKSPACE}/history/2023-11-14T22-13-20-000Z/prompts/orchestrator.md`)).toBe('the baseline prompt\n')
	})

	test('refuses a branch that does not exist', () => {
		const { promoter } = createHarness()
		expect(promoter.promote('ghost').kind).toBe('failed')
	})

	test('leaves the baseline alone when it refuses', () => {
		const { memory, promoter } = createHarness()
		promoter.promote('ghost')
		expect(memory.files.get('/repo/prompts/orchestrator.md')).toBe('the baseline prompt\n')
	})
})

describe('history', () => {
	test('starts empty and lists entries newest first', () => {
		const { promoter } = createHarness()
		expect(promoter.history()).toEqual([])
		promoter.promote('h-1')
		expect(promoter.history()).toEqual(['2023-11-14T22-13-20-000Z'])
	})
})

describe('restore', () => {
	test('puts an archived baseline back', () => {
		const { memory, promoter } = createHarness()
		const promoted = promoter.promote('h-1')
		if (promoted.kind !== 'ok') throw new Error(promoted.message)
		expect(memory.files.get('/repo/prompts/orchestrator.md')).toBe('the candidate prompt\n')

		expect(promoter.restore(promoted.value)).toEqual({ kind: 'ok', value: null })
		expect(memory.files.get('/repo/prompts/orchestrator.md')).toBe('the baseline prompt\n')
	})

	test('refuses an entry that does not exist', () => {
		expect(createHarness().promoter.restore('ghost').kind).toBe('failed')
	})
})
