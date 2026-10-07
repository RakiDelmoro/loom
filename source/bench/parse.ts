/**
 * Strict parsing for benchmark specs and the suite configuration.
 *
 * The documents are small and fully known, so unknown keys are rejected at every
 * level: a typo in `expectedFiles` must fail loudly rather than silently
 * weakening the test the candidate is graded against.
 */

import { expectEnum, expectNonEmptyString, expectPositiveInteger, expectRecord, expectStringArray, rejectUnknownKeys } from '../validation.ts'
import type { BenchmarkSpec, Difficulty, JudgeConfig, JudgeSpec, SuiteConfig, ValidationSpec } from './types.ts'

const DIFFICULTIES = ['easy', 'medium', 'hard'] as const

const SPEC_KEYS = ['id', 'taskType', 'difficulty', 'task', 'validation', 'judge'] as const
const VALIDATION_KEYS = ['command', 'expectedExitCode', 'expectedFiles', 'expectedStdoutContains', 'timeoutSeconds'] as const
const JUDGE_KEYS = ['rubric'] as const
const SUITE_KEYS = ['optimization', 'heldOut', 'judge'] as const
const SUITE_JUDGE_KEYS = ['provider', 'model'] as const

function parseValidation(value: unknown, path: string): ValidationSpec {
	const record = expectRecord(value, path)
	rejectUnknownKeys(record, VALIDATION_KEYS, path)
	return {
		command: expectNonEmptyString(record['command'], `${path}.command`),
		expectedExitCode: record['expectedExitCode'] === undefined
			? 0
			: expectInteger(record['expectedExitCode'], `${path}.expectedExitCode`),
		expectedFiles: record['expectedFiles'] === undefined ? [] : expectStringArray(record['expectedFiles'], `${path}.expectedFiles`),
		expectedStdoutContains:
			record['expectedStdoutContains'] === undefined
				? []
				: expectStringArray(record['expectedStdoutContains'], `${path}.expectedStdoutContains`),
		timeoutSeconds:
			record['timeoutSeconds'] === undefined ? 120 : expectPositiveInteger(record['timeoutSeconds'], `${path}.timeoutSeconds`),
	}
}

/** An exit code may legitimately be negative (a signal), so this is not `expectPositiveInteger`. */
function expectInteger(value: unknown, path: string): number {
	if (typeof value !== 'number' || !Number.isInteger(value)) {
		return expectPositiveInteger(value, path)
	}
	return value
}

function parseJudge(value: unknown, path: string): JudgeSpec {
	const record = expectRecord(value, path)
	rejectUnknownKeys(record, JUDGE_KEYS, path)
	return { rubric: expectNonEmptyString(record['rubric'], `${path}.rubric`) }
}

export function parseBenchmarkSpec(value: unknown, path: string): BenchmarkSpec {
	const record = expectRecord(value, path)
	rejectUnknownKeys(record, SPEC_KEYS, path)

	const difficulty: Difficulty = expectEnum(record['difficulty'], DIFFICULTIES, `${path}.difficulty`)
	return {
		id: expectNonEmptyString(record['id'], `${path}.id`),
		taskType: expectNonEmptyString(record['taskType'], `${path}.taskType`),
		difficulty,
		task: expectNonEmptyString(record['task'], `${path}.task`),
		validation: parseValidation(record['validation'], `${path}.validation`),
		...(record['judge'] !== undefined ? { judge: parseJudge(record['judge'], `${path}.judge`) } : {}),
	}
}

export function parseSuiteConfig(value: unknown, path: string): SuiteConfig {
	const record = expectRecord(value, path)
	rejectUnknownKeys(record, SUITE_KEYS, path)

	let judge: JudgeConfig | undefined
	if (record['judge'] !== undefined) {
		const judgeRecord = expectRecord(record['judge'], `${path}.judge`)
		rejectUnknownKeys(judgeRecord, SUITE_JUDGE_KEYS, `${path}.judge`)
		judge = {
			provider: expectNonEmptyString(judgeRecord['provider'], `${path}.judge.provider`),
			model: expectNonEmptyString(judgeRecord['model'], `${path}.judge.model`),
		}
	}

	return {
		optimization: expectStringArray(record['optimization'], `${path}.optimization`),
		heldOut: expectStringArray(record['heldOut'], `${path}.heldOut`),
		...(judge !== undefined ? { judge } : {}),
	}
}
