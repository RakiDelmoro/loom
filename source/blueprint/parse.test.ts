import { describe, expect, test } from 'bun:test'
import { ValidationError } from '../errors.ts'
import { parseBlueprintFile, parseToolManifest, validateBlueprint } from './parse.ts'
import type { ToolManifest } from './types.ts'

/** Runs `subject` and returns the ValidationError it must throw. */
function captureValidationError(subject: () => unknown): ValidationError {
	try {
		subject()
	} catch (error) {
		if (error instanceof ValidationError) return error
		throw error
	}
	throw new Error('expected a ValidationError, but nothing was thrown')
}

const validDocument = {
	entryRole: 'orchestrator',
	roles: {
		orchestrator: { prompt: 'prompts/orchestrator.md', model: 'reasoner', tools: ['agent', 'finish'] },
		coder: { prompt: 'prompts/coder.md', model: 'worker', tools: ['finish'], isolation: 'shared', parallel: { maxChildren: 2 } },
	},
	tools: ['tools/agent.json', 'tools/finish.json'],
	routing: {
		reasoner: { provider: 'anthropic', model: 'claude-sonnet-4', temperature: 0.2 },
		worker: { provider: 'local', model: 'qwen3-coder-30b', temperature: 0.1 },
	},
	budgets: { maxAgentDepth: 6, maxConcurrentAgents: 8, toolTimeoutSeconds: 60 },
	permissions: { mode: 'workspace-write', requireApproval: [] },
}

const manifests: ToolManifest[] = [
	{ name: 'agent', description: 'Delegate.', parameters: {} },
	{ name: 'finish', description: 'End the role.', parameters: {} },
]

describe('parseBlueprintFile', () => {
	test('parses a valid document and applies the documented defaults', () => {
		const file = parseBlueprintFile(validDocument)

		expect(file.entryRole).toBe('orchestrator')
		expect(Object.keys(file.roles)).toEqual(['orchestrator', 'coder'])
		expect(file.toolPaths).toEqual(['tools/agent.json', 'tools/finish.json'])
		expect(file.routing['worker']?.model).toBe('qwen3-coder-30b')
		expect(file.permissions.requireApproval).toEqual([])

		// Defaults: a role with no `isolation` gets a worktree, and no `parallel` means one child.
		expect(file.roles['orchestrator']?.isolation).toBe('worktree')
		expect(file.roles['orchestrator']?.maxChildren).toBe(1)
		expect(file.roles['coder']?.isolation).toBe('shared')
		expect(file.roles['coder']?.maxChildren).toBe(2)
	})

	test('rejects an unknown key and names its path', () => {
		const broken = { ...validDocument, entryRoley: 'orchestrator' }
		expect(captureValidationError(() => parseBlueprintFile(broken)).path).toBe('blueprint.entryRoley')
	})

	test('rejects an unknown key nested inside a role', () => {
		const broken = {
			...validDocument,
			roles: { orchestrator: { prompt: 'p.md', model: 'reasoner', tools: [], maxChild: 3 } },
		}
		expect(captureValidationError(() => parseBlueprintFile(broken)).path).toBe('blueprint.roles.orchestrator.maxChild')
	})

	test('rejects a missing required field', () => {
		const { budgets: _budgets, ...broken } = validDocument
		expect(captureValidationError(() => parseBlueprintFile(broken)).path).toBe('blueprint.budgets')
	})

	test('rejects a wrong type and names the element', () => {
		const broken = { ...validDocument, roles: { orchestrator: { prompt: 'p.md', model: 'reasoner', tools: ['agent', 7] } } }
		expect(captureValidationError(() => parseBlueprintFile(broken)).path).toBe('blueprint.roles.orchestrator.tools[1]')
	})

	test('rejects a permission mode that is not one of the three', () => {
		const broken = { ...validDocument, permissions: { mode: 'yolo' } }
		expect(captureValidationError(() => parseBlueprintFile(broken)).path).toBe('blueprint.permissions.mode')
	})

	test('rejects an empty roles map', () => {
		const broken = { ...validDocument, roles: {} }
		expect(captureValidationError(() => parseBlueprintFile(broken)).path).toBe('blueprint.roles')
	})

	test('rejects a non-positive budget', () => {
		const broken = { ...validDocument, budgets: { ...validDocument.budgets, maxAgentDepth: 0 } }
		expect(captureValidationError(() => parseBlueprintFile(broken)).path).toBe('blueprint.budgets.maxAgentDepth')
	})

	test('parses advisory alert thresholds', () => {
		const file = parseBlueprintFile({ ...validDocument, alerts: { costUsd: 5, tokens: 1000 } })
		expect(file.alerts).toEqual({ costUsd: 5, tokens: 1000 })
	})

	test('defaults alerts to empty, so a Blueprint without them still loads', () => {
		expect(parseBlueprintFile(validDocument).alerts).toEqual({})
	})

	test('rejects a negative alert threshold', () => {
		const broken = { ...validDocument, alerts: { costUsd: -1 } }
		expect(captureValidationError(() => parseBlueprintFile(broken)).path).toBe('blueprint.alerts.costUsd')
	})

	test('rejects a budget field that was retired, rather than silently ignoring it', () => {
		const broken = { ...validDocument, budgets: { ...validDocument.budgets, maxCostUsd: 5 } }
		expect(captureValidationError(() => parseBlueprintFile(broken)).path).toBe('blueprint.budgets.maxCostUsd')
	})
})

