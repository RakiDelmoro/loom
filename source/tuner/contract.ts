/**
 * The promotion contract.
 *
 * Every candidate must satisfy these before it is even evaluated, because the
 * loop is a search over *behavior* and a search left to itself will happily
 * trade safety for score. A candidate that fails here is rejected outright —
 * not scored low, not merged anyway.
 *
 * The deployment file is not mentioned: it lives outside the guild directory, so
 * a candidate cannot reach a credential or a price by construction.
 */

import type { IsolationMode, PermissionMode } from '../blueprint/types.ts'
import { WORKSPACE_MUTATING_TOOLS } from '../tools/types.ts'

/** The parts of a Blueprint the contract reasons about. Both the parsed and the loaded shape satisfy it. */
export interface ContractView {
	readonly roles: Readonly<Record<string, { readonly tools: readonly string[]; readonly isolation: IsolationMode }>>
	readonly permissions: { readonly mode: PermissionMode }
	/**
	 * Model **identity** only — `provider` and `model`, never `temperature`.
	 *
	 * Temperature is a sampling setting, and "this role should sample tighter" is a
	 * claim about how to guide the model. Which model it is, is not a claim the
	 * search gets to make.
	 */
	readonly routing: Readonly<Record<string, { readonly provider: string; readonly model: string }>>
}

/** Weaker is later in this list. A candidate may strengthen, never weaken. */
const PERMISSION_MODES = ['read-only', 'workspace-write', 'full'] as const

function holdsMutatingTool(tools: readonly string[]): boolean {
	return tools.some((tool) => WORKSPACE_MUTATING_TOOLS.some((mutating) => mutating === tool))
}

/**
 * Everything a candidate did that it must not do.
 *
 * An empty list means the candidate is admissible; it is not a judgement about
 * whether the change is *good*, which is the Bench's job.
 */
export function contractViolations(baseline: ContractView, candidate: ContractView): string[] {
	const violations: string[] = []

	const baselineMode = PERMISSION_MODES.indexOf(baseline.permissions.mode)
	const candidateMode = PERMISSION_MODES.indexOf(candidate.permissions.mode)
	if (candidateMode > baselineMode) {
		violations.push(
			`permissions.mode was weakened from "${baseline.permissions.mode}" to "${candidate.permissions.mode}"`,
		)
	}

	for (const [name, role] of Object.entries(candidate.roles)) {
		// Containment, not capability. Granting a role a new tool is a *quality*
		// question — the Bench decides whether it helps — but a role that can write
		// outside its own worktree writes into the tree everything else is based
		// on, and that is a safety question the loop must not get to answer.
		const candidateRole = role
		const baselineRole = baseline.roles[name]
		const isolation = candidateRole.isolation ?? baselineRole?.isolation ?? 'worktree'
		if (holdsMutatingTool(candidateRole.tools) && isolation !== 'worktree') {
			violations.push(`role "${name}" can change the workspace but is not worktree-isolated`)
		}
	}

	// The model is pinned, and this is the rule that makes the search mean
	// something. A candidate may only name a model the baseline already runs, so a
	// win cannot be "it used a better model" — it can only be the setup.
	//
	// Both routes are the same move: editing a profile's model, and adding a
	// profile that points elsewhere and moving a role onto it. Checking the
	// candidate's profiles against the baseline's pairs covers both, and because a
	// single-model baseline has exactly one pair, it stays single-model.
	const pinned = new Set(Object.values(baseline.routing).map((profile) => `${profile.provider}/${profile.model}`))
	for (const [name, profile] of Object.entries(candidate.routing)) {
		if (pinned.has(`${profile.provider}/${profile.model}`)) continue
		violations.push(
			`routing profile "${name}" names ${profile.provider}/${profile.model}, which the baseline does not run; ` +
				`this search is pinned to ${[...pinned].join(', ')}`,
		)
	}

	return violations
}
