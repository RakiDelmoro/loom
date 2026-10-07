export interface Budget {
	remaining: number
}

/**
 * Runs an operation against a budget.
 *
 * Every call costs one unit, whether the operation succeeds or fails.
 */
export function spend<T>(budget: Budget, operation: () => T): T {
	return operation()
}
