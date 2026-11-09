export class WorkerConnectionError extends Error {}
/** The conversation's recorded worker still holds it but did not answer; only the user decides to stop it (worker-registry.ts). */
export class WorkerUnresponsiveError extends WorkerConnectionError {}
export class StaleGeneration extends Error {
	constructor() { super("The session changed. Refresh and check its history before trying again."); }
}
export class WorkerCommandError extends Error {}
export class ReceiptConflict extends Error {}
