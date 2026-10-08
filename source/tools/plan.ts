/**
 * The plan tools: the one artifact that outlives the role that wrote it.
 *
 * A plan returned as a finish summary dies with the planner's conversation. The
 * orchestrator then paraphrases it into task texts, and each coder reads a
 * sentence about its step with no way to see where that step begins and ends —
 * so work overlaps, two agents change the same file, and neither can tell which
 * of them owned it. A run in this repository did exactly that: seventeen agents,
 * eight commits, and a merged tree that no longer compiled.
 *
 * The plan is written once, by the planner, and read by whoever needs it. That
 * is the whole point: the partition of the work survives the role that made it.
 *
 * Unlike every other file tool, this one is deliberately **not** confined to the
 * workspace. The plan belongs to the run, not to one agent's worktree, and it
 * lives beside the run's own record — where a worktree-isolated agent could not
 * see it and a shared one would merge it into somebody's branch. There is no path
 * argument, because the tool has exactly one file.
 */

import * as path from 'node:path'
import type { FileSystem } from '../fs.ts'
import { invalidArguments } from './arguments.ts'
import type { ToolHandler, ToolResult } from './types.ts'

export interface PlanToolDependencies {
	readonly fs: FileSystem
	/** The run's plan file, resolved by the composition root and never by a model. */
	readonly planPath: string
}

export function createPlanToolHandlers(dependencies: PlanToolDependencies): readonly ToolHandler[] {
	return [createReadPlanTool(dependencies), createWritePlanTool(dependencies)]
}

function createReadPlanTool(dependencies: PlanToolDependencies): ToolHandler {
	return {
		name: 'read_plan',
		async run(): Promise<ToolResult> {
			// A run without a plan is an ordinary state, not a failure: the planner
			// may not have run, or may have decided the task needed no plan. Saying
			// so plainly is what lets a role proceed instead of retrying.
			if (!dependencies.fs.exists(dependencies.planPath)) {
				return { kind: 'success', data: { exists: false, plan: '' } }
			}

			const read = dependencies.fs.readTextFile(dependencies.planPath)
			if (read.kind !== 'ok') return { kind: 'unavailable', message: read.message }
			return { kind: 'success', data: { exists: true, plan: read.text } }
		},
	}
}

function createWritePlanTool(dependencies: PlanToolDependencies): ToolHandler {
	return {
		name: 'write_plan',
		async run(args): Promise<ToolResult> {
			const plan = args['plan']
			if (typeof plan !== 'string' || plan.trim() === '') {
				return invalidArguments('plan must be a non-empty string')
			}

			// Replaced, never appended: the plan is one document, and a revision is a
			// rewrite. An appended plan would leave a coder reading two contradictory
			// partitions of the same work with nothing saying which is current.
			dependencies.fs.ensureDirectory(path.dirname(dependencies.planPath))
			dependencies.fs.writeTextFile(dependencies.planPath, plan)
			return { kind: 'success', data: { bytes: plan.length } }
		},
	}
}