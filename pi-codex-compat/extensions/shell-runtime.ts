import {
	spawn,
	type ChildProcessWithoutNullStreams,
	type SpawnOptions,
} from "node:child_process";
import { mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
	getShellConfig,
	type AgentToolResult,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export type ShellCommandParams = {
	command: string;
	workdir?: string;
	shell?: string;
	timeout_ms?: number;
	timeout?: number;
	login?: boolean;
	yield_time_ms?: number;
	max_output_tokens?: number;
};

export type WriteStdinParams = {
	session_id: number;
	chars?: string;
	yield_time_ms?: number;
	max_output_tokens?: number;
};

export type ShellCommandDetails = {
	output: string;
	command: string;
	workdir: string;
	session_id?: number;
	exit_code?: number | null;
	signal?: NodeJS.Signals | null;
	running: boolean;
	timed_out?: boolean;
	aborted?: boolean;
	interrupted?: boolean;
	truncated?: boolean;
	full_output_path?: string;
	log_error?: string;
	error?: string;
};

type PiToolResult<T> = AgentToolResult<T> & { isError?: boolean };
export type ShellUpdate = (
	result: AgentToolResult<ShellCommandDetails | undefined>,
) => void;
export type ShellExecutionContext = Pick<ExtensionContext, "cwd">;

type TerminationReason = "timeout" | "abort" | "interrupt" | "shutdown";

type ShellSession = {
	id: number;
	command: string;
	workdir: string;
	child: ChildProcessWithoutNullStreams;
	output: string;
	outputStartOffset: number;
	readOffset: number;
	exitCode?: number | null;
	exitSignal?: NodeJS.Signals | null;
	closed: boolean;
	error?: string;
	timedOut?: boolean;
	aborted?: boolean;
	interrupted?: boolean;
	terminationReason?: TerminationReason;
	timeout?: ReturnType<typeof setTimeout>;
	forceKillTimeout?: ReturnType<typeof setTimeout>;
	outputListeners: Set<() => void>;
	logDirectory: string;
	logPath: string;
	logFile: FileHandle;
	logWrites: Promise<void>;
	logClose?: Promise<void>;
	logError?: string;
	preserveLog: boolean;
	released: boolean;
};

export type ShellLaunch = {
	shell: string;
	args: string[];
	commandFromStdin: boolean;
};

export type ProcessTreeDependencies = {
	platform: NodeJS.Platform;
	spawnTaskkill: (
		command: string,
		args: string[],
		options: SpawnOptions,
	) => { unref?: () => void };
	kill: (pid: number, signal: NodeJS.Signals) => void;
};

const DEFAULT_SESSION_YIELD_MS = 1_000;
const SESSION_OUTPUT_MAX_CHARS = 1_000_000;
const DEFAULT_OUTPUT_MAX_CHARS = 50_000;
const DEFAULT_OUTPUT_MAX_LINES = 2_000;
const OUTPUT_UPDATE_THROTTLE_MS = 100;
const FORCE_KILL_DELAY_MS = 1_000;
const SHUTDOWN_WAIT_MS = 2_000;

let nextShellSessionId = 1;
const shellSessions = new Map<number, ShellSession>();

const defaultProcessTreeDependencies: ProcessTreeDependencies = {
	platform: process.platform,
	spawnTaskkill: (command, args, options) => spawn(command, args, options),
	kill: (pid, signal) => process.kill(pid, signal),
};

function shellArguments(
	shellPath: string,
	command: string,
	login: boolean | undefined,
): string[] {
	const name = basename(shellPath).toLowerCase().replace(/\.exe$/, "");
	if (/^(?:bash|zsh|sh|dash|ksh|fish)$/.test(name)) {
		return [login ? "-lc" : "-c", command];
	}
	if (name === "powershell" || name === "pwsh") {
		return [
			"-NoLogo",
			...(login ? [] : ["-NoProfile"]),
			"-Command",
			command,
		];
	}
	if (name === "cmd") {
		return [...(login ? [] : ["/d"]), "/s", "/c", command];
	}
	return [command];
}

export function resolveShellLaunch(
	params: Pick<ShellCommandParams, "command" | "login" | "shell">,
	resolveDefaultShell: typeof getShellConfig = getShellConfig,
): ShellLaunch {
	const explicitShell = params.shell?.trim();
	if (explicitShell) {
		return {
			shell: explicitShell,
			args: shellArguments(explicitShell, params.command, params.login),
			commandFromStdin: false,
		};
	}

	const shellConfig = resolveDefaultShell();
	if (shellConfig.commandTransport === "stdin") {
		return {
			shell: shellConfig.shell,
			args: shellConfig.args,
			commandFromStdin: true,
		};
	}
	return {
		shell: shellConfig.shell,
		args: shellArguments(shellConfig.shell, params.command, params.login),
		commandFromStdin: false,
	};
}

export function terminateProcessTree(
	pid: number,
	signal: NodeJS.Signals,
	force: boolean,
	dependencies: ProcessTreeDependencies = defaultProcessTreeDependencies,
): void {
	if (dependencies.platform === "win32") {
		try {
			const taskkill = dependencies.spawnTaskkill(
				"taskkill",
				[
					"/PID",
					String(pid),
					"/T",
					...(force ? ["/F"] : []),
				],
				{
					stdio: "ignore",
					detached: true,
					windowsHide: true,
				},
			);
			taskkill.unref?.();
		} catch {
			// The process may already have exited.
		}
		return;
	}

	try {
		dependencies.kill(-pid, signal);
	} catch {
		try {
			dependencies.kill(pid, signal);
		} catch {
			// The process may already have exited.
		}
	}
}

function timeoutMilliseconds(
	params: Pick<ShellCommandParams, "timeout_ms" | "timeout">,
): number | undefined {
	const raw =
		params.timeout_ms ??
		(params.timeout !== undefined ? params.timeout * 1000 : undefined);
	if (raw === undefined || !Number.isFinite(raw) || raw <= 0) return undefined;
	return Math.ceil(raw);
}

function positiveMilliseconds(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? Math.ceil(value)
		: fallback;
}

function maxOutputChars(maxOutputTokens: unknown): number {
	if (
		typeof maxOutputTokens !== "number" ||
		!Number.isFinite(maxOutputTokens) ||
		maxOutputTokens <= 0
	) {
		return DEFAULT_OUTPUT_MAX_CHARS;
	}
	return Math.max(1_000, Math.ceil(maxOutputTokens * 4));
}

export function truncateShellOutput(
	output: string,
	maxChars: number,
	sourcePrefixMissing = false,
): { output: string; truncated: boolean } {
	const lines = output.split("\n");
	let text =
		lines.length > DEFAULT_OUTPUT_MAX_LINES
			? lines.slice(-DEFAULT_OUTPUT_MAX_LINES).join("\n")
			: output;
	let truncated = sourcePrefixMissing || text !== output;
	if (text.length > maxChars) {
		text = text.slice(text.length - maxChars);
		truncated = true;
	}
	return {
		output: truncated ? `[output truncated; showing tail]\n${text}` : text,
		truncated,
	};
}

function isSessionDone(session: ShellSession): boolean {
	return session.closed || session.error !== undefined;
}

function isSessionRunning(session: ShellSession): boolean {
	return !isSessionDone(session) && session.terminationReason === undefined;
}

function currentOutputOffset(session: ShellSession): number {
	return session.outputStartOffset + session.output.length;
}

function outputSince(
	session: ShellSession,
	absoluteOffset: number,
): { output: string; sourcePrefixMissing: boolean } {
	const sourcePrefixMissing = absoluteOffset < session.outputStartOffset;
	const start = Math.max(absoluteOffset, session.outputStartOffset);
	return {
		output: session.output.slice(start - session.outputStartOffset),
		sourcePrefixMissing,
	};
}

function appendSessionOutput(session: ShellSession, chunk: Buffer): void {
	if (chunk.length === 0) return;
	session.logWrites = session.logWrites
		.then(async () => {
			if (session.logError) return;
			await session.logFile.write(chunk);
		})
		.catch((error) => {
			session.logError = error instanceof Error ? error.message : String(error);
		});

	const text = chunk.toString("utf8");
	session.output += text;
	if (session.output.length > SESSION_OUTPUT_MAX_CHARS) {
		const removed = session.output.length - SESSION_OUTPUT_MAX_CHARS;
		session.output = session.output.slice(removed);
		session.outputStartOffset += removed;
		if (session.readOffset < session.outputStartOffset) {
			session.preserveLog = true;
		}
	}
	for (const listener of session.outputListeners) listener();
}

function closeSessionLog(session: ShellSession): Promise<void> {
	session.logClose ??= (async () => {
		await session.logWrites;
		try {
			await session.logFile.close();
		} catch (error) {
			session.logError ??=
				error instanceof Error ? error.message : String(error);
		}
	})();
	return session.logClose;
}

async function cleanupSessionLog(session: ShellSession): Promise<void> {
	if (!isSessionDone(session) || !session.released) return;
	await closeSessionLog(session);
	if (session.preserveLog) return;
	await rm(session.logDirectory, { recursive: true, force: true }).catch(() => {});
}

function releaseSession(session: ShellSession): Promise<void> {
	if (shellSessions.get(session.id) === session) shellSessions.delete(session.id);
	session.released = true;
	return cleanupSessionLog(session);
}

function requestTermination(
	session: ShellSession,
	reason: TerminationReason,
	signal: NodeJS.Signals,
	force = false,
): void {
	if (isSessionDone(session)) return;
	session.terminationReason ??= reason;
	if (reason === "timeout") session.timedOut = true;
	if (reason === "abort") session.aborted = true;
	if (reason === "interrupt") session.interrupted = true;

	const pid = session.child.pid;
	if (!pid) return;
	const forceNow = force || process.platform === "win32";
	terminateProcessTree(pid, forceNow ? "SIGKILL" : signal, forceNow);
	if (forceNow || session.forceKillTimeout) return;
	session.forceKillTimeout = setTimeout(() => {
		if (!isSessionDone(session) && session.child.pid) {
			terminateProcessTree(session.child.pid, "SIGKILL", true);
		}
	}, FORCE_KILL_DELAY_MS);
	session.forceKillTimeout.unref?.();
}

function settleSession(
	session: ShellSession,
	waitMs: number | undefined,
	signal: AbortSignal | undefined,
): Promise<void> {
	if (isSessionDone(session)) return Promise.resolve();
	if (signal?.aborted) {
		requestTermination(session, "abort", "SIGTERM");
		return Promise.resolve();
	}
	return new Promise((resolveDone) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const cleanup = () => {
			if (timer) clearTimeout(timer);
			session.child.off("close", done);
			session.child.off("error", done);
			signal?.removeEventListener("abort", abort);
		};
		const done = () => {
			if (settled) return;
			settled = true;
			cleanup();
			resolveDone();
		};
		const abort = () => {
			requestTermination(session, "abort", "SIGTERM");
			done();
		};
		session.child.once("close", done);
		session.child.once("error", done);
		signal?.addEventListener("abort", abort, { once: true });
		if (waitMs !== undefined) timer = setTimeout(done, waitMs);
	});
}

