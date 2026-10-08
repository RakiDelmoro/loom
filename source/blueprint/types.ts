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
	/** The endpoint's context window, in tokens. Drives the pressure trigger. */
	readonly contextWindow?: number
	/**
	 * Fraction of the window at which a role is told to hand off. Must be in
	 * (0, 1) when `contextWindow` is set. Defaults to 0.8.
	 */
	readonly contextPressure?: number
}

/** Limits the engine **enforces**. */
export interface Budgets {
	readonly maxAgentDepth: number
	readonly maxConcurrentAgents: number
	readonly toolTimeoutSeconds: number
	/**
	 * The loop detector: every `everyToolCalls` tool calls or `everyTokens` output
	 * tokens, the engine asks `handlerRole` whether the role is stuck. A handler
	 * verdict of `loop_detected` ends the role. Absent, there is no detector.
	 */
	readonly loopCheck?: LoopCheck
}

export interface LoopCheck {
	/** The role that judges a possible loop. It sees the target's tool-call trace. */
	readonly handlerRole: string
	readonly everyToolCalls: number
	readonly everyTokens: number
}

/**
 * Thresholds the engine merely **reports** on: crossing one emits an event and
 * never stops a run. Spend is measured, not enforced — see
 * [`plan/model-routing.md`](../../plan/model-routing.md).
 */
export interface Alerts {
	readonly costUsd?: number
	readonly tokens?: number
}

export interface Permissions {
	readonly mode: PermissionMode
	readonly requireApproval: readonly string[]
	/**
	 * Hosts a run may reach. **Empty means no network at all** — egress is granted,
	 * never assumed.
	 */
	readonly egress: readonly string[]
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
	readonly alerts: Alerts
	readonly permissions: Permissions
}

/** A Blueprint ready to run: manifests and prompts resolved, references checked. */
export interface LoadedBlueprint {
	readonly entryRole: string
	readonly roles: Readonly<Record<string, LoadedRole>>
	readonly tools: readonly ToolManifest[]
	readonly routing: Readonly<Record<string, RoutingProfile>>
	readonly budgets: Budgets
	readonly alerts: Alerts
	readonly permissions: Permissions
}

