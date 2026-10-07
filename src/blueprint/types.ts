/**
 * The Blueprint: the entire behavior of the system as data.
 *
 * There are two shapes. `BlueprintFile` is the document exactly as it appears on
 * disk, where tools are *paths* to manifests. `LoadedBlueprint` is what the
 * engine consumes, with the manifests and role prompts read and cross-references
 * already checked.
 */

export type PermissionMode = 'read-only' | 'workspace-write' | 'full'

/**
 * `worktree` gives the role its own git worktree and branch (safe to run in
 * parallel). `shared` runs against the base tree — for read-only roles only.
 */
export type IsolationMode = 'worktree' | 'shared'

/** Display text in three tiers, for the UI. Localization only; the engine ignores it. */
export interface TieredText {
	readonly detailed?: string
	readonly friendly?: string
	readonly whimsical?: string
}

export interface RoleDefinition {
	/** Path to the role's Markdown system prompt, relative to the Blueprint file. */
	readonly prompt: string
	/** A routing profile name. Never a concrete model id. */
	readonly model: string
	/** The tool names this role may call. A role sees only these. */
	readonly tools: readonly string[]
	readonly isolation: IsolationMode
	/** How many `agent` children this role may run at once. */
	readonly maxChildren: number
	/** Optional shared style file appended to the system prompt at load time. */
	readonly styleGuide?: string
	readonly label?: TieredText
	readonly description?: TieredText
	readonly workingLabel?: TieredText
}

/** A role with its prompt resolved and its style guide appended. */
export interface LoadedRole extends RoleDefinition {
	readonly systemPrompt: string
}

/** A named model binding. The Blueprint names profiles; deployment resolves them. */
export interface RoutingProfile {
	readonly provider: string
	readonly model: string
	readonly temperature: number
	readonly maxTokens?: number
}

export interface Budgets {
	readonly maxAgentDepth: number
	readonly maxConcurrentAgents: number
	readonly maxCostUsd: number
	readonly maxTokensPerRun: number
	readonly toolTimeoutSeconds: number
}

export interface Permissions {
	readonly mode: PermissionMode
	readonly requireApproval: readonly string[]
}

export interface ToolManifest {
	readonly name: string
	readonly description: string
	/** JSON Schema for the tool's arguments. */
	readonly parameters: Readonly<Record<string, unknown>>
}

/** The Blueprint document as authored, before tool manifests and prompts are read. */
export interface BlueprintFile {
	readonly entryRole: string
	readonly roles: Readonly<Record<string, RoleDefinition>>
	readonly toolPaths: readonly string[]
	readonly routing: Readonly<Record<string, RoutingProfile>>
	readonly budgets: Budgets
	readonly permissions: Permissions
}

/** A Blueprint ready to run: manifests and prompts resolved, references checked. */
export interface LoadedBlueprint {
	readonly entryRole: string
	readonly roles: Readonly<Record<string, LoadedRole>>
	readonly tools: readonly ToolManifest[]
	readonly routing: Readonly<Record<string, RoutingProfile>>
	readonly budgets: Budgets
	readonly permissions: Permissions
}

