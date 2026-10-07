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
 * The routing profile a role declares. The Blueprint's cross-reference check
 * guarantees this succeeds for a loaded Blueprint, so a miss here means the
 * caller is holding a role name that does not exist — a programming error.
 */
export function routeRole(blueprint: LoadedBlueprint, roleName: string): RoutingProfile {
	const role = blueprint.roles[roleName]
	if (role === undefined) throw new ValidationError(`roles.${roleName}`, 'role is not defined in the Blueprint')

	const profile = blueprint.routing[role.model]
	if (profile === undefined) {
		throw new ValidationError(`routing.${role.model}`, `routing profile "${role.model}" is not defined in the Blueprint`)
	}
	return profile
}

/** The whole routing table a Blueprint implies: one profile per role. */
export function routeAllRoles(blueprint: LoadedBlueprint): Record<string, RoutingProfile> {
	const table: Record<string, RoutingProfile> = {}
	for (const name of Object.keys(blueprint.roles)) table[name] = routeRole(blueprint, name)
	return table
}
