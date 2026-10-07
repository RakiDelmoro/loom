#!/usr/bin/env bun
/**
 * The `loom` command.
 *
 * Thin glue only: parse arguments, call the composition root or a run
 * operation, print what happened, choose an exit code. No logic worth testing
 * lives here — the modules it calls are the ones under test.
 */

import * as path from 'node:path'
import pkg from '../package.json'
import { loadBlueprint } from './blueprint/load.ts'
import { parseArguments, parseModelOverrides, type ParsedArguments } from './cli-args.ts'
import { ValidationError } from './errors.ts'
import { createNodeFileSystem } from './node-fs.ts'
import { noRedaction } from './redact.ts'
import { runTask, generateRunId } from './run-task.ts'
import { createRunControl } from './runs/control.ts'
import { diffRun, mergeAgent, undoRun } from './runs/lifecycle.ts'
import { runBench } from './run-bench.ts'
import { serve } from './serve.ts'
import type { Split, SuiteResult } from './bench/types.ts'
import { runTunerCommand } from './run-tuner.ts'
import type { TunerReport } from './tuner/types.ts'
import { createRunLifecycle } from './runs/lifecycle.ts'
import { createRunStore } from './runs/store.ts'
import type { AutonomyLevel, RunManifest } from './runs/types.ts'
import { createGitRunner } from './workspace/git.ts'
import { createWorktreeManager } from './workspace/worktree.ts'

const VERSION: string = pkg.version
const fileSystem = createNodeFileSystem()
const BOOLEAN_SWITCHES = ['branches'] as const
const REPEATED_FLAGS = ['model-override', 'approve'] as const

const USAGE = `loom — a git-native, concurrent, provider-agnostic multi-agent engine

Usage:
  loom --version
  loom --help
  loom blueprint validate <file>
  loom run --task <text> [--repo <path>] [--blueprint <file>] [--deployment <file>]
           [--autonomy <level>] [--model-override <role=profile>] [--approve <tool>]
  loom runs [--repo <path>]
  loom status <runId> [--repo <path>]
  loom diff   <runId> [--agent <id>] [--repo <path>]
  loom merge  <runId> --agent <id> [--repo <path>]
  loom undo   <runId> [--repo <path>]
  loom clean  <runId> [--branches] [--repo <path>]
  loom bench --suite <dir> [--split <optimization|held-out>] [--repetitions <n>]
  loom tune [--repo <path>] [--config <file>]
  loom serve [--repo <path>] [--port <n>] [--host <addr>]

Commands:
  blueprint validate   Validate a Blueprint and every tool manifest it names.
  run                  Run a task and write its record under .loom/runs/<runId>/.
  runs                 List the runs recorded in a repository.
  status               Show a run's manifest: agents, branches, commits, tokens, cost.
  diff                 Show what a run changed — every agent, or one with --agent.
  merge                Apply one agent's branch to the base branch.
  undo                 Return the base branch to the commit the run started from.
  clean                Remove a run's worktrees, and its branches with --branches.
  bench                Score a Blueprint against a benchmark suite.
  tune                 Improve the Blueprint against the bench, and promote what wins.
  serve                Serve the HTTP API and the browser UI for a repository.

Files:
  loom.json            The Blueprint: roles, tools, routing, budgets, alerts.
  loom.deployment.json Providers, endpoints, and model prices. Credentials are
                       named by "apiKeyEnv" and read from the environment — a
                       deployment file never holds a key.
`

function openRepository(repoPath: string) {
	const git = createGitRunner({ cwd: repoPath })
	const worktrees = createWorktreeManager({ git, fs: fileSystem }, { repoPath })
	return {
		store: createRunStore({ fs: fileSystem, now: () => Date.now(), redact: noRedaction }, { repoPath }),
		lifecycle: createRunLifecycle({ git, worktrees }, { repoPath }),
	}
}

function resolveRepoPath(args: ParsedArguments): string {
	const requested = args.flags['repo']
	return path.resolve(requested === undefined || requested === '' ? process.cwd() : requested)
}

function fail(message: string): number {
	process.stderr.write(`${message}\n`)
	return 1
}