function buildSessionResult(
	session: ShellSession,
	params: { max_output_tokens?: number },
	output: string,
	sourcePrefixMissing: boolean,
): PiToolResult<ShellCommandDetails> {
	const running = isSessionRunning(session);
	const truncated = truncateShellOutput(
		output,
		maxOutputChars(params.max_output_tokens),
		sourcePrefixMissing,
	);
	if (truncated.truncated) session.preserveLog = true;

	const lines = [truncated.output.trimEnd() || "(no output)"];
	if (running) {
		lines.push(
			`Process running with session ID ${session.id}. Use write_stdin with this session_id to send input or poll output.`,
		);
	} else if (session.timedOut) {
		lines.push("Process timed out.");
	} else if (session.aborted) {
		lines.push("Process aborted.");
	} else if (session.interrupted) {
		lines.push("Process interrupted by Ctrl-C.");
	} else if (session.error) {
		lines.push(`Process failed: ${session.error}`);
	} else {
		lines.push(`Process exited with code ${session.exitCode ?? 0}.`);
	}

	if (truncated.truncated) {
		if (session.logError) {
			lines.push(`Complete output log could not be written: ${session.logError}`);
		} else {
			lines.push(`Full output saved to: ${session.logPath}`);
		}
	}

	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: {
			output: truncated.output,
			command: session.command,
			workdir: session.workdir,
			...(running ? { session_id: session.id } : {}),
			...(session.exitCode !== undefined
				? { exit_code: session.exitCode }
				: {}),
			...(session.exitSignal !== undefined
				? { signal: session.exitSignal }
				: {}),
			running,
			...(session.timedOut ? { timed_out: true } : {}),
			...(session.aborted ? { aborted: true } : {}),
			...(session.interrupted ? { interrupted: true } : {}),
			...(truncated.truncated ? { truncated: true } : {}),
			...(truncated.truncated && !session.logError
				? { full_output_path: session.logPath }
				: {}),
			...(session.logError ? { log_error: session.logError } : {}),
			...(session.error ? { error: session.error } : {}),
		},
		...(session.error || session.timedOut || session.aborted || session.interrupted
			? { isError: true }
			: {}),
	};
}

