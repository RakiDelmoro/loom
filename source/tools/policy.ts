/**
 * The tool policy: what a run is allowed to do.
 *
 * The Blueprint's tool *grants* decide what a role may call. This decides what
 * the **run** permits at all — a second, independent gate, because a grant is a
 * description of intent and a permission mode is a statement about containment.
 *
 * Denial is a decision, not an error: the tool returns `permission_denied` and
 * the role keeps working. Killing the run over a blocked command would punish
 * the model for trying, and a model that is punished for exploring stops
 * exploring.
 */

import type { PermissionMode } from '../blueprint/types.ts'
import { WORKSPACE_MUTATING_TOOLS } from './types.ts'

export type PolicyDecision = { readonly kind: 'allow' } | { readonly kind: 'deny'; readonly reason: string }

export interface ToolPolicy {
	decide(tool: string): PolicyDecision
}

export interface ToolPolicyOptions {
	readonly mode: PermissionMode
	/** Tools the Blueprint marks as needing approval. */
	readonly requireApproval: readonly string[]
	/** Tools this particular run has been granted approval for. */
	readonly approvals: readonly string[]
}

export function createToolPolicy(options: ToolPolicyOptions): ToolPolicy {
	return {
		decide(tool: string): PolicyDecision {
			// The mode is checked first: a read-only run is read-only whatever has
			// been approved.
			if (options.mode === 'read-only' && WORKSPACE_MUTATING_TOOLS.some((mutating) => mutating === tool)) {
				return { kind: 'deny', reason: `the run is read-only, so "${tool}" may not change the workspace` }
			}

			if (options.requireApproval.includes(tool) && !options.approvals.includes(tool)) {
				return { kind: 'deny', reason: `"${tool}" requires approval, and this run was not granted it` }
			}

			return { kind: 'allow' }
		},
	}
}
