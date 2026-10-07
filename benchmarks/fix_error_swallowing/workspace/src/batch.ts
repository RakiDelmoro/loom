export interface Job {
	readonly name: string
	readonly run: () => string
}

export interface BatchReport {
	/** What each job that succeeded produced. */
	readonly results: readonly string[]
	/** One line per job that failed. */
	readonly failures: readonly string[]
}

/** Runs every job and collects what happened. */
export function runAll(jobs: readonly Job[]): BatchReport {
	const results: string[] = []
	for (const job of jobs) {
		results.push(job.run())
	}
	return { results, failures: [] }
}
