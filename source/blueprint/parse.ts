/**
 * Pure parsers for the Blueprint and its tool manifests.
 *
 * These functions contain no I/O and no dependency on the filesystem: they take
 * a parsed JSON value and either return the typed structure or throw a
 * `ValidationError` naming the exact path that is wrong.
 *
 * Two rules hold throughout:
 *   - unknown keys are rejected at every level, so a typo fails loudly instead
 *     of being silently ignored;
 *   - every failure names a JSON path (`roles.coder.tools[2]`), so the message
 *     is actionable without reading the parser.
 *
 * The `expect*` helpers below are a small validation vocabulary, not one-line
 * renames: each encodes a policy (non-empty, positive, finite, path-tagged) that
 * dozens of call sites must apply identically.
 */

import {
	expectEnum,
	expectNonEmptyString,
	expectNonNegativeNumber,
	expectNumber,
	expectPositiveInteger,
	expectRecord,
	expectStringArray,
	fail,
	rejectUnknownKeys,
} from '../validation.ts'
import type {
	Alerts,
	BlueprintFile,
	Budgets,
	IsolationMode,
	Permissions,
	PermissionMode,
	RoleDefinition,
	RoutingProfile,
	TieredText,
	ToolManifest,
} from './types.ts'

const ISOLATION_MODES = ['worktree', 'shared'] as const
const PERMISSION_MODES = ['read-only', 'workspace-write', 'full'] as const

const BLUEPRINT_KEYS = ['entryRole', 'roles', 'tools', 'routing', 'budgets', 'alerts', 'permissions', 'visualization'] as const
const ROLE_KEYS = ['prompt', 'model', 'tools', 'isolation', 'parallel', 'styleGuide', 'label', 'description', 'workingLabel'] as const
const PARALLEL_KEYS = ['maxChildren'] as const
const ROUTING_KEYS = ['provider', 'model', 'temperature', 'maxTokens'] as const
const BUDGET_KEYS = ['maxAgentDepth', 'maxConcurrentAgents', 'toolTimeoutSeconds'] as const
const ALERT_KEYS = ['costUsd', 'tokens'] as const
const PERMISSION_KEYS = ['mode', 'requireApproval'] as const
const MANIFEST_KEYS = ['name', 'description', 'parameters'] as const
const TIER_KEYS = ['detailed', 'friendly', 'whimsical'] as const

// --- object parsers ---------------------------------------------------------

function parseTieredText(value: unknown, path: string): TieredText {
	const record = expectRecord(value, path)
	rejectUnknownKeys(record, TIER_KEYS, path)
	const text: { detailed?: string; friendly?: string; whimsical?: string } = {}
	for (const tier of TIER_KEYS) {
		const raw = record[tier]
		if (raw === undefined) continue
		text[tier] = expectNonEmptyString(raw, `${path}.${tier}`)
	}
	return text
}

function parseRole(value: unknown, path: string): RoleDefinition {
	const record = expectRecord(value, path)
	rejectUnknownKeys(record, ROLE_KEYS, path)

	const isolation: IsolationMode = record['isolation'] === undefined
		? 'worktree'
		: expectEnum(record['isolation'], ISOLATION_MODES, `${path}.isolation`)

	let maxChildren = 1
	if (record['parallel'] !== undefined) {
		const parallel = expectRecord(record['parallel'], `${path}.parallel`)
		rejectUnknownKeys(parallel, PARALLEL_KEYS, `${path}.parallel`)
		maxChildren = expectPositiveInteger(parallel['maxChildren'], `${path}.parallel.maxChildren`)
	}

	return {
		prompt: expectNonEmptyString(record['prompt'], `${path}.prompt`),
		model: expectNonEmptyString(record['model'], `${path}.model`),
		tools: expectStringArray(record['tools'], `${path}.tools`),
		isolation,
		maxChildren,
		...(record['styleGuide'] !== undefined ? { styleGuide: expectNonEmptyString(record['styleGuide'], `${path}.styleGuide`) } : {}),
		...(record['label'] !== undefined ? { label: parseTieredText(record['label'], `${path}.label`) } : {}),
		...(record['description'] !== undefined ? { description: parseTieredText(record['description'], `${path}.description`) } : {}),
		...(record['workingLabel'] !== undefined ? { workingLabel: parseTieredText(record['workingLabel'], `${path}.workingLabel`) } : {}),
	}
}

function parseRoutingProfile(value: unknown, path: string): RoutingProfile {
	const record = expectRecord(value, path)
	rejectUnknownKeys(record, ROUTING_KEYS, path)
	return {
		provider: expectNonEmptyString(record['provider'], `${path}.provider`),
		model: expectNonEmptyString(record['model'], `${path}.model`),
		temperature: expectNumber(record['temperature'], `${path}.temperature`),
		...(record['maxTokens'] !== undefined ? { maxTokens: expectPositiveInteger(record['maxTokens'], `${path}.maxTokens`) } : {}),
	}
}