function formatManifest(manifest: RunManifest): string {
	const lines = [
		`${manifest.runId}  ${manifest.status}  (${manifest.autonomy})`,
		`task:     ${manifest.task}`,
		`base:     ${manifest.baseRef} -> ${manifest.baseSha}`,
		`started:  ${manifest.startedAt}`,
		`finished: ${manifest.finishedAt ?? '-'}`,
		`tokens:   ${String(manifest.usage.inputTokens)} in / ${String(manifest.usage.outputTokens)} out`,
		`cost:     $${manifest.costUsd.toFixed(4)}`,
		'agents:',
	]
	if (manifest.agents.length === 0) lines.push('  (none)')
	for (const agent of manifest.agents) {
		lines.push(
			`  ${agent.agentId.padEnd(24)} ${agent.role.padEnd(14)} ${agent.status.padEnd(20)} ${agent.branch ?? '-'} ${agent.sha ?? '-'}`,
		)
	}
	if (manifest.models.length > 0) {
		lines.push('models:')
		for (const entry of manifest.models) {
			lines.push(
				`  ${entry.model.padEnd(24)} ${String(entry.usage.inputTokens)} in / ${String(entry.usage.outputTokens)} out  $${entry.costUsd.toFixed(4)}`,
			)
		}
	}
	return `${lines.join('\n')}\n`
}

function validateBlueprintCommand(filePath: string | undefined): number {
	if (filePath === undefined) {
		process.stderr.write('loom blueprint validate: missing <file>\n')
		return 2
	}
	try {
		const blueprint = loadBlueprint({ readTextFile: fileSystem.readTextFile }, filePath)
		const roles = Object.keys(blueprint.roles).length
		process.stdout.write(
			`${filePath}: ok — entry role "${blueprint.entryRole}", ${String(roles)} role(s), ${String(blueprint.tools.length)} tool(s)\n`,
		)
		return 0
	} catch (error) {
		if (error instanceof ValidationError) {
			process.stderr.write(`${filePath}: invalid\n  ${error.message}\n`)
			return 1
		}
		throw error
	}
}

function parseAutonomy(value: string): AutonomyLevel | null {
	if (value === 'auto' || value === 'supervised' || value === 'manual') return value
	return null
}

function resolveFileFlag(value: string | undefined, repoPath: string, fallbackName: string): string {
	return value === undefined || value === '' ? path.join(repoPath, fallbackName) : value
}

async function runCommand(args: ParsedArguments): Promise<number> {
	const repoPath = resolveRepoPath(args)
	const task = args.flags['task']
	if (task === undefined || task === '') return fail('loom run: --task is required')

	const autonomy = parseAutonomy(args.flags['autonomy'] ?? 'auto')
	if (autonomy === null) return fail('loom run: --autonomy must be auto, supervised, or manual')

	const overrides = parseModelOverrides(args.repeated['model-override'] ?? [])
	if (overrides.kind !== 'ok') return fail(`loom run: ${overrides.message}`)

	const outcome = await runTask({
		runId: generateRunId(new Date()),
		control: createRunControl(),
		repoPath,
		blueprintPath: resolveFileFlag(args.flags['blueprint'], repoPath, 'loom.json'),
		deploymentPath: resolveFileFlag(args.flags['deployment'], repoPath, 'loom.deployment.json'),
		task,
		autonomy,
		modelOverrides: overrides.value,
		approvals: args.repeated['approve'] ?? [],
		env: process.env,
		fetch: (url, init) => fetch(url, init),
		events: (event) => {
			if (event.type === 'agent_start') process.stderr.write(`  ${event.agentId} started\n`)
			if (event.type === 'alert') {
				process.stderr.write(
					`  alert: ${event.kind} reached ${String(event.actual)} (threshold ${String(event.threshold)}) — continuing\n`,
				)
			}
		},
	})

	process.stdout.write(formatManifest(outcome.manifest))
	for (const merge of outcome.merged) process.stdout.write(`merged ${merge.branch} -> ${merge.sha}\n`)
	for (const failure of outcome.mergeFailures) {
		process.stderr.write(`merge failed for ${failure.branch}: ${failure.message}\n`)
	}
	return outcome.status === 'success' ? 0 : 1
}

function runsCommand(args: ParsedArguments): number {
	const { store } = openRepository(resolveRepoPath(args))
	const runIds = store.listRunIds()
	if (runIds.length === 0) {
		process.stdout.write('no runs\n')
		return 0
	}
	for (const runId of runIds) {
		const manifest = store.readManifest(runId)
		process.stdout.write(`${runId}  ${manifest?.status ?? 'unknown'}  ${manifest?.task ?? ''}\n`)
	}
	return 0
}

function statusCommand(args: ParsedArguments): number {
	const runId = args.positionals[0]
	if (runId === undefined) return fail('loom status: missing <runId>')

	const manifest = openRepository(resolveRepoPath(args)).store.readManifest(runId)
	if (manifest === null) return fail(`loom status: no run "${runId}"`)

	process.stdout.write(formatManifest(manifest))
	return 0
}

function diffCommand(args: ParsedArguments): number {
	const runId = args.positionals[0]
	if (runId === undefined) return fail('loom diff: missing <runId>')

	const { store, lifecycle } = openRepository(resolveRepoPath(args))
	const only = args.flags['agent']
	const diff = diffRun(store, lifecycle, runId, only === undefined || only === '' ? null : only)
	if (diff.kind !== 'ok') return fail(`loom diff: ${diff.message}`)

	process.stdout.write(diff.value)
	return 0
}

