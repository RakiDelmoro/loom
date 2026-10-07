/**
 * Role → routing profile resolution.
 *
 * The Blueprint names profiles, never concrete models, so the same Blueprint
 * runs cheap in development and strong in production without an edit. This
 * module is the single place that reads that mapping.
 */

import { ValidationError } from '../errors.ts'
import type { LoadedBlueprint, RoutingProfile } from '../blueprint/types.ts'

/**
 * The routing profile a role uses.
 *
 * `overrides` maps a role name to a profile name and wins over the Blueprint —
 * which is what makes `--model-override coder=reasoner` a per-run decision
 * rather than a config edit. The Blueprint's cross-reference check guarantees a
 * loaded Blueprint resolves, so a miss here means the caller holds a name that
 * does not exist — a programming error.
 */
export function routeRole(
	blueprint: LoadedBlueprint,
	roleName: string,
	overrides: Readonly<Record<string, string>> = {},
): RoutingProfile {
	const role = blueprint.roles[roleName]
	if (role === undefined) throw new ValidationError(`roles.${roleName}`, 'role is not defined in the Blueprint')

	const profileName = overrides[roleName] ?? role.model
	const profile = blueprint.routing[profileName]
	if (profile === undefined) {
		throw new ValidationError(`routing.${profileName}`, `routing profile "${profileName}" is not defined in the Blueprint`)
	}
	return profile
}

/** The whole routing table a Blueprint implies: one profile per role. */
export function routeAllRoles(
	blueprint: LoadedBlueprint,
	overrides: Readonly<Record<string, string>> = {},
): Record<string, RoutingProfile> {
	const table: Record<string, RoutingProfile> = {}
	for (const name of Object.keys(blueprint.roles)) table[name] = routeRole(blueprint, name, overrides)
	return table
}

/**
 * Checks an override map against the Blueprint *before* a run starts, so a
 * typo fails immediately instead of silently doing nothing because the role it
 * names never happened to run.
 */
export function validateOverrides(blueprint: LoadedBlueprint, overrides: Readonly<Record<string, string>>): void {
	for (const [roleName, profileName] of Object.entries(overrides)) {
		if (blueprint.roles[roleName] === undefined) {
			throw new ValidationError(`overrides.${roleName}`, `role "${roleName}" is not defined in the Blueprint`)
		}
		if (blueprint.routing[profileName] === undefined) {
			throw new ValidationError(
				`overrides.${roleName}`,
				`routing profile "${profileName}" is not defined in the Blueprint`,
			)
		}
	}
}
