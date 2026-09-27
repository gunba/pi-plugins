/** Only expired projections may be rebuilt; filesystem and transport errors are not retried. */
export class ExpiredReference extends Error {}

export async function recoverReference<T>(read: () => T | Promise<T>, restore: () => void): Promise<T> {
	try { return await read(); }
	catch (error) {
		if (!(error instanceof ExpiredReference)) throw error;
		restore();
		return read();
	}
}
