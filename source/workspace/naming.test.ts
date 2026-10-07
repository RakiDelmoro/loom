import { describe, expect, test } from 'bun:test'
import { agentLocation, runWorktreeDirectory } from './naming.ts'

describe('agentLocation', () => {
	test('derives the branch and worktree path from the run and agent ids', () => {
		const location = agentLocation('/repo', '20261007T142233Z-a1b2c3', 'coder-1-2')
		expect(location.branch).toBe('loom/20261007T142233Z-a1b2c3/coder-1-2')
		expect(location.worktreePath).toBe('/repo/.loom/worktrees/20261007T142233Z-a1b2c3/coder-1-2')
	})

	test('places an agent inside its run directory', () => {
		const runDirectory = runWorktreeDirectory('/repo', 'run-1')
		expect(agentLocation('/repo', 'run-1', 'coder-0-1').worktreePath).toBe(`${runDirectory}/coder-0-1`)
	})

	test('is stable across calls, so any process can find an agent without shared state', () => {
		expect(agentLocation('/repo', 'run-1', 'coder-0-1')).toEqual(agentLocation('/repo', 'run-1', 'coder-0-1'))
	})
})
