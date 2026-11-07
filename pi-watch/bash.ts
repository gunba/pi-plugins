import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";
import { createBashToolDefinition, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, getAgentDir, truncateTail,
	type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { PROGRAM_LIMIT_MS } from "./common.ts";
import type { WatchBackend, WatchSpec } from "./index.ts";

const Parameters = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	wait: Type.Optional(Type.Number({ minimum: 0, description: "Seconds to wait for it to end, at most 60, the default; 0 starts it in the background. Still running then, or when Jordan sends a message, it goes on in the background and you're woken when it ends." })),
	warn: Type.Optional(Type.Number({ minimum: 0, description: "In the background, wake you every this many seconds while it runs, with its progress (default 1800; 0: only at its end)." })),
	progress: Type.Optional(Type.String({ description: "Command printing its progress, such as a count of results; run each minute in the background, its last line is shown to you and Jordan." })),
});
type Params = Static<typeof Parameters>;

const OutputSchema = Type.Object({
	output: Type.String({ description: "Combined stdout and stderr, possibly truncated" }),
	truncated: Type.Boolean(),
	full_output_path: Type.Optional(Type.String({ description: "Full output, when truncated" })),
	exit_code: Type.Union([Type.Number(), Type.Null()], { description: "null while it runs in the background" }),
	wall_time_seconds: Type.Number(),
	running: Type.Optional(Type.String({ description: "The watch it runs under in the background" })),
});

/** WAIT_S: the longest a call waits for its command, and the default; after it the command goes on in the background. */
const WAIT_S = 60, WARN_S = 1800, UPDATE_MS = 500;
/** Calls waiting for their commands; Jordan's message ends each wait, so he never waits behind a command. */
const waiting = new Set<() => void>();
/** What a program receives of the output: all of it up to 1 MiB, else its first and last 512 KiB. */
const STRUCTURED_BYTES = 1 << 20;

