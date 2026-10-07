import { describe, expect, test } from 'bun:test'
import { ValidationError } from '../errors.ts'
import { loadBlueprint } from './load.ts'
import type { ReadTextFileResult } from '../fs.ts'

/** An in-memory filesystem keyed by absolute path. */
function memoryFiles(files: Readonly<Record<string, string>>) {
	return {
		readTextFile: (filePath: string): ReadTextFileResult => {
			const text = files[filePath]
			if (text === undefined) return { kind: 'unreadable', message: 'file does not exist' }
			return { kind: 'ok', text }
		},
	}
}

const BLUEPRINT_PATH = '/repo/loom.json'

const blueprintDocument = {
	entryRole: 'orchestrator',
	roles: {
		orchestrator: {
			prompt: 'prompts/orchestrator.md',
			model: 'reasoner',
			tools: ['agent', 'finish'],
			styleGuide: 'prompts/style.md',
		},
		coder: { prompt: 'prompts/coder.md', model: 'worker', tools: ['finish'] },
	},
	tools: ['tools/agent.json', 'tools/finish.json'],
	routing: {
		reasoner: { provider: 'anthropic', model: 'claude-sonnet-4', temperature: 0.2 },
		worker: { provider: 'local', model: 'qwen3-coder-30b', temperature: 0.1 },
	},
	budgets: { maxAgentDepth: 6, maxConcurrentAgents: 8, maxCostUsd: 5, maxTokensPerRun: 2000000, toolTimeoutSeconds: 60 },
	permissions: { mode: 'workspace-write', requireApproval: [] },
}

function completeFiles(): Record<string, string> {
	return {
		[BLUEPRINT_PATH]: JSON.stringify(blueprintDocument),
		'/repo/tools/agent.json': JSON.stringify({ name: 'agent', description: 'Delegate.', parameters: { type: 'object' } }),
		'/repo/tools/finish.json': JSON.stringify({ name: 'finish', description: 'End the role.', parameters: { type: 'object' } }),
		'/repo/prompts/orchestrator.md': '# Orchestrator\nCoordinate the work.',
		'/repo/prompts/coder.md': '# Coder\nImplement the step.',
		'/repo/prompts/style.md': '## Style\nUse tabs.',
	}
}

function captureValidationError(subject: () => unknown): ValidationError {
	try {
		subject()
	} catch (error) {
		if (error instanceof ValidationError) return error
		throw error
	}
	throw new Error('expected a ValidationError, but nothing was thrown')
}

describe('loadBlueprint', () => {
	test('loads a Blueprint, resolving manifests and prompts', () => {
		const blueprint = loadBlueprint(memoryFiles(completeFiles()), BLUEPRINT_PATH)

		expect(blueprint.entryRole).toBe('orchestrator')
		expect(blueprint.tools.map((tool) => tool.name)).toEqual(['agent', 'finish'])
		expect(blueprint.roles['coder']?.systemPrompt).toBe('# Coder\nImplement the step.')
		expect(blueprint.budgets.maxConcurrentAgents).toBe(8)
	})

	test('appends a role style guide to its system prompt, after one blank line', () => {
		const blueprint = loadBlueprint(memoryFiles(completeFiles()), BLUEPRINT_PATH)
		expect(blueprint.roles['orchestrator']?.systemPrompt).toBe('# Orchestrator\nCoordinate the work.\n\n## Style\nUse tabs.')
	})

	test('reports a missing manifest by path', () => {
		const files = completeFiles()
		delete files['/repo/tools/finish.json']
		const error = captureValidationError(() => loadBlueprint(memoryFiles(files), BLUEPRINT_PATH))
		expect(error.path).toBe('/repo/tools/finish.json')
		expect(error.message).toContain('does not exist')
	})

	test('reports a missing role prompt against the role that declared it', () => {
		const files = completeFiles()
		delete files['/repo/prompts/coder.md']
		const error = captureValidationError(() => loadBlueprint(memoryFiles(files), BLUEPRINT_PATH))
		expect(error.path).toBe(`${BLUEPRINT_PATH}.roles.coder.prompt`)
	})

	test('reports malformed JSON against the file that contains it', () => {
		const files = completeFiles()
		files['/repo/tools/agent.json'] = '{ not json'
		const error = captureValidationError(() => loadBlueprint(memoryFiles(files), BLUEPRINT_PATH))
		expect(error.path).toBe('/repo/tools/agent.json')
		expect(error.message).toContain('not valid JSON')
	})

	test('reports a cross-reference failure found while loading', () => {
		const files = completeFiles()
		files[BLUEPRINT_PATH] = JSON.stringify({
			...blueprintDocument,
			roles: { orchestrator: { prompt: 'prompts/orchestrator.md', model: 'reasoner', tools: ['undeclared'] } },
		})
		const error = captureValidationError(() => loadBlueprint(memoryFiles(files), BLUEPRINT_PATH))
		expect(error.path).toBe(`${BLUEPRINT_PATH}.roles.orchestrator.tools[0]`)
	})
})
