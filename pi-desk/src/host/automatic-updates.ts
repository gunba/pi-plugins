import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { SessionView } from "../shared/protocol.ts";
import type { UiConversation } from "../../../pi-ui/index.ts";
import { atomicJson } from "../../manage/store.ts";

const run = promisify(execFile);

/** Whether this computer updates Desk itself and moves idle conversations onto it without being asked. */
export interface AutomaticUpdates { host: boolean; conversations: boolean }
const FILE = "automatic-updates.json";

/** How long everything must have been quiet before an automatic restart. */
export const QUIET_MS = 10 * 60_000;
/** Children a worker starts this soon after itself are its MCP servers and helpers, not running commands. */
const STARTUP_CHILD_MS = 60_000;

export function readAutomatic(directory: string): AutomaticUpdates {
	try {
		const value = JSON.parse(readFileSync(join(directory, FILE), "utf8")) as Partial<AutomaticUpdates>;
		return { host: value.host !== false, conversations: value.conversations !== false };
	} catch { return { host: true, conversations: true }; }
}
export function writeAutomatic(directory: string, value: AutomaticUpdates): void {
	atomicJson(join(directory, FILE), { host: value.host, conversations: value.conversations });
}

/**
 * Why a restart could interrupt this conversation now; empty when it is idle with nothing in flight.
 * A restart ends the worker process, so anything that lives only in it would be lost.
 */
export function restartBlockers(view: SessionView, pendingInputs: boolean): string[] {
	const snapshot = view.snapshot, ui = view.ui, reasons: string[] = [];
	if (view.state !== "ready" || !snapshot) return ["not running"];
	if (snapshot.activity !== "idle") reasons.push(snapshot.activity === "waiting" ? "waiting for an answer" : snapshot.activity === "error" ? "needs attention" : "working");
	if (ui?.interactions.length) reasons.push("has an open question");
	if (snapshot.queue.steering.count || snapshot.queue.followUp.count || pendingInputs) reasons.push("has messages waiting");
	if (view.controls?.some(control => control.state === "running")) reasons.push("is changing a setting");
	// Child agents run inside the parent's worker.
	if (ui?.views.some(item => item.kind === "conversation" && (item.data as UiConversation | undefined)?.active)) reasons.push("has agents working");
	// An automatic plan is disarmed by a restart, which would stop its next round.
	if (ui?.views.some(item => item.id === "plan" && /"Continuation","value":"[^"]*\barmed\b/.test(JSON.stringify(item.data ?? ""))))
		reasons.push("has an automatic plan running");
	if (!existsSync(view.cwd)) reasons.push("its folder is missing");
	return reasons;
}

/** Whether a worker has child processes it started after its own start: commands still running, which a restart would end. */
export async function workerHasRunningCommands(pid: number): Promise<boolean> {
	try {
		if (process.platform === "linux") {
			const started = (target: number) => {
				// Field 22 of /proc/<pid>/stat, counted after the parenthesised command name; clock ticks since boot.
				const stat = readFileSync(`/proc/${target}/stat`, "utf8");
				return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]) * 10;
			};
			const children = readdirSync(`/proc/${pid}/task`).flatMap(task => {
				try { return readFileSync(`/proc/${pid}/task/${task}/children`, "utf8").trim().split(/\s+/).filter(Boolean).map(Number); }
				catch { return []; }
			});
			const self = started(pid);
			return children.some(child => { try { return started(child) - self > STARTUP_CHILD_MS; } catch { return false; } });
		}
		if (process.platform === "win32") {
			const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if (-not $p) { exit 2 }
				Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | ForEach-Object { [int64](($_.CreationDate - $p.CreationDate).TotalMilliseconds) }`;
			const { stdout } = await run(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
				["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 20_000 });
			return stdout.split(/\s+/).filter(Boolean).some(value => Number(value) > STARTUP_CHILD_MS);
		}
		const { stdout } = await run("ps", ["-A", "-o", "pid=,ppid=,etime="], { timeout: 10_000 });
		const seconds = (etime: string) => {
			const [days, clock] = etime.includes("-") ? etime.split("-") as [string, string] : ["0", etime];
			return clock.split(":").map(Number).reduce((total, part) => total * 60 + part, 0) + Number(days) * 86_400;
		};
		const rows = stdout.trim().split("\n").map(line => line.trim().split(/\s+/)).map(([id, parent, age]) => ({ id: Number(id), parent: Number(parent), age: seconds(age!) }));
		const self = rows.find(row => row.id === pid);
		return !self || rows.some(row => row.parent === pid && (self.age - row.age) * 1000 > STARTUP_CHILD_MS);
	} catch {
		// Unknown is treated as busy: skipping a restart is harmless, interrupting work is not.
		return true;
	}
}
