// Runs one watched command, detached from Pi so the command outlives a restarted conversation (Desk restarts idle
// conversations to update them). Output goes to the log file; when the command ends, its status goes to the exit file,
// which pi-watch reads instead of waiting on the process. At the watch's expiry, or on SIGTERM, the command's whole
// process tree is stopped.
import { spawn } from "node:child_process";
import { openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const spec = JSON.parse(readFileSync(process.argv[2], "utf8"));
const output = openSync(spec.log, "a");
const viaStdin = spec.transport === "stdin";
const child = spawn(spec.shell, viaStdin ? spec.args : [...spec.args, spec.command], {
	cwd: spec.cwd, stdio: [viaStdin ? "pipe" : "ignore", output, output], windowsHide: true,
	// Its own process group, so stopping it reaches everything it started.
	detached: process.platform !== "win32",
});
if (viaStdin) child.stdin.end(spec.command);

let ended = false, stopping;
function end(status) {
	if (ended) return;
	ended = true;
	try {
		writeFileSync(`${spec.exit}.tmp`, JSON.stringify({ ...status, at: Date.now() }));
		renameSync(`${spec.exit}.tmp`, spec.exit);
	} finally { process.exit(0); }
}
function stop(reason) {
	if (stopping) return;
	stopping = reason;
	if (process.platform === "win32") {
		spawn(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/F", "/T", "/PID", String(child.pid)],
			{ stdio: "ignore", windowsHide: true }).once("error", () => {});
	} else {
		try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
	}
	setTimeout(() => end({ stopped: reason }), 2_000).unref();
}

child.once("error", error => end({ error: error.message }));
child.once("exit", (code, signal) => end(stopping ? { stopped: stopping } : { code, signal }));
setTimeout(() => stop("expired"), Math.max(0, spec.expires - Date.now()));
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => stop("stopped"));
