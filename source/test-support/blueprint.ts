import type { Alerts, LoadedBlueprint, LoadedRole, RoutingProfile } from '../blueprint/types.ts'

const DEFAULT_PROFILE: RoutingProfile = { provider: 'test', model: 'test-model', temperature: 0 }

export interface TestRole {
	readonly tools?: readonly string[]
	readonly isolation?: 'worktree' | 'shared'
	readonly maxChildren?: number
	readonly systemPrompt?: string
}

export interface TestBlueprintOptions {
	readonly entryRole?: string
	readonly maxAgentDepth?: number
	readonly maxConcurrentAgents?: number
	/** Defaults to every tool named by any role. */
	readonly toolNames?: readonly string[]
	readonly alerts?: Alerts
}

/** A loaded Blueprint built in memory, so scheduler tests need no files at all. */
export function createTestBlueprint(
	roles: Readonly<Record<string, TestRole>>,
	options: TestBlueprintOptions = {},
): LoadedBlueprint {
	const loadedRoles: Record<string, LoadedRole> = {}
	for (const [name, role] of Object.entries(roles)) {
		loadedRoles[name] = {
			prompt: 'prompt.md',
			model: 'default',
			tools: role.tools ?? [],
			isolation: role.isolation ?? 'worktree',
			maxChildren: role.maxChildren ?? 1,
			systemPrompt: role.systemPrompt ?? `You are ${name}.`,
		}
	}

	const declaredTools = new Set<string>()
	for (const role of Object.values(roles)) for (const tool of role.tools ?? []) declaredTools.add(tool)

	return {
		entryRole: options.entryRole ?? 'orchestrator',
		roles: loadedRoles,
		tools: [...(options.toolNames ?? declaredTools)].map((name) => ({
			name,
			description: `${name} tool`,
			parameters: { type: 'object' },
		})),
		routing: { default: DEFAULT_PROFILE },
		budgets: {
			maxAgentDepth: options.maxAgentDepth ?? 4,
			maxConcurrentAgents: options.maxConcurrentAgents ?? 4,
			toolTimeoutSeconds: 30,
		},
		alerts: options.alerts ?? {},
		permissions: { mode: 'workspace-write', requireApproval: [] },
	}
}
