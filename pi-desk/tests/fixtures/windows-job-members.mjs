import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync } from "node:fs";
import { join, win32 } from "node:path";
import { fileURLToPath } from "node:url";

export async function assertFixtureJobMembers(pids, phase) {
	if (process.platform !== "win32" || !process.env.DESK_HANDOFF_JOB_NAME) return;
	const unique = [...new Set(pids)];
	assert(unique.every(pid => Number.isSafeInteger(pid) && pid > 0));
	const { stdout } = await promisify(execFile)(win32.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
		["-NoProfile", "-NonInteractive", "-File", fileURLToPath(new URL("./windows-handoff-job.ps1", import.meta.url)),
			"-Mode", "Probe", "-JobName", process.env.DESK_HANDOFF_JOB_NAME, "-Pids", unique.join(",")],
		{ windowsHide: true, encoding: "utf8", timeout: 30000, maxBuffer: 128000 });
	const members = JSON.parse(stdout);
	assert.deepEqual(members.map(row => row.pid), unique);
	assert(members.every(row => row.member), "every actor and owned OS child must inherit the same kill-on-close Job");
	writeFileSync(join(process.env.DESK_HANDOFF_JOB_PROOF, phase + ".json"), JSON.stringify({ phase, members }));
}