function parseBudgets(value: unknown, path: string): Budgets {
	const record = expectRecord(value, path)
	rejectUnknownKeys(record, BUDGET_KEYS, path)
	return {
		maxAgentDepth: expectPositiveInteger(record['maxAgentDepth'], `${path}.maxAgentDepth`),
		maxConcurrentAgents: expectPositiveInteger(record['maxConcurrentAgents'], `${path}.maxConcurrentAgents`),
		toolTimeoutSeconds: expectPositiveInteger(record['toolTimeoutSeconds'], `${path}.toolTimeoutSeconds`),
	}
}

/** Advisory thresholds: crossing one emits an event and never stops a run. */
function parseAlerts(value: unknown, path: string): Alerts {
	const record = expectRecord(value, path)
	rejectUnknownKeys(record, ALERT_KEYS, path)
	return {
		...(record['costUsd'] !== undefined
			? { costUsd: expectNonNegativeNumber(record['costUsd'], `${path}.costUsd`) }
			: {}),
		...(record['tokens'] !== undefined ? { tokens: expectPositiveInteger(record['tokens'], `${path}.tokens`) } : {}),
	}
}

function parsePermissions(value: unknown, path: string): Permissions {
	const record = expectRecord(value, path)
	rejectUnknownKeys(record, PERMISSION_KEYS, path)
	const mode: PermissionMode = expectEnum(record['mode'], PERMISSION_MODES, `${path}.mode`)
	const requireApproval = record['requireApproval'] === undefined
		? []
		: expectStringArray(record['requireApproval'], `${path}.requireApproval`)
	return { mode, requireApproval }
}

/**
 * Parses a Blueprint document. `path` is the label used in error messages — the
 * file path in production, or a fixture name in tests.
 */
export function parseBlueprintFile(value: unknown, path = 'blueprint'): BlueprintFile {
	const record = expectRecord(value, path)
	rejectUnknownKeys(record, BLUEPRINT_KEYS, path)

	const rolesRecord = expectRecord(record['roles'], `${path}.roles`)
	const roles: Record<string, RoleDefinition> = {}
	for (const [name, roleValue] of Object.entries(rolesRecord)) {
		roles[name] = parseRole(roleValue, `${path}.roles.${name}`)
	}
	if (Object.keys(roles).length === 0) fail(`${path}.roles`, 'expected at least one role')

	const routingRecord = expectRecord(record['routing'], `${path}.routing`)
	const routing: Record<string, RoutingProfile> = {}
	for (const [name, profileValue] of Object.entries(routingRecord)) {
		routing[name] = parseRoutingProfile(profileValue, `${path}.routing.${name}`)
	}
	if (Object.keys(routing).length === 0) fail(`${path}.routing`, 'expected at least one routing profile')

	return {
		entryRole: expectNonEmptyString(record['entryRole'], `${path}.entryRole`),
		roles,
		toolPaths: expectStringArray(record['tools'], `${path}.tools`),
		routing,
		budgets: parseBudgets(record['budgets'], `${path}.budgets`),
		alerts: record['alerts'] === undefined ? {} : parseAlerts(record['alerts'], `${path}.alerts`),
		permissions: parsePermissions(record['permissions'], `${path}.permissions`),
	}
}

/** Parses one tool manifest document. */
export function parseToolManifest(value: unknown, path: string): ToolManifest {
	const record = expectRecord(value, path)
	rejectUnknownKeys(record, MANIFEST_KEYS, path)
	return {
		name: expectNonEmptyString(record['name'], `${path}.name`),
		description: expectNonEmptyString(record['description'], `${path}.description`),
		parameters: expectRecord(record['parameters'], `${path}.parameters`),
	}
}

/**
 * Checks the references *between* parts of a Blueprint, which structural parsing
 * cannot see: the entry role exists, every role's model names a routing profile,
 * every tool a role lists is declared, and no tool name is declared twice.
 */
export function validateBlueprint(file: BlueprintFile, manifests: readonly ToolManifest[], path = 'blueprint'): void {
	if (file.roles[file.entryRole] === undefined) {
		fail(`${path}.entryRole`, `entry role "${file.entryRole}" is not defined in roles`)
	}

	// Membership over a runtime-loaded list, so a Set is the right container.
	const declaredTools = new Set<string>()
	for (const [index, manifest] of manifests.entries()) {
		if (declaredTools.has(manifest.name)) fail(`${path}.tools[${index}]`, `tool "${manifest.name}" is declared more than once`)
		declaredTools.add(manifest.name)
	}

	for (const [name, role] of Object.entries(file.roles)) {
		if (file.routing[role.model] === undefined) {
			fail(`${path}.roles.${name}.model`, `routing profile "${role.model}" is not defined in routing`)
		}
		for (const [index, tool] of role.tools.entries()) {
			if (!declaredTools.has(tool)) fail(`${path}.roles.${name}.tools[${index}]`, `tool "${tool}" is not declared in tools`)
		}
	}

	for (const [index, tool] of file.permissions.requireApproval.entries()) {
		if (!declaredTools.has(tool)) {
			fail(`${path}.permissions.requireApproval[${index}]`, `tool "${tool}" is not declared in tools`)
		}
	}
}
