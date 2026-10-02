import fs from "node:fs";
import timers from "node:timers/promises";

const syncDelays = [20, 40, 80, 160, 320];
const directoryDelays = [250, 500, 1000, 2000];
const sleeper = new Int32Array(new SharedArrayBuffer(4));

/** Retry only Windows access/busy failures, without deleting or copying over the destination. */
export function retryablePublicationError(error: unknown): boolean {
	return process.platform === "win32" && ["EPERM", "EBUSY"].includes((error as NodeJS.ErrnoException)?.code ?? "");
}

export function publishFileSync(temporary: string, destination: string): void {
	for (let attempt = 0; ; attempt++) {
		try { fs.renameSync(temporary, destination); return; }
		catch (error) {
			if (!retryablePublicationError(error) || attempt === syncDelays.length) throw error;
			Atomics.wait(sleeper, 0, 0, syncDelays[attempt]!);
		}
	}
}

export async function publishDirectory(temporary: string, destination: string, progress?: (message: string) => void): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try { await fs.promises.rename(temporary, destination); return; }
		catch (error) {
			if (!retryablePublicationError(error) || attempt === directoryDelays.length) throw error;
			progress?.(`Windows blocked runtime publication; retry ${attempt + 1}/${directoryDelays.length}.`);
			await timers.setTimeout(directoryDelays[attempt]!);
		}
	}
}