async function sessionResult(
	session: ShellSession,
	params: { max_output_tokens?: number },
	output: string,
	sourcePrefixMissing: boolean,
): Promise<PiToolResult<ShellCommandDetails>> {
	if (isSessionDone(session)) await closeSessionLog(session);
	return buildSessionResult(session, params, output, sourcePrefixMissing);
}

function createOutputUpdater(
	session: ShellSession,
	startOffset: number,
	params: { max_output_tokens?: number },
	onUpdate: ShellUpdate | undefined,
): { flush: () => void; dispose: () => void } {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let dirty = false;
	let lastUpdateAt = 0;

	const emit = () => {
		if (!onUpdate || !dirty) return;
		dirty = false;
		lastUpdateAt = Date.now();
		const slice = outputSince(session, startOffset);
		onUpdate(
			buildSessionResult(
				session,
				params,
				slice.output,
				slice.sourcePrefixMissing,
			),
		);
	};
	const schedule = () => {
		if (!onUpdate) return;
		dirty = true;
		const delay = OUTPUT_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
		if (delay <= 0) {
			if (timer) clearTimeout(timer);
			timer = undefined;
			emit();
			return;
		}
		timer ??= setTimeout(() => {
			timer = undefined;
			emit();
		}, delay);
	};
	const dispose = () => {
		if (timer) clearTimeout(timer);
		timer = undefined;
		session.outputListeners.delete(schedule);
	};

	if (onUpdate) {
		onUpdate({ content: [], details: undefined });
		session.outputListeners.add(schedule);
	}
	return { flush: emit, dispose };
}

