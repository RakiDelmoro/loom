import { describe, expect, test } from 'bun:test'
import { acceptedBranches, attemptKey, type AgentRecord, type RunManifest } from './types.ts'
import { createTestManifest } from '../test-support/runs.ts'

/**
 * Which of a run's branches its work actually consists of.
 *
 * Both rules here were missing, and both cost real benchmark runs: failed
 * attempts were merged, and a retry stacked on top of the attempt it replaced.
 */

function agent(overrides: Partial<AgentRecord>): AgentRecord {
	return {
		agentId: 'coder-1-2',
		role: 'coder',
		parentId: 'orchestrator-0-1',
		depth: 1,
		task: 'fix the tags',
		status: 'success',
		summary: 'done',
		branch: 'loom/run-1/coder-1-2',
		sha: 'sha2',
		startedAt: '2026-01-01T00:00:00.000Z',
		finishedAt: '2026-01-01T00:00:01.000Z',
		model: 'test-model',
		usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 },
		costUsd: 0,
		...overrides,
	}
}

function manifest(agents: readonly AgentRecord[]): RunManifest {
	return createTestManifest({ agents })
}

describe('acceptedBranches', () => {
	test('a successful attempt is accepted', () => {
		expect(acceptedBranches(manifest([agent({})]))).toEqual(['loom/run-1/coder-1-2'])
	})

	test('a failed attempt is not — its commits stay on its own branch', () => {
		// Reproduced: three coders hit their turn limit, errored, and had their work
		// merged into the base anyway.
		const failed = agent({ status: 'error', agentId: 'coder-1-5', branch: 'loom/run-1/coder-1-5', sha: 'sha5' })
		expect(acceptedBranches(manifest([failed]))).toEqual([])
	})

	test('an attempt with nothing committed is not a branch', () => {
		expect(acceptedBranches(manifest([agent({ sha: null, branch: null })]))).toEqual([])
	})

	test('a retry supersedes the attempt it replaced', () => {
		// Merging both is what made persistence self-defeating: the newer attempt
		// conflicted with the older one it was written to replace.
		const first = agent({ agentId: 'coder-1-2', branch: 'loom/run-1/coder-1-2' })
		const second = agent({ agentId: 'coder-1-3', branch: 'loom/run-1/coder-1-3' })
		expect(acceptedBranches(manifest([first, second]))).toEqual(['loom/run-1/coder-1-3'])
	})

	test('the same role asked for different things is two pieces of work, and both count', () => {
		const tags = agent({ agentId: 'coder-1-2', branch: 'loom/run-1/coder-1-2', task: 'fix the tags' })
		const publish = agent({ agentId: 'coder-1-3', branch: 'loom/run-1/coder-1-3', task: 'fix publish' })
		expect(acceptedBranches(manifest([tags, publish]))).toEqual(['loom/run-1/coder-1-2', 'loom/run-1/coder-1-3'])
	})

	test('the same task under a different parent is a different request', () => {
		const one = agent({ agentId: 'coder-1-2', branch: 'loom/run-1/coder-1-2' })
		const two = agent({ agentId: 'coder-2-3', branch: 'loom/run-2/coder-2-3', parentId: 'planner-1-9', depth: 2 })
		expect(acceptedBranches(manifest([one, two]))).toHaveLength(2)
	})

	test('a failed retry does not supersede the success it followed', () => {
		// The first attempt worked; a later one died. The working one still counts,
		// because superseding is a claim about acceptance, not about recency.
		const worked = agent({ agentId: 'coder-1-2', branch: 'loom/run-1/coder-1-2' })
		const died = agent({ agentId: 'coder-1-3', branch: 'loom/run-1/coder-1-3', status: 'error' })
		expect(acceptedBranches(manifest([worked, died]))).toEqual(['loom/run-1/coder-1-2'])
	})

	test('order follows spawn order, not the order acceptance was decided', () => {
		const a = agent({ agentId: 'coder-1-2', branch: 'loom/run-1/coder-1-2', task: 'a' })
		const b = agent({ agentId: 'coder-1-3', branch: 'loom/run-1/coder-1-3', task: 'b' })
		expect(acceptedBranches(manifest([a, b]))).toEqual(['loom/run-1/coder-1-2', 'loom/run-1/coder-1-3'])
	})

	test("a child's work is not landed twice: it is already inside its caller's branch", () => {
		// Integrating a child merges its branch into the caller's workspace, so the
		// caller's branch already contains the child's work. Landing the child again
		// sends the same change at the base a second time — against a base that has
		// moved — and the second merge conflicts arithmetically.
		//
		// This is how `fix_shared_mutation` failed with a branch that had succeeded
		// and been accepted: orchestrator-0-1 and coder-1-3 both successful, both
		// merged into the base, CONFLICT in the two files the coder had just fixed.
		const caller = agent({
			agentId: 'orchestrator-0-1',
			role: 'orchestrator',
			parentId: null,
			depth: 0,
			branch: 'loom/run-1/orchestrator-0-1',
			sha: 'sha1',
		})
		const callee = agent({ agentId: 'coder-1-2', branch: 'loom/run-1/coder-1-2', sha: 'sha2' })

		expect(acceptedBranches(manifest([caller, callee]))).toEqual(['loom/run-1/orchestrator-0-1'])
	})

	test('a child still lands when its caller did not, because nothing else carries it', () => {
		// The same rule read the other way. A failed caller's branch stays behind, so
		// nothing else brings the child's work to the base and the child must.
		const caller = agent({
			agentId: 'orchestrator-0-1',
			role: 'orchestrator',
			parentId: null,
			depth: 0,
			branch: 'loom/run-1/orchestrator-0-1',
			sha: null,
			status: 'error',
		})
		const callee = agent({ agentId: 'coder-1-2', branch: 'loom/run-1/coder-1-2', sha: 'sha2' })

		expect(acceptedBranches(manifest([caller, callee]))).toEqual(['loom/run-1/coder-1-2'])
	})
})

describe('attemptKey', () => {
	test('a retry and a rephrase of the same task are different keys', () => {
		// The honest limit of this rule: recognition is textual, so a retry that
		// rewords its task looks like new work. A model that rewords is a model
		// that changed its approach, which is arguably not the same attempt.
		expect(attemptKey({ parentId: 'p', role: 'coder', task: 'fix the tags' })).toBe(
			attemptKey({ parentId: 'p', role: 'coder', task: 'fix the tags' }),
		)
		expect(attemptKey({ parentId: 'p', role: 'coder', task: 'fix the tags' })).not.toBe(
			attemptKey({ parentId: 'p', role: 'coder', task: 'fix the tag helper' }),
		)
	})

	test('the entry role has no parent, and that is a key rather than a crash', () => {
		expect(attemptKey({ parentId: null, role: 'orchestrator', task: 'do it' })).toContain('root')
	})
})
