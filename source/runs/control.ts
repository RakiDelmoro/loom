/**
 * The run control channel: what an operator can do to a run that is already going.
 *
 * A run is single-threaded and synchronous between turns, so control is not
 * pre-emption — it is a **safe point**. The operator's message and the hold both
 * take effect at the top of the next turn, which is the only place the engine can
 * accept them without leaving a conversation half-sent.
 *
 * Draining is where the two meet: it blocks while the run is held, then hands
 * over everything queued since the last turn.
 */

export interface RunControl {
	/** Queue a message for the run's next turn boundary. */
	steer(message: string): void
	/** Hold the run at its next turn boundary. */
	pause(): void
	resume(): void
	readonly paused: boolean
	/** Blocks while held, then returns the queued messages and clears the queue. */
	drain(): Promise<readonly string[]>
}

export function createRunControl(): RunControl {
	const pending: string[] = []
	let paused = false
	let wake: (() => void) | null = null

	return {
		steer(message: string): void {
			pending.push(message)
		},

		pause(): void {
			paused = true
		},

		resume(): void {
			paused = false
			const notify = wake
			wake = null
			notify?.()
		},

		get paused(): boolean {
			return paused
		},

		async drain(): Promise<readonly string[]> {
			while (paused) {
				// The resolver is stored before the await, so a resume that arrives
				// while held always finds something to wake.
				const { promise, resolve } = Promise.withResolvers<void>()
				wake = resolve
				await promise
			}
			const messages = [...pending]
			pending.length = 0
			return messages
		},
	}
}
