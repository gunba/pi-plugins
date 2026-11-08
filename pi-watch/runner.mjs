// Runs watched commands detached from Pi and Desk, so they go on while a conversation is closed or restarted and while
// Desk restarts or updates (Desk restarts idle conversations to update them, and reopens a closed one when one of these
// files changes).
//
// One process runs the commands of an agent folder: `node runner.mjs --service <folder>`, where <folder> is
// <agent folder>/watch/runner-1 (common.ts runnerFolder). Commands come as files in its jobs folder: <run>.json starts
// one, and the process answers with <run>.taken, holding its process ID; <run>.stop stops it. It takes a job by
// renaming its file, so a job runs once however many processes look. One process holds the folder's lock; it ends after
// a minute without jobs, or when the folder is removed. `node runner.mjs <job file>` runs one command alone, for when
// that process doesn't answer.
//
// A command runs:
// - Once: output goes to the log file; when the command ends, its status goes to the exit file, which pi-watch reads
//   instead of waiting on a process.
// - Every `every` seconds: each run's output, with its exit status when that is not 0, is compared with the previous
//   run's; a different output is written to the change file as the next numbered change, and the first run's output as
//   change 1. At its end, the exit file says so. A change file deleted under it ends it: its conversation was removed.
// At a command's end, if it has one, or when it is stopped, its whole process tree is stopped.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

// When memory runs out where the runner shares a memory limit with Pi (Desk's service), the kernel kills the
// highest-scored process: the watched commands and the runner rather than Pi, whose processes keep the default.
if (process.platform === "linux") try { writeFileSync("/proc/self/oom_score_adj", "800"); } catch { /* Left as inherited. */ }
/** Output kept from one run of a repeated command: its end, which is what changes. */
const RUN_CHARS = 16_000;
const RUN_LIMIT_MS = 120_000;
/** The runner process ends after this long without jobs. */
const IDLE_MS = 60_000;
/**
 * The jobs folder is read this often. Elsewhere a watch on it also reads it at once; on Windows the watch's handle would
 * keep the folder from being removed.
 */
const SCAN_MS = process.platform === "win32" ? 100 : 500;
/** A stop for a job not taken yet waits this long for it; files nobody collected go after an hour. */
const STOP_WAIT_MS = 60_000, LEFT_MS = 3_600_000;

