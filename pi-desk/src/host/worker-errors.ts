export class WorkerConnectionError extends Error {}
export class StaleGeneration extends Error {
	constructor() { super("The session changed. Refresh and check its history before trying again."); }
}
export class WorkerCommandError extends Error {}
export class ReceiptConflict extends Error {}
