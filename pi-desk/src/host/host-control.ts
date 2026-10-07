import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ReleaseInfo } from "../shared/release.ts";

export interface HostRecord {
	version: 1; instance: string; secret: string; pid: number; started: number; origin: string;
}
export interface HostStatus {
	release: ReleaseInfo;
	instance: string; pid: number; started: number; origin: string; stopping: boolean;
	cwd: string; agentDir: string; sessionDir?: string;
	runtime?: string;
	supervisor?: string;
	checkpoint?: import("./checkpoints.ts").CheckpointStatus;
	restore?: { id: string; pending: boolean; failures: number };
	sessions: { active: number; working: number; questions: number };
	relay?: { state: string; origin: string; appOrigin: string; error?: string };
}
export function readHostRecord(directory: string): HostRecord | undefined {
	let text: string;
	try { text = readFileSync(join(directory, "host.json"), "utf8"); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
	const invalid = () => new Error("Invalid host.json. With the host stopped, remove this runtime record and start again.");
	let value: HostRecord;
	try { value = JSON.parse(text) as HostRecord; } catch { throw invalid(); }
	if (!value || typeof value !== "object" || value.version !== 1 || !/^[a-f0-9-]{36}$/.test(value.instance) || !/^[a-f0-9]{64}$/.test(value.secret)
		|| !Number.isSafeInteger(value.pid) || value.pid <= 0 || !/^http:\/\/127\.0\.0\.1:\d+$/.test(value.origin)) {
		throw invalid();
	}
	return value;
}
export function removeHostRecord(directory: string, instance: string): void {
	if (readHostRecord(directory)?.instance === instance) unlinkSync(join(directory, "host.json"));
}
export class HostControl {
	readonly record: HostRecord;
	constructor(origin: string) {
		this.record = { version: 1, instance: randomUUID(), secret: randomBytes(32).toString("hex"),
			pid: process.pid, started: Date.now(), origin };
	}
	authenticate(token: string): boolean {
		return /^[a-f0-9]{64}$/.test(token) && timingSafeEqual(Buffer.from(token, "hex"), Buffer.from(this.record.secret, "hex"));
	}
	publish(directory: string): void {
		const file = join(directory, "host.json"), temporary = `${file}.${this.record.instance}.tmp`;
		writeFileSync(temporary, `${JSON.stringify(this.record)}\n`, { flag: "wx", mode: 0o600 });
		renameSync(temporary, file);
	}
}