describe('parseToolManifest', () => {
	test('parses a valid manifest', () => {
		const manifest = parseToolManifest({ name: 'read_file', description: 'Read a file.', parameters: { type: 'object' } }, 'm')
		expect(manifest.name).toBe('read_file')
		expect(manifest.parameters).toEqual({ type: 'object' })
	})

	test('rejects a manifest with no parameters and names the path', () => {
		expect(captureValidationError(() => parseToolManifest({ name: 'x', description: 'y' }, 'm')).path).toBe('m.parameters')
	})
})

describe('validateBlueprint', () => {
	test('accepts a document whose references all resolve', () => {
		const file = parseBlueprintFile(validDocument)
		expect(() => validateBlueprint(file, manifests)).not.toThrow()
	})

	test('rejects an entry role that is not defined', () => {
		const file = { ...parseBlueprintFile(validDocument), entryRole: 'ghost' }
		expect(captureValidationError(() => validateBlueprint(file, manifests)).path).toBe('blueprint.entryRole')
	})

	test('rejects a role tool that no manifest declares, naming the index', () => {
		const file = parseBlueprintFile({
			...validDocument,
			roles: { orchestrator: { prompt: 'p.md', model: 'reasoner', tools: ['agent', 'undeclared'] } },
		})
		expect(captureValidationError(() => validateBlueprint(file, manifests)).path).toBe('blueprint.roles.orchestrator.tools[1]')
	})

	test('rejects a role model that no routing profile defines', () => {
		const file = parseBlueprintFile({
			...validDocument,
			roles: { orchestrator: { prompt: 'p.md', model: 'ghost', tools: ['agent'] } },
		})
		expect(captureValidationError(() => validateBlueprint(file, manifests)).path).toBe('blueprint.roles.orchestrator.model')
	})

	test('rejects the same tool name declared twice', () => {
		const file = parseBlueprintFile(validDocument)
		const duplicated = [...manifests, { name: 'agent', description: 'Again.', parameters: {} }]
		expect(captureValidationError(() => validateBlueprint(file, duplicated)).path).toBe('blueprint.tools[2]')
	})

	test('rejects an approval gate naming an undeclared tool', () => {
		const file = parseBlueprintFile({ ...validDocument, permissions: { mode: 'full', requireApproval: ['run_shell'] } })
		expect(captureValidationError(() => validateBlueprint(file, manifests)).path).toBe('blueprint.permissions.requireApproval[0]')
	})
})