async function createShellSession(
	params: ShellCommandParams,
	workdir: string,
): Promise<ShellSession> {
	const launch = resolveShellLaunch(params);
	const logDirectory = await mkdtemp(join(tmpdir(), "pi-codex-shell-"));
	const logPath = join(logDirectory, "output.log");
	let logFile: FileHandle;
	try {
		logFile = await open(logPath, "wx");
	} catch (error) {
		await rm(logDirectory, { recursive: true, force: true }).catch(() => {});
		throw error;
	}
	let child: ChildProcessWithoutNullStreams;
	try {
		child = spawn(launch.shell, launch.args, {
			cwd: workdir,
			detached: process.platform !== "win32",
			env: process.env,
			stdio: "pipe",
			windowsHide: true,
		});
	} catch (error) {
		await logFile.close().catch(() => {});
		await rm(logDirectory, { recursive: true, force: true }).catch(() => {});
		throw error;
	}

	const session: ShellSession = {
		id: nextShellSessionId++,
		command: params.command,
		workdir,
		child,
		output: "",
		outputStartOffset: 0,
		readOffset: 0,
		closed: false,
		outputListeners: new Set(),
		logDirectory,
		logPath,
		logFile,
		logWrites: Promise.resolve(),
		preserveLog: false,
		released: false,
	};
	shellSessions.set(session.id, session);

	child.stdout.on("data", (chunk: Buffer) =>
		appendSessionOutput(session, chunk),
	);
	child.stderr.on("data", (chunk: Buffer) =>
		appendSessionOutput(session, chunk),
	);
	child.stdin.on("error", () => {});
	child.once("error", (error) => {
		session.error = error instanceof Error ? error.message : String(error);
		void cleanupSessionLog(session);
	});
	child.once("close", (code, exitSignal) => {
		session.closed = true;
		session.exitCode = code;
		session.exitSignal = exitSignal;
		if (session.timeout) clearTimeout(session.timeout);
		if (session.forceKillTimeout) clearTimeout(session.forceKillTimeout);
		void closeSessionLog(session).then(() => cleanupSessionLog(session));
	});

	if (launch.commandFromStdin) child.stdin.end(params.command);

	const hardTimeout = timeoutMilliseconds(params);
	if (hardTimeout !== undefined) {
		session.timeout = setTimeout(
			() => requestTermination(session, "timeout", "SIGTERM"),
			hardTimeout,
		);
		session.timeout.unref?.();
	}
	return session;
}

