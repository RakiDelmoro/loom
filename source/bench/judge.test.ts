import { describe, expect, test } from 'bun:test'
import { createFakeProvider } from '../model/fake.ts'
import { call, textResponse } from '../test-support/model.ts'
import { judgeWork, parseJudgeScore } from './judge.ts'

describe('parseJudgeScore', () => {
	test('reads a bare integer', () => {
		expect(parseJudgeScore('2')).toBe(2)
	})

	test('reads the first integer in a chatty reply', () => {
		expect(parseJudgeScore('I would say 3 out of 3.')).toBe(3)
	})

	test('ignores digits above the scale', () => {
		// 7 is not on a 0-3 scale, so the first in-range digit wins.
		expect(parseJudgeScore('7 out of 3')).toBe(3)
	})

	test('returns null when there is no score at all', () => {
		expect(parseJudgeScore('I cannot say')).toBeNull()
	})
})

describe('judgeWork', () => {
	const request = { task: 'fix the bug', rubric: 'Does it fix the cause?', evidence: 'exit code: 1' }

	test('normalizes a 0-3 score to 0-1', async () => {
		const provider = createFakeProvider([textResponse('3')])
		const result = await judgeWork({ provider, model: 'judge' }, request)
		expect(result).toEqual({ kind: 'ok', value: 1 })
	})

	test('a middling score lands in between', async () => {
		const provider = createFakeProvider([textResponse('1')])
		const result = await judgeWork({ provider, model: 'judge' }, request)
		expect(result.kind).toBe('ok')
		if (result.kind === 'ok') expect(result.value).toBeCloseTo(1 / 3, 10)
	})

	test('asks at temperature zero with no tools, so the judge is reproducible', async () => {
		const provider = createFakeProvider([textResponse('2')])
		await judgeWork({ provider, model: 'judge' }, request)

		expect(provider.calls[0]?.temperature).toBe(0)
		expect(provider.calls[0]?.tools).toEqual([])
		expect(provider.calls[0]?.model).toBe('judge')
	})

	test('never tells the judge who produced the work', async () => {
		const provider = createFakeProvider([textResponse('2')])
		await judgeWork({ provider, model: 'judge' }, request)

		const sent = JSON.stringify(provider.calls[0]?.messages)
		expect(sent).not.toContain('orchestrator')
		expect(sent).not.toContain('coder')
	})

	test('reports an unreachable judge rather than scoring zero', async () => {
		const provider = createFakeProvider([{ kind: 'unavailable', message: 'endpoint down' }])
		const result = await judgeWork({ provider, model: 'judge' }, request)
		expect(result.kind).toBe('failed')
		if (result.kind === 'failed') expect(result.message).toContain('endpoint down')
	})

	test('reports a judge that will not give a score', async () => {
		const provider = createFakeProvider([textResponse('no idea')])
		const result = await judgeWork({ provider, model: 'judge' }, request)
		expect(result.kind).toBe('failed')
	})

	test('a tool-calling judge is still scored on its content', async () => {
		const provider = createFakeProvider([{ kind: 'success', response: { content: '1', toolCalls: [call('c', 'x', {})], usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }, finishReason: 'tool_calls' } }])
		const result = await judgeWork({ provider, model: 'judge' }, request)
		expect(result.kind).toBe('ok')
	})
})
