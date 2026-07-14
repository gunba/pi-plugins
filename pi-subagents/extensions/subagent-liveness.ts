export type ProgressObservation = {
	taskPath: string;
	progressAt: number;
};

function validTimeout(timeoutMs: number): number {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
		throw new Error("stall timeout must be a positive finite number");
	return timeoutMs;
}

export function stalledProgress<T extends ProgressObservation>(
	observations: readonly T[],
	observedAt: number,
	timeoutMs: number,
): T[] {
	const timeout = validTimeout(timeoutMs);
	return observations.filter(
		(observation) => observedAt - observation.progressAt >= timeout,
	);
}

export function nextProgressDeadline(
	observations: readonly ProgressObservation[],
	timeoutMs: number,
): number | undefined {
	const timeout = validTimeout(timeoutMs);
	let deadline: number | undefined;
	for (const observation of observations) {
		const candidate = observation.progressAt + timeout;
		if (deadline === undefined || candidate < deadline) deadline = candidate;
	}
	return deadline;
}
