import { createHash, randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync, unlinkSync, realpathSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SourceSnapshot } from "./source.ts";
import { within } from "./source.ts";

export interface RuntimeRelease {
	format: 1; id: string; source: string; digest: string; plugins: string; desk: string; engine: string;
	platform: string; arch: string; node: string; readyAt: string;
}
export interface RuntimeState {
	format: 1; source: string; active?: string; pending?: string; previous?: string;
}
export const validId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const runtimeId = (snapshot: SourceSnapshot): string => createHash("sha256")
	.update(JSON.stringify([1, snapshot.digest, process.platform, process.arch, process.versions.modules])).digest("hex");
export const versionDirectory = (home: string, id: string): string => {
	if (!validId(id)) throw new Error("Invalid runtime identity.");
	return join(home, "versions", id);
};
export function atomicJson(file: string, data: unknown): void {
	const temporary = `${file}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, JSON.stringify(data, null, 2) + "\n", { flag: "wx", mode: 0o600 });
		renameSync(temporary, file);
	} finally { try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
}
export function readState(home: string): RuntimeState | undefined {
	let raw: string;
	try { raw = readFileSync(join(home, "state.json"), "utf8"); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
	const state = JSON.parse(raw) as RuntimeState;
	if (!state || state.format !== 1 || typeof state.source !== "string" || resolve(state.source) !== state.source
		|| state.active !== undefined && !validId(state.active) || state.pending !== undefined && !validId(state.pending)
		|| state.previous !== undefined && !validId(state.previous))
		throw new Error("Invalid managed runtime state.");
	return state;
}
export function readRelease(home: string, id: string): RuntimeRelease {
	const directory = versionDirectory(home, id);
	if (lstatSync(directory).isSymbolicLink() || !within(realpathSync(home), realpathSync(directory))) throw new Error("Runtime directory escaped its installation.");
	const release = JSON.parse(readFileSync(join(directory, "runtime.json"), "utf8")) as RuntimeRelease;
	if (!release || release.format !== 1 || release.id !== id || !validId(release.digest)
		|| release.platform !== process.platform || release.arch !== process.arch
		|| release.node !== process.versions.modules || typeof release.source !== "string" || resolve(release.source) !== release.source
		|| typeof release.readyAt !== "string" || !Number.isFinite(Date.parse(release.readyAt))
		|| ![release.plugins, release.desk, release.engine].every(value => typeof value === "string" && /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(value))
		|| runtimeId({ digest: release.digest } as SourceSnapshot) !== id)
		throw new Error("Runtime is invalid or belongs to a different platform/Node version. Stage it on this computer.");
	for (const name of ["cli.js", "managed.js", "manage-cli.js"]) {
		const entry = join(directory, "source", "pi-desk", "dist", "host", name);
		if (!lstatSync(entry).isFile() || !within(realpathSync(directory), realpathSync(entry))) throw new Error("Runtime entry point is invalid.");
	}
	return release;
}
