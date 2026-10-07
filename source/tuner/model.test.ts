import { describe, expect, test } from 'bun:test'
import { createFakeProvider } from '../model/fake.ts'
import type { ChatResult } from '../model/types.ts'
import { textResponse } from '../test-support/model.ts'
import { createChangeMerger, createHypothesisProposer, extractJson } from './model.ts'

/**
 * The big model's boundary: what the Tuner sends, and what it does with what
 * comes back.
 *
 * A real reasoning model spends part of the output budget thinking before it
 * writes any JSON, so a reply can be *truncated* — which is a different failure
 * from a reply that was never JSON, and one the first real Tuner cycle hit.
 */

const PROPOSAL = {
	blueprint: '{"entryRole": "orchestrator"}',
	failingBenchmarks: [],
	pricedModels: [],
	providers: [],
	editableFiles: ['loom.json'],
}

function truncated(): ChatResult {
	return {
		kind: 'success',
		response: {
			content: '[{"id": "h-001", "motivation": "a very long thou',
			toolCalls: [],
			usage: { inputTokens: 1_000, cachedInputTokens: 0, outputTokens: 32_768 },
			finishReason: 'length',
		},
	}
}

describe('the hypothesis proposer', () => {
	test('a reply cut off at the token ceiling says so, rather than blaming the JSON', () => {
		const propose = createHypothesisProposer({ provider: createFakeProvider([truncated()]), model: 'big' })
		return propose(PROPOSAL).then((result) => {
			expect(result.kind).toBe('failed')
			if (result.kind !== 'failed') return
			// The distinction matters: "not JSON" sends the reader to the prompt,
			// when the answer is the budget.
			expect(result.message).toContain('cut off')
			expect(result.message).not.toContain('did not reply with JSON')
		})
	})

	test('a reply that is not JSON is reported as such', async () => {
		const propose = createHypothesisProposer({
			provider: createFakeProvider([textResponse('I would suggest making the prompts clearer.')]),
			model: 'big',
		})
		const result = await propose(PROPOSAL)
		expect(result.kind).toBe('failed')
		if (result.kind === 'failed') expect(result.message).toBe('the proposer did not reply with JSON')
	})

	test('the request names the files a change may edit, and the Blueprint document itself', async () => {
		// Without this the proposer guesses the Blueprint's filename, writes a file
		// nothing reads, and produces a candidate identical to the baseline.
		const provider = createFakeProvider([textResponse('not json')])
		const propose = createHypothesisProposer({ provider, model: 'big' })
		await propose({
			blueprint: '{}',
			failingBenchmarks: [],
			pricedModels: [],
			providers: [],
			editableFiles: ['loom.json', 'prompts/coder.md'],
		})

		const sent = provider.calls[0]?.messages.find((message) => message.role === 'user')?.content ?? ''
		expect(sent).toContain('loom.json')
		expect(sent).toContain('prompts/coder.md')
		expect(sent).toContain('read by nothing')
	})

	test('the request names the models the deployment prices', async () => {
		const provider = createFakeProvider([textResponse('not json')])
		const propose = createHypothesisProposer({ provider, model: 'big' })
		await propose({
			blueprint: '{}',
			failingBenchmarks: [],
			editableFiles: [],
			pricedModels: ['cheap-model — $0.1 in / $0.2 out per 1M'],
			providers: [],
		})

		const sent = provider.calls[0]?.messages.find((message) => message.role === 'user')?.content ?? ''
		expect(sent).toContain('cheap-model — $0.1 in / $0.2 out per 1M')
	})

	test('the request names the providers, not only the models', async () => {
		// A routing profile is a {provider, model} pair and the price table is a flat
		// list, so models without providers invite a pairing nothing serves.
		const provider = createFakeProvider([textResponse('not json')])
		const propose = createHypothesisProposer({ provider, model: 'big' })
		await propose({
			blueprint: '{}',
			failingBenchmarks: [],
			editableFiles: [],
			providers: ['local', 'together'],
			pricedModels: [],
		})

		const sent = provider.calls[0]?.messages.find((message) => message.role === 'user')?.content ?? ''
		expect(sent).toContain('local')
		expect(sent).toContain('together')
	})

	test('a fenced JSON reply is accepted', async () => {
		const hypothesis = {
			id: 'h-001',
			motivation: 'give the coder its own tree',
			mechanism: 'set isolation to worktree on the coder role',
			predictedImpact: 'sibling coders stop colliding, so flaky runs drop',
			changes: [{ path: 'loom.json', content: '{}' }],
		}
		const propose = createHypothesisProposer({
			provider: createFakeProvider([textResponse('```json\n' + JSON.stringify([hypothesis]) + '\n```')]),
			model: 'big',
		})
		const result = await propose(PROPOSAL)
		expect(result.kind).toBe('ok')
		if (result.kind === 'ok') expect(result.value.map((entry) => entry.id)).toEqual(['h-001'])
	})

	test('a model that cannot be reached fails the cycle rather than throwing', async () => {
		const propose = createHypothesisProposer({
			provider: createFakeProvider([{ kind: 'unavailable', message: 'endpoint down' }]),
			model: 'big',
		})
		const result = await propose(PROPOSAL)
		expect(result.kind).toBe('failed')
		if (result.kind === 'failed') expect(result.message).toContain('endpoint down')
	})
})

describe('the change merger', () => {
	test('a truncated merge is named as truncation too', async () => {
		const merge = createChangeMerger({ provider: createFakeProvider([truncated()]), model: 'big' })
		const result = await merge({ baseline: '{}', candidates: [{ id: 'b1', motivation: 'm', changes: [] }] })
		expect(result.kind).toBe('failed')
		if (result.kind === 'failed') expect(result.message).toContain('cut off')
	})
})

describe('extractJson', () => {
	test('reads a bare value and a fenced one, and refuses prose around one', () => {
		expect(extractJson('{"a": 1}')).toEqual({ a: 1 })
		expect(extractJson('```json\n[1, 2]\n```')).toEqual([1, 2])
		// Deliberately narrow. A reply wrapped in prose is a reply that did not
		// follow the instruction, and guessing which brackets are the answer is how
		// a harness starts accepting documents it does not understand.
		expect(extractJson('Here you go:\n[{"id": "h"}]\nHope that helps.')).toBeNull()
	})

	test('returns null rather than throwing on something arbitrary', () => {
		expect(extractJson('')).toBeNull()
		expect(extractJson('no structured output here')).toBeNull()
	})
})
