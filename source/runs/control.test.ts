import { describe, expect, test } from 'bun:test'
import { createRunControl } from './control.ts'
import { delay } from '../test-support/clock.ts'

describe('run control', () => {
	test('draining with nothing queued returns nothing', async () => {
		const control = createRunControl()
		expect(await control.drain()).toEqual([])
	})

	test('a steered message is delivered once, at the next drain', async () => {
		const control = createRunControl()
		control.steer('use tabs, not spaces')
		control.steer('and stop after this turn')

		expect(await control.drain()).toEqual(['use tabs, not spaces', 'and stop after this turn'])
		// Delivery is not a replay: the second drain has nothing left to give.
		expect(await control.drain()).toEqual([])
	})

	test('a message sent while the run is held waits for the resume', async () => {
		const control = createRunControl()
		control.pause()
		control.steer('while held')

		const captured: (readonly string[] | null)[] = [null]
		const pending = control.drain().then((messages) => {
			captured[0] = messages
		})

		// Held: drain has not resolved, so nothing has reached the run yet.
		expect(control.paused).toBe(true)
		await Promise.resolve()
		expect(captured[0]).toBeNull()

		control.resume()
		await pending
		expect(captured[0]).toEqual(['while held'])
	})

	test('resuming a run that is not held is harmless', async () => {
		const control = createRunControl()
		control.resume()
		expect(control.paused).toBe(false)
		expect(await control.drain()).toEqual([])
	})

	test('drain waits for each hold in turn', async () => {
		const control = createRunControl()
		control.pause()

		const pending = control.drain()
		await Promise.resolve()
		control.resume()
		control.pause()

		const settled = await Promise.race([
			pending.then(() => 'drained' as const),
			delay(5).then(() => 'still held' as const),
		])
		expect(settled).toBe('still held')

		control.resume()
		control.steer('late')
		expect(await pending).toEqual(['late'])
	})
})