function mergeCommand(args: ParsedArguments): number {
	const runId = args.positionals[0]
	const agentId = args.flags['agent']
	if (runId === undefined) return fail('loom merge: missing <runId>')
	if (agentId === undefined || agentId === '') return fail('loom merge: --agent is required')

	const { store, lifecycle } = openRepository(resolveRepoPath(args))
	const merged = mergeAgent(store, lifecycle, runId, agentId)
	if (merged.kind !== 'ok') return fail(`loom merge: ${merged.message}`)

	process.stdout.write(`merged -> ${merged.value}\n`)
	return 0
}

function undoCommand(args: ParsedArguments): number {
	const runId = args.positionals[0]
	if (runId === undefined) return fail('loom undo: missing <runId>')

	const { store, lifecycle } = openRepository(resolveRepoPath(args))
	const undone = undoRun(store, lifecycle, runId)
	if (undone.kind !== 'ok') return fail(`loom undo: ${undone.message}`)

	process.stdout.write(`base restored to ${undone.value}\n`)
	return 0
}

function cleanCommand(args: ParsedArguments): number {
	const runId = args.positionals[0]
	if (runId === undefined) return fail('loom clean: missing <runId>')

	const { lifecycle } = openRepository(resolveRepoPath(args))
	const cleaned = lifecycle.clean(runId, { branches: args.switches.includes('branches') })
	if (cleaned.kind !== 'ok') return fail(`loom clean: ${cleaned.message}`)

	process.stdout.write(`removed ${String(cleaned.value.length)} worktree(s)\n`)
	return 0
}

function parseSplit(value: string): Split | null {
	if (value === 'optimization' || value === 'held-out') return value
	return null
}

function formatSuiteResult(result: SuiteResult): string {
	const percent = (value: number): string => `${(value * 100).toFixed(1)}%`
	const lines = [
		`suite:     ${result.suitePath}`,
		`split:     ${result.split} (${String(result.benchmarks.length)} benchmark(s) x ${String(result.repetitions)} repetition(s))`,
		`blueprint: ${result.blueprintPath}`,
		`score:     ${percent(result.score)}  [${percent(result.interval.low)}, ${percent(result.interval.high)}]`,
		`cost:      $${result.costUsd.toFixed(4)}`,
		`time:      ${result.wallTimeSeconds.toFixed(1)}s`,
		'',
		'benchmarks:',
	]
	for (const summary of result.benchmarks) {
		lines.push(`  ${summary.benchmark.padEnd(28)} ${String(summary.passes)}/${String(summary.runs)}  $${summary.costUsd.toFixed(4)}`)
	}
	for (const outcome of result.outcomes) {
		if (outcome.status === 'pass') continue
		lines.push(`  ${outcome.benchmark} #${String(outcome.repetition)} ${outcome.status}: ${outcome.reasons.join('; ')}`)
	}
	return `${lines.join('\n')}\n`
}

async function benchCommand(args: ParsedArguments): Promise<number> {
	const repoPath = resolveRepoPath(args)
	const split = parseSplit(args.flags['split'] ?? 'optimization')
	if (split === null) return fail('loom bench: --split must be optimization or held-out')

	const repetitions = Number(args.flags['repetitions'] ?? '1')
	if (!Number.isInteger(repetitions) || repetitions <= 0) {
		return fail('loom bench: --repetitions must be a positive integer')
	}

	const suiteFlag = args.flags['suite']
	const result = await runBench({
		suitePath: path.resolve(suiteFlag === undefined || suiteFlag === '' ? 'benchmarks' : suiteFlag),
		split,
		blueprintPath: resolveFileFlag(args.flags['blueprint'], repoPath, 'loom.json'),
		deploymentPath: resolveFileFlag(args.flags['deployment'], repoPath, 'loom.deployment.json'),
		repetitions,
		resultsDirectory: path.join(repoPath, '.loom', 'bench'),
		env: process.env,
		fetch: (url, init) => fetch(url, init),
		onOutcome: (outcome) => {
			process.stderr.write(`  ${outcome.benchmark} #${String(outcome.repetition)} ${outcome.status}\n`)
		},
	})

	process.stdout.write(formatSuiteResult(result))
	return 0
}