function bytes(file: string, start: number, length: number): string {
	const fd = openSync(file, "r");
	try { const buffer = Buffer.alloc(length); return buffer.subarray(0, readSync(fd, buffer, 0, length, start)).toString("utf8"); }
	finally { closeSync(fd); }
}
const sizeOf = (file: string) => { try { return statSync(file).size; } catch { return 0; } };
/** The command's output for a program, and whether part was left out. */
function structured(log: string): { output: string; truncated: boolean } {
	const size = sizeOf(log);
	if (size <= STRUCTURED_BYTES) return { output: bytes(log, 0, size), truncated: false };
	const half = STRUCTURED_BYTES / 2;
	return { output: `${bytes(log, 0, half)}\n… [${formatSize(size - STRUCTURED_BYTES)} omitted] …\n${bytes(log, size - half, half)}`, truncated: true };
}
/** The output's end as the model reads it, as Pi's bash shows it: its last 2,000 lines or 50 KB. */
function tail(log: string): { text: string; truncated: boolean } {
	const size = sizeOf(log), start = Math.max(0, size - DEFAULT_MAX_BYTES * 2);
	const result = truncateTail(bytes(log, start, size - start), { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	const truncated = result.truncated || start > 0;
	return { text: truncated ? `${result.content}\n\n[Showing the last ${formatSize(result.outputBytes)} of ${formatSize(size)}. Full output: ${log}]` : result.content, truncated };
}

/** Pi's environment for bash commands: its bin folder first on PATH, and the session's identity. */
function environment(ctx: ExtensionContext): NodeJS.ProcessEnv {
	const env = { ...process.env }, key = Object.keys(env).find(name => name.toLowerCase() === "path") ?? "PATH", bin = join(getAgentDir(), "bin");
	const delimiter = process.platform === "win32" ? ";" : ":";
	if (!(env[key] ?? "").split(delimiter).includes(bin)) env[key] = [bin, env[key]].filter(Boolean).join(delimiter);
	for (const name of ["PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL", "PI_DESK_BACKGROUND"]) delete env[name];
	env.PI_SESSION_ID = ctx.sessionManager.getSessionId();
	const file = ctx.sessionManager.getSessionFile();
	if (file) env.PI_SESSION_FILE = file;
	if (ctx.model) { env.PI_PROVIDER = ctx.model.provider; env.PI_MODEL = ctx.model.id; }
	return env;
}

/**
 * Desk's bash: the command runs detached, under pi-watch's runner, so it can outlive the call. The call returns when
 * the command ends or after `wait` seconds; a command still running then goes on as a watch, which wakes the agent when
 * it ends and every `warn` seconds with the readings of its `progress` command. Nothing is stopped for taking long:
 * the agent decides, from its progress, whether to stop it.
 */
export function registerBash(pi: ExtensionAPI, current: () => WatchBackend | undefined, labels: Map<string, string>, background = false): void {
	const base = createBashToolDefinition(process.cwd());
	// Steering reaches the agent only once its tool calls return.
	pi.on("input", event => { if (event.streamingBehavior === "steer" && event.source !== "extension") for (const stop of waiting) stop(); });
	pi.registerTool({
		...base,
		description: "Run a bash command in the working directory and return its output and exit code. It may take as long as it needs "
			+ "without holding up your turn: after wait seconds (at most 60), or as soon as Jordan sends a message, one still running goes on in "
			+ "the background and you're woken when it ends, so other work can continue meanwhile. Don't wrap commands in timeout, which "
			+ "only cuts them short. Give progress for long work so you can tell whether it is getting anywhere.",
		parameters: Parameters,
		outputSchema: OutputSchema,
		async execute(id, params: Params, signal, onUpdate, ctx) {
			const label = labels.get(id);
			labels.delete(id);
			const watches = current();
			if (!watches || watches.sessionId !== ctx.sessionManager.getSessionId()) throw new Error("bash is not ready in this conversation.");
			watches.useContext(ctx);
			// In Desk's process for watches' programs, nothing can follow a command after its call: it has the program's time.
			const shell = watches.shell(), started = Date.now(), wait = background ? PROGRAM_LIMIT_MS : Math.min(params.wait ?? WAIT_S, WAIT_S) * 1000;
			const warn = params.warn ?? WARN_S, progress = params.progress?.trim() || undefined;
			const spec: WatchSpec = { id: `b${randomUUID()}`, mode: "output", command: shell.prefix ? `${shell.prefix}\n${params.command}` : params.command,
				cwd: ctx.cwd, created: started, computer: hostname(), ...(label ? { label } : {}),
				bash: { started, ...(warn ? { warn } : {}), ...(progress ? { progress } : {}) } };
			const runner = watches.launch(spec, watches.bashFolder, environment(ctx));
			const log = spec.log!, exit = spec.exit!;
			// The runner exits once the command has ended and its status is in the exit file.
			const ended = new Promise<void>(resolve => { runner.once("exit", () => resolve()); runner.once("error", () => resolve()); });
			let shown = -1;
			const update = onUpdate && setInterval(() => {
				const size = sizeOf(log);
				if (size !== shown) { shown = size; onUpdate({ content: [{ type: "text", text: tail(log).text }], details: undefined }); }
			}, UPDATE_MS);
			let timer: NodeJS.Timeout | undefined, onAbort: (() => void) | undefined, steered: (() => void) | undefined;
			const outcome = await Promise.race([
				ended.then(() => "ended" as const),
				new Promise<"waited">(resolve => { timer = setTimeout(() => resolve("waited"), wait); }),
				new Promise<"steered">(resolve => { steered = () => resolve("steered"); waiting.add(steered); }),
				new Promise<"aborted">(resolve => { onAbort = () => resolve("aborted"); if (signal?.aborted) onAbort(); else signal?.addEventListener("abort", onAbort, { once: true }); }),
			]).finally(() => { clearTimeout(timer); if (update) clearInterval(update); if (onAbort) signal?.removeEventListener("abort", onAbort); waiting.delete(steered!); });
			if (outcome === "aborted") {
				watches.stopRun(spec);
				await Promise.race([ended, new Promise(resolve => setTimeout(resolve, 2_000))]);
				throw new Error(`${tail(log).text}\n\nCommand aborted`.trim());
			}
			if (outcome !== "ended" && !existsSync(exit) && background) {
				watches.stopRun(spec);
				await Promise.race([ended, new Promise(resolve => setTimeout(resolve, 2_000))]);
				throw new Error(`${tail(log).text}\n\nStopped after ${Math.round((Date.now() - started) / 1000)} s: a watch's program can't leave commands running.`.trim());
			}
			if (outcome !== "ended" && !existsSync(exit)) {
				const adopted = watches.adopt({ ...spec, command: params.command });
				const so = tail(log);
				const note = `${outcome === "steered" ? "Jordan sent a message, so this stopped waiting. " : ""}Still running after ${Math.round((Date.now() - started) / 1000)} s; it goes on in the background as watch ${adopted.id}, and you're woken when it ends${warn ? ` and every ${warn >= 60 ? `${Math.round(warn / 60)} min` : `${warn} s`} while it runs` : ""}. Stop it with watch({stop: "${adopted.id}"}). Full output so far: ${log}`;
				return { content: [{ type: "text", text: so.text ? `${so.text}\n\n${note}` : note }], details: {},
					structuredContent: { ...structured(log), exit_code: null, wall_time_seconds: Math.round((Date.now() - started) / 100) / 10, running: adopted.id } };
			}
			if (!existsSync(exit)) throw new Error(`The command's runner ended without its status.${tail(log).text ? `\n\n${tail(log).text}` : ""}`);
			const status = JSON.parse(readFileSync(exit, "utf8")) as { code?: number | null; signal?: string | null; error?: string; stopped?: string };
			const shownOutput = tail(log), data = structured(log), seconds = Math.round((Date.now() - started) / 100) / 10;
			shownOutput.text = shownOutput.text.trimEnd();
			// A fast command leaves nothing behind; a long output's log is its full output.
			for (const file of [exit, join(watches.bashFolder, `${spec.id}.json`), ...(shownOutput.truncated || data.truncated ? [] : [log])]) rmSync(file, { force: true });
			if (status.error) throw new Error(`The command could not start: ${status.error}`);
			const text = shownOutput.text || "(no output)";
			const result = { ...data, ...(data.truncated || shownOutput.truncated ? { full_output_path: log } : {}), exit_code: status.code ?? null, wall_time_seconds: seconds };
			if (status.code === 0) return { content: [{ type: "text", text }], details: {}, structuredContent: result };
			const how = status.signal ? `Command was ended by ${status.signal}` : status.stopped ? `Command was stopped (${status.stopped})` : `Command exited with code ${status.code}`;
			return { content: [{ type: "text", text: `${shownOutput.text ? `${shownOutput.text}\n\n` : ""}${how}` }], details: {}, structuredContent: result, isError: true };
		},
	});
}
