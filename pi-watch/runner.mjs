// Runs a watched command detached from Pi, so it goes on while the conversation is closed or restarted (Desk restarts
// idle conversations to update them, and reopens a closed one when one of these files changes).
// - Once: output goes to the log file; when the command ends, its status goes to the exit file, which pi-watch reads
//   instead of waiting on the process.
// - Every `every` seconds: each run's output, with its exit status when that is not 0, is compared with the previous
//   run's; a different output is written to the change file as the next numbered change, and the first run's output as
//   change 1. At the watch's end, the exit file says so. A change file deleted under it ends it: its conversation was
//   removed.
// At the watch's end, if it has one, or on SIGTERM, the command's whole process tree is stopped.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const spec = JSON.parse(readFileSync(process.argv[2], "utf8"));
const viaStdin = spec.transport === "stdin";
/** Output kept from one run of a repeated command: its end, which is what changes. */
const RUN_CHARS = 16_000;
const RUN_LIMIT_MS = 120_000;

function start(stdout) {
	const child = spawn(spec.shell, viaStdin ? spec.args : [...spec.args, spec.command], {
		cwd: spec.cwd, stdio: [viaStdin ? "pipe" : "ignore", stdout, stdout], windowsHide: true,
		// Its own process group, so stopping it reaches everything it started.
		detached: process.platform !== "win32",
	});
	if (viaStdin) child.stdin.end(spec.command);
	return child;
}
function kill(child) {
	if (!child?.pid) return;
	if (process.platform === "win32") {
		spawn(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/F", "/T", "/PID", String(child.pid)],
			{ stdio: "ignore", windowsHide: true }).once("error", () => {});
	} else {
		try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
	}
}
function atomic(file, value) {
	writeFileSync(`${file}.tmp`, JSON.stringify(value));
	renameSync(`${file}.tmp`, file);
}

let ended = false, stopping, current;
function end(status) {
	if (ended) return;
	ended = true;
	try { atomic(spec.exit, { ...status, at: Date.now() }); } finally { process.exit(0); }
}
function stop(reason) {
	if (stopping) return;
	stopping = reason;
	kill(current);
	setTimeout(() => end({ stopped: reason }), 2_000).unref();
	if (spec.every) end({ stopped: reason });
}

if (spec.every) {
	let previous, number = 0;
	try { ({ hash: previous, number } = JSON.parse(readFileSync(spec.change, "utf8"))); } catch { /* the first run */ }
	const run = () => new Promise(resolve => {
		let output = "", late = false;
		const child = current = start("pipe");
		const take = chunk => { output = (output + chunk.toString("utf8")).slice(-RUN_CHARS); };
		child.stdout.on("data", take);
		child.stderr.on("data", take);
		const limit = Math.min(spec.every * 1000, RUN_LIMIT_MS);
		const timer = setTimeout(() => { late = true; kill(child); }, limit);
		const done = status => {
			clearTimeout(timer);
			const text = output.trim();
			resolve(status ? `${text}${text ? "\n" : ""}(${status})` : text);
		};
		child.once("error", error => done(`could not run: ${error.message}`));
		child.once("close", code => done(late ? `stopped after ${Math.round(limit / 1000)} s` : code === 0 ? "" : `exit code ${code}`));
	});
	const loop = async () => {
		while (!stopping) {
			if (spec.expires !== undefined && Date.now() >= spec.expires) return stop("expired");
			// Desk deletes a removed conversation's wake files (pi-ui UiView.wakeFiles): nothing will read its changes.
			if (number > 0 && !existsSync(spec.change)) return stop("removed");
			const output = await run();
			if (stopping) return;
			const hash = createHash("sha256").update(output).digest("hex").slice(0, 16);
			if (hash !== previous) {
				atomic(spec.change, { number: ++number, hash, output, first: previous === undefined, at: Date.now() });
				previous = hash;
			}
			// Waits in steps of at most a minute: Node's timers stop while a computer sleeps.
			const next = Date.now() + spec.every * 1000;
			while (!stopping && Date.now() < next) await new Promise(resolve => setTimeout(resolve, Math.min(next - Date.now(), 60_000)));
		}
	};
	void loop().catch(error => end({ error: error instanceof Error ? error.message : String(error) }));
} else {
	const child = current = start(openSync(spec.log, "a"));
	child.once("error", error => end({ error: error.message }));
	child.once("exit", (code, signal) => end(stopping ? { stopped: stopping } : { code, signal }));
	// Without an end it runs until it ends or is stopped. The clock is checked each minute: Node's timers stop while a
	// computer sleeps and cannot span more than 24.8 days.
	if (spec.expires !== undefined) {
		const check = () => { if (Date.now() >= spec.expires) stop("expired"); else setTimeout(check, Math.min(spec.expires - Date.now(), 60_000)).unref(); };
		check();
	}
}
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => stop("stopped"));