export async function executeManagedShellCommand(
	params: ShellCommandParams,
	signal: AbortSignal | undefined,
	ctx: ShellExecutionContext,
	onUpdate?: ShellUpdate,
): Promise<PiToolResult<ShellCommandDetails>> {
	const workdir = params.workdir ?? ctx.cwd;
	const session = await createShellSession(params, workdir);
	const startOffset = session.readOffset;
	const updater = createOutputUpdater(session, startOffset, params, onUpdate);
	try {
		const waitMs =
			params.yield_time_ms === undefined
				? undefined
				: positiveMilliseconds(
						params.yield_time_ms,
						DEFAULT_SESSION_YIELD_MS,
					);
		await settleSession(session, waitMs, signal);
		updater.flush();
		const slice = outputSince(session, startOffset);
		session.readOffset = currentOutputOffset(session);
		const result = await sessionResult(
			session,
			params,
			slice.output,
			slice.sourcePrefixMissing,
		);
		if (!result.details?.running) await releaseSession(session);
		return result;
	} finally {
		updater.dispose();
	}
}

export async function executeWriteStdin(
	params: WriteStdinParams,
	signal: AbortSignal | undefined,
	onUpdate?: ShellUpdate,
): Promise<PiToolResult<ShellCommandDetails>> {
	const session = shellSessions.get(params.session_id);
	if (!session) {
		return {
			content: [
				{
					type: "text",
					text: `write_stdin failed: no running shell session ${params.session_id}`,
				},
			],
			details: {
				output: "",
				command: "",
				workdir: "",
				running: false,
				error: "session not found",
			},
			isError: true,
		};
	}

	const startOffset = session.readOffset;
	const updater = createOutputUpdater(session, startOffset, params, onUpdate);
	try {
		if (params.chars?.includes("\u0003")) {
			requestTermination(session, "interrupt", "SIGINT");
		} else if (
			params.chars &&
			!session.child.stdin.destroyed &&
			isSessionRunning(session)
		) {
			session.child.stdin.write(params.chars);
		}

		const waitMs = positiveMilliseconds(
			params.yield_time_ms,
			DEFAULT_SESSION_YIELD_MS,
		);
		await settleSession(session, waitMs, signal);
		updater.flush();
		const slice = outputSince(session, startOffset);
		session.readOffset = currentOutputOffset(session);
		const result = await sessionResult(
			session,
			params,
			slice.output,
			slice.sourcePrefixMissing,
		);
		if (!result.details?.running) await releaseSession(session);
		return result;
	} finally {
		updater.dispose();
	}
}

export async function shutdownShellSessions(): Promise<void> {
	const sessions = [...shellSessions.values()];
	for (const session of sessions) {
		if (session.timeout) clearTimeout(session.timeout);
		requestTermination(session, "shutdown", "SIGKILL", true);
		void releaseSession(session);
	}
	await Promise.all(
		sessions.map((session) =>
			settleSession(session, SHUTDOWN_WAIT_MS, undefined).then(() =>
				cleanupSessionLog(session),
			),
		),
	);
}