const errorText = error => error instanceof Error ? error.message : String(error);
function atomic(file, value) {
	writeFileSync(`${file}.tmp`, JSON.stringify(value));
	renameSync(`${file}.tmp`, file);
}
function start(job, stdout) {
	const viaStdin = job.transport === "stdin";
	const child = spawn(job.shell, viaStdin ? job.args : [...job.args, job.command], {
		cwd: job.cwd, stdio: [viaStdin ? "pipe" : "ignore", stdout, stdout], windowsHide: true, ...(job.env ? { env: job.env } : {}),
		// Its own process group, so stopping it reaches everything it started.
		detached: process.platform !== "win32",
	});
	if (viaStdin) { child.stdin.once("error", () => {}); child.stdin.end(job.command); }
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

/** Runs one job. `done` is called once, after its exit file is written. */
function run(job, done) {
	let ended = false, stopping, current;
	const end = status => {
		if (ended) return;
		ended = true;
		try { atomic(job.exit, { ...status, at: Date.now() }); } catch { /* its folder is gone */ }
		done();
	};
	const stop = reason => {
		if (stopping || ended) return;
		stopping = reason;
		kill(current);
		if (job.every) end({ stopped: reason });
		else setTimeout(() => end({ stopped: reason }), 2_000);
	};
	if (job.every) {
		let previous, number = 0;
		try { ({ hash: previous, number } = JSON.parse(readFileSync(job.change, "utf8"))); } catch { /* the first run */ }
		const once = () => new Promise(resolve => {
			let output = "", late = false;
			const child = current = start(job, "pipe");
			const take = chunk => { output = (output + chunk.toString("utf8")).slice(-RUN_CHARS); };
			child.stdout.on("data", take);
			child.stderr.on("data", take);
			const limit = Math.min(job.every * 1000, RUN_LIMIT_MS);
			const timer = setTimeout(() => { late = true; kill(child); }, limit);
			const finished = status => {
				clearTimeout(timer);
				const text = output.trim();
				resolve(status ? `${text}${text ? "\n" : ""}(${status})` : text);
			};
			child.once("error", error => finished(`could not run: ${error.message}`));
			child.once("close", code => finished(late ? `stopped after ${Math.round(limit / 1000)} s` : code === 0 ? "" : `exit code ${code}`));
		});
		const loop = async () => {
			while (!stopping) {
				if (job.expires !== undefined && Date.now() >= job.expires) return stop("expired");
				// Desk deletes a removed conversation's wake files (pi-ui UiView.wakeFiles): nothing will read its changes.
				if (number > 0 && !existsSync(job.change)) return stop("removed");
				const output = await once();
				if (stopping) return;
				const hash = createHash("sha256").update(output).digest("hex").slice(0, 16);
				if (hash !== previous) {
					atomic(job.change, { number: ++number, hash, output, first: previous === undefined, at: Date.now() });
					previous = hash;
				}
				// Waits in steps of at most a minute: Node's timers stop while a computer sleeps.
				const next = Date.now() + job.every * 1000;
				while (!stopping && Date.now() < next) await new Promise(resolve => setTimeout(resolve, Math.min(next - Date.now(), 60_000)));
			}
		};
		void loop().catch(error => end({ error: errorText(error) }));
	} else {
		try {
			// Write mode, not append: on Windows an append-mode handle allows appending only, which MSYS programs (Git Bash)
			// cannot write to. pi-watch has just created the log empty, and one handle serves both streams.
			const log = openSync(job.log, "w");
			try { current = start(job, log); } finally { closeSync(log); }
		} catch (error) {
			end({ error: errorText(error) });
			return { stop };
		}
		current.once("error", error => end({ error: error.message }));
		current.once("exit", (code, signal) => end(stopping ? { stopped: stopping } : { code, signal }));
		// Without an end it runs until it ends or is stopped. The clock is checked each minute: Node's timers stop while a
		// computer sleeps and cannot span more than 24.8 days.
		if (job.expires !== undefined) {
			const check = () => { if (ended) return; if (Date.now() >= job.expires) stop("expired"); else setTimeout(check, Math.min(job.expires - Date.now(), 60_000)).unref(); };
			check();
		}
	}
	return { stop };
}

/**
 * The folder's lock, held while this process lives: an SQLite lock, or on Windows a named pipe, so no file stays open in
 * it. Undefined when another process has it. The caller keeps what it returns: collected, it would let the lock go.
 */
async function lock(folder) {
	if (process.platform === "win32") {
		const pipe = `\\\\.\\pipe\\pi-watch-${createHash("sha256").update(folder.toLowerCase()).digest("hex").slice(0, 32)}`;
		for (let tries = 0; tries < 20; tries++) {
			const server = createServer(socket => socket.destroy());
			if (await new Promise(resolve => { server.once("error", () => resolve(false)); server.listen(pipe, () => resolve(true)); })) return server;
			await new Promise(resolve => setTimeout(resolve, 100));
		}
		return undefined;
	}
	try {
		const { DatabaseSync } = await import("node:sqlite");
		const db = new DatabaseSync(join(folder, "lock"), { timeout: 2_000 });
		db.exec("PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE");
		return db;
	} catch { return undefined; }
}

/** The folder's lock, for as long as this process runs. */
let held;

async function serve(folder) {
	const jobs = join(folder, "jobs"), service = join(folder, "service.json");
	mkdirSync(jobs, { recursive: true, mode: 0o700 });
	held = await lock(folder);
	// Another process has the folder: it takes the jobs.
	if (!held) process.exit(0);
	atomic(service, { pid: process.pid });
	const running = new Map();
	let idle = Date.now();
	const age = file => { try { return Date.now() - statSync(file).mtimeMs; } catch { return 0; } };
	const take = name => {
		const id = name.slice(0, -".json".length), taking = join(jobs, `${id}.taking`);
		// Taken back by the client that wrote it, or by another process.
		try { renameSync(join(jobs, name), taking); } catch { return; }
		let job;
		try { job = JSON.parse(readFileSync(taking, "utf8")); } catch { return; } finally { rmSync(taking, { force: true }); }
		// A command that can't start ends at once, before it would be counted as running.
		let ended = false;
		const handle = run(job, () => { ended = true; running.delete(id); });
		if (!ended) running.set(id, handle);
		atomic(join(jobs, `${id}.taken`), { pid: process.pid });
	};
	const leave = () => {
		// A job written since the last look was written for this process: it stays for it.
		atomic(service, { pid: process.pid, closing: true });
		if (readdirSync(jobs).some(name => name.endsWith(".json"))) { atomic(service, { pid: process.pid }); idle = Date.now(); return; }
		try { if (JSON.parse(readFileSync(service, "utf8")).pid === process.pid) rmSync(service, { force: true }); } catch { /* gone */ }
		process.exit(0);
	};
	const scan = () => {
		let names;
		try { names = readdirSync(jobs); } catch {
			// The folder was removed: nothing more will come.
			if (!running.size) process.exit(0);
			return;
		}
		for (const name of names) if (name.endsWith(".json")) take(name);
		for (const name of names) {
			const file = join(jobs, name);
			if (name.endsWith(".stop")) {
				const job = running.get(name.slice(0, -".stop".length));
				if (job) { rmSync(file, { force: true }); job.stop("stopped"); }
				else if (age(file) > STOP_WAIT_MS) rmSync(file, { force: true });
			} else if (!name.endsWith(".json") && age(file) > LEFT_MS) rmSync(file, { force: true });
		}
		if (running.size) idle = Date.now();
		else if (Date.now() - idle > IDLE_MS) leave();
	};
	const look = () => { try { scan(); } catch { /* the next look */ } };
	if (process.platform !== "win32") try { watch(jobs, look).on("error", () => {}); } catch { /* the timer still looks */ }
	setInterval(look, SCAN_MS);
	look();
	for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => {
		for (const job of running.values()) job.stop("stopped");
		setTimeout(() => process.exit(0), 2_500);
	});
}

if (process.argv[2] === "--service") {
	process.chdir(homedir());
	await serve(process.argv[3]);
} else {
	const { stop } = run(JSON.parse(readFileSync(process.argv[2], "utf8")), () => process.exit(0));
	for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => stop("stopped"));
}
