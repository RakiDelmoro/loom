/**
 * The Tuner's own configuration.
 *
 * Separate from the deployment file on purpose: the deployment is what a *run*
 * needs, this is what an *optimization* needs — where the suite is, how many
 * cycles to spend, and which big model does the proposing.
 */

import { expectNonEmptyString, expectPositiveInteger, expectRecord, fail, rejectUnknownKeys } from '../validation.ts'
import type { TunerConfig } from './types.ts'

const CONFIG_KEYS = [
	'suitePath',
	'guildPath',
	'deploymentPath',
	'maxCycles',
	'maxCostUsd',
	'plateauLimit',
	'improvementMargin',
	'costMargin',
	'repetitions',
	'bigModel',
] as const
const BIG_MODEL_KEYS = ['provider', 'model'] as const

/** A margin in [0, 1): the fraction of the suite a candidate must beat the baseline by. */
function expectMargin(value: unknown, path: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value >= 1) {
		fail(path, 'expected a number in [0, 1)')
	}
	return value
}

/** A ceiling that may legitimately be zero, unlike every other number here. */
function expectNonNegative(value: unknown, path: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
		fail(path, 'expected a number greater than or equal to zero')
	}
	return value
}

export function parseTunerConfig(value: unknown, path = 'tuner.json'): TunerConfig {
	const record = expectRecord(value, path)
	rejectUnknownKeys(record, CONFIG_KEYS, path)

	const bigModelRecord = expectRecord(record['bigModel'], `${path}.bigModel`)
	rejectUnknownKeys(bigModelRecord, BIG_MODEL_KEYS, `${path}.bigModel`)

	return {
		suitePath: expectNonEmptyString(record['suitePath'], `${path}.suitePath`),
		guildPath: expectNonEmptyString(record['guildPath'], `${path}.guildPath`),
		deploymentPath: expectNonEmptyString(record['deploymentPath'], `${path}.deploymentPath`),
		maxCycles: expectPositiveInteger(record['maxCycles'], `${path}.maxCycles`),
		maxCostUsd: expectNonNegative(record['maxCostUsd'], `${path}.maxCostUsd`),
		plateauLimit: expectPositiveInteger(record['plateauLimit'], `${path}.plateauLimit`),
		improvementMargin: expectMargin(record['improvementMargin'], `${path}.improvementMargin`),
		costMargin: expectMargin(record['costMargin'], `${path}.costMargin`),
		repetitions: expectPositiveInteger(record['repetitions'], `${path}.repetitions`),
		bigModel: {
			provider: expectNonEmptyString(bigModelRecord['provider'], `${path}.bigModel.provider`),
			model: expectNonEmptyString(bigModelRecord['model'], `${path}.bigModel.model`),
		},
	}
}