function formatTunerReport(report: TunerReport): string {
	const percent = (value: number): string => `${(value * 100).toFixed(1)}%`
	const lines = [
		`guild:     ${report.guildPath}`,
		`cycles:    ${String(report.cycles.length)}`,
		`stopped:   ${report.terminatedBy}`,
		`cost:      $${report.costUsd.toFixed(4)}`,
		'',
	]
	for (const cycle of report.cycles) {
		lines.push(
			`cycle ${String(cycle.cycle)}  baseline ${percent(cycle.baselineScore)}  ${cycle.promoted ? 'PROMOTED' : 'no promotion'}  $${cycle.costUsd.toFixed(4)}`,
		)
		for (const branch of cycle.branches) {
			const note = branch.invalidReason ?? (branch.contractViolations.join('; ') || branch.verdictReasons.join('; '))
			lines.push(`  ${branch.branchId.padEnd(24)} ${(branch.valid ? branch.verdict : 'invalid').padEnd(10)} ${percent(branch.optimizationScore)}  ${note}`)
		}
		if (cycle.heldOut !== null) {
			lines.push(`  held-out: ${percent(cycle.heldOut.baselineScore)} -> ${percent(cycle.heldOut.candidateScore)} (${cycle.heldOut.verdict})`)
		}
		lines.push('')
	}
	if (report.history.length > 0) {
		lines.push('promoted baselines (newest first):')
		for (const entry of report.history) lines.push(`  ${entry}`)
	}
	return `${lines.join('\n')}\n`
}

async function tuneCommand(args: ParsedArguments): Promise<number> {
	const repoPath = resolveRepoPath(args)
	const configFlag = args.flags['config']

	const report = await runTunerCommand({
		configPath: path.resolve(configFlag === undefined || configFlag === '' ? path.join(repoPath, 'tuner.json') : configFlag),
		repoPath,
		env: process.env,
		fetch: (url, init) => fetch(url, init),
		onEvent: (message) => {
			process.stderr.write(`  ${message}\n`)
		},
	})

	process.stdout.write(formatTunerReport(report))
	return 0
}

async function serveCommand(args: ParsedArguments): Promise<number> {
	const repoPath = resolveRepoPath(args)
	const rawPort = args.flags['port'] ?? '8787'
	const port = Number.parseInt(rawPort, 10)
	if (!Number.isInteger(port) || port <= 0 || port > 65535) return fail('loom serve: --port must be a port number')

	const hostname = args.flags['host'] ?? '127.0.0.1'
	// A token is required unless the operator explicitly turns it off, and turning
	// it off is only safe on a loopback bind — so the flag has to be deliberate.
	const token = process.env['LOOM_TOKEN'] ?? null

	const handle = await serve({
		repoPath,
		blueprintPath: resolveFileFlag(args.flags['blueprint'], repoPath, 'loom.json'),
		deploymentPath: resolveFileFlag(args.flags['deployment'], repoPath, 'loom.deployment.json'),
		hostname,
		port,
		token,
		autonomy: parseAutonomy(args.flags['autonomy'] ?? 'auto') ?? 'auto',
		fs: fileSystem,
		env: process.env,
		fetch: (url, init) => fetch(url, init),
		write: (message) => process.stdout.write(message),
	})

	// Serve until the process is told to stop; the handle stays referenced so the
	// server is never garbage-collected out from under a live connection.
	await new Promise<void>((resolve) => {
		const shutdown = (): void => {
			void handle.stop().then(() => {
				resolve()
			})
		}
		process.on('SIGINT', shutdown)
		process.on('SIGTERM', shutdown)
	})
	return 0
}

async function main(argv: readonly string[]): Promise<number> {
	const command = argv[0]

	if (command === undefined || command === '--help' || command === '-h') {
		process.stdout.write(USAGE)
		return 0
	}
	if (command === '--version' || command === '-v') {
		process.stdout.write(`${VERSION}\n`)
		return 0
	}

	const args = parseArguments(argv.slice(1), BOOLEAN_SWITCHES, REPEATED_FLAGS)

	switch (command) {
		case 'blueprint':
			if (args.positionals[0] === 'validate') return validateBlueprintCommand(args.positionals[1])
			return fail('loom blueprint: expected "validate <file>"')
		case 'run':
			return runCommand(args)
		case 'runs':
			return runsCommand(args)
		case 'status':
			return statusCommand(args)
		case 'diff':
			return diffCommand(args)
		case 'merge':
			return mergeCommand(args)
		case 'undo':
			return undoCommand(args)
		case 'clean':
			return cleanCommand(args)
		case 'bench':
			return benchCommand(args)
		case 'tune':
			return tuneCommand(args)
		case 'serve':
			return serveCommand(args)
		default:
			process.stderr.write(`loom: unknown command "${command}"\n\n${USAGE}`)
			return 2
	}
}

// The CLI boundary: a configuration error is a message and an exit code, not a
// stack trace. Anything else is a bug, and is left to surface as one.
try {
	process.exit(await main(process.argv.slice(2)))
} catch (error) {
	if (error instanceof ValidationError) {
		process.stderr.write(`loom: ${error.message}\n`)
		process.exit(1)
	}
	throw error
}
