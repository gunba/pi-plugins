import {
	type ChildProcessWithoutNullStreams,
	type SpawnOptions,
	spawn,
} from "node:child_process";
import { randomBytes, randomInt } from "node:crypto";
import { type FileHandle, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
	type AgentToolResult,
	type ExtensionContext,
	getShellConfig,
} from "@earendil-works/pi-coding-agent";

import { CODEX_TOOL_OUTPUT_TOKEN_BUDGET } from "./model-tools.ts";

export type ExecCommandParams = {
	cmd: string;
	workdir?: string;
	shell?: string;
	login?: boolean;
	tty?: boolean;
	yield_time_ms?: number;
	max_output_tokens?: number;
};

export type WriteStdinParams = {
	session_id: number;
	chars?: string;
	yield_time_ms?: number;
	max_output_tokens?: number;
};

export type ExecCommandDetails = {
	output: string;
	cmd: string;
	workdir: string;
	chunk_id: string;
	wall_time_seconds: number;
	original_token_count: number;
	session_id?: number;
	exit_code?: number;
	signal?: NodeJS.Signals;
	running: boolean;
	tty: false;
	aborted?: boolean;
	truncated?: boolean;
	omitted_bytes?: number;
	full_output_path?: string;
	log_error?: string;
	error?: string;
};

export type ExecUpdate = (
	result: AgentToolResult<ExecCommandDetails | undefined>,
) => void;
export type ExecExecutionContext = Pick<ExtensionContext, "cwd">;
export type ExecRuntimeOwner = symbol;

type TerminationReason = "abort" | "prune" | "shutdown";

type ExecSession = {
	id: number;
	owner: ExecRuntimeOwner;
	cmd: string;
	workdir: string;
	child: ChildProcessWithoutNullStreams;
	pendingOutput: HeadTailBuffer;
	exitCode?: number | null;
	exitSignal?: NodeJS.Signals | null;
	closed: boolean;
	error?: string;
	aborted?: boolean;
	terminationReason?: TerminationReason;
	terminationAttempt?: Promise<boolean>;
	terminationError?: string;
	forceKillTimeout?: ReturnType<typeof setTimeout>;
	outputListeners: Set<() => void>;
	logDirectory: string;
	logPath: string;
	logFile: FileHandle;
	logWrites: Promise<void>;
	loggedBytes: number;
	logBackpressureDepth: number;
	logClose?: Promise<void>;
	logError?: string;
	preserveLog: boolean;
	released: boolean;
	shutdownRequested: boolean;
	activeCalls: number;
	lastUsed: number;
};

type ExecCall = {
	chunkId: string;
	startedAt: bigint;
	maxOutputTokens?: number;
};

export type ShellLaunch = {
	shell: string;
	args: string[];
	commandFromStdin: boolean;
};

export type ProcessTreeDependencies = {
	platform: NodeJS.Platform;
	taskkillTimeoutMs?: number;
	spawnTaskkill: (
		command: string,
		args: string[],
		options: SpawnOptions,
	) => {
		unref?: () => void;
		kill?: () => void;
		once?: (
			event: "error" | "exit",
			listener: (value?: unknown) => void,
		) => unknown;
	};
	kill: (pid: number, signal: NodeJS.Signals) => void;
};

export type HeadTailSnapshot = {
	head: Buffer;
	tail: Buffer;
	omittedBytes: number;
	totalBytes: number;
};

export type SessionPruneCandidate = {
	id: number;
	lastUsed: number;
	exited: boolean;
};

type RetainedLogInfo = {
	owner: ExecRuntimeOwner;
	bytes: number;
	lastUsed: number;
};

const INITIAL_YIELD_DEFAULT_MS = 10_000;
const INITIAL_YIELD_MIN_MS = 250;
const INITIAL_YIELD_WINDOWS_MIN_MS = 2_000;
const SESSION_YIELD_MAX_MS = 30_000;
const WRITE_YIELD_DEFAULT_MS = 250;
const WRITE_YIELD_MIN_MS = 250;
const EMPTY_POLL_YIELD_DEFAULT_MS = 5_000;
const EMPTY_POLL_YIELD_MIN_MS = 5_000;
const DEFAULT_BACKGROUND_TERMINAL_MAX_TIMEOUT_MS = 300_000;
export const BACKGROUND_TERMINAL_MAX_TIMEOUT_ENV =
	"PI_CODEX_BACKGROUND_TERMINAL_MAX_TIMEOUT_MS";
export const UNIFIED_EXEC_OUTPUT_MAX_BYTES = 1024 * 1024;
export const DEFAULT_MAX_OUTPUT_TOKENS = CODEX_TOOL_OUTPUT_TOKEN_BUDGET;
export const MAX_UNIFIED_EXEC_PROCESSES = 64;
export const MAX_RETAINED_EXEC_LOGS = 8;
export const MAX_RETAINED_EXEC_LOG_BYTES = 64 * 1024 * 1024;
export const MAX_EXEC_LOG_BYTES = 64 * 1024 * 1024;
const PROTECTED_RECENT_SESSION_COUNT = 8;
const APPROX_BYTES_PER_TOKEN = 4;
const MAX_OUTPUT_TOKENS_POLICY = Math.floor(
	UNIFIED_EXEC_OUTPUT_MAX_BYTES / APPROX_BYTES_PER_TOKEN,
);
const OUTPUT_UPDATE_THROTTLE_MS = 100;
const FORCE_KILL_DELAY_MS = 1_000;
const SHUTDOWN_WAIT_MS = 2_000;
const TASKKILL_WAIT_MS = 2_000;

const UNIFIED_EXEC_ENV_DEFAULTS: Readonly<Record<string, string>> = {
	NO_COLOR: "1",
	TERM: "dumb",
	LANG: "C.UTF-8",
	LC_CTYPE: "C.UTF-8",
	LC_ALL: "C.UTF-8",
	COLORTERM: "",
	PAGER: "cat",
	GIT_PAGER: "cat",
	GH_PAGER: "cat",
	CDPATH: "",
	CODEX_CI: "1",
};

let lastSessionUse = 0;
const execSessions = new Map<number, ExecSession>();
const managedSessions = new Set<ExecSession>();
const managedLogDirectories = new Map<string, ExecRuntimeOwner>();
const retainedLogDirectories = new Map<string, RetainedLogInfo>();
let managerLockTail: Promise<void> = Promise.resolve();
const DEFAULT_EXEC_RUNTIME_OWNER: ExecRuntimeOwner = Symbol(
	"default-exec-runtime",
);
const runtimeOwners = new Set<ExecRuntimeOwner>([DEFAULT_EXEC_RUNTIME_OWNER]);
const activeOperations = new Map<ExecRuntimeOwner, number>();
const activeOperationWaiters = new Map<ExecRuntimeOwner, Set<() => void>>();
const shutdownInProgress = new Map<ExecRuntimeOwner, Promise<void>>();

const defaultProcessTreeDependencies: ProcessTreeDependencies = {
	platform: process.platform,
	spawnTaskkill: (command, args, options) => spawn(command, args, options),
	kill: (pid, signal) => process.kill(pid, signal),
};

async function withManagerLock<T>(operation: () => T | Promise<T>): Promise<T> {
	let releaseLock: () => void = () => {};
	const previous = managerLockTail;
	managerLockTail = new Promise<void>((resolve) => {
		releaseLock = resolve;
	});
	await previous;
	try {
		return await operation();
	} finally {
		releaseLock();
	}
}

export function createExecRuntimeOwner(): ExecRuntimeOwner {
	const owner = Symbol("pi-codex-compat-exec-runtime");
	runtimeOwners.add(owner);
	return owner;
}

function throwIfLaunchAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		throw new Error("exec_command aborted before the process was launched");
	}
}

async function enterExecOperation(
	signal: AbortSignal | undefined,
	owner: ExecRuntimeOwner,
): Promise<() => void> {
	return withManagerLock(() => {
		throwIfLaunchAborted(signal);
		if (!runtimeOwners.has(owner)) {
			throw new Error("Unified Exec runtime is shut down");
		}
		activeOperations.set(owner, (activeOperations.get(owner) ?? 0) + 1);
		let active = true;
		return () => {
			if (!active) return;
			active = false;
			const remaining = (activeOperations.get(owner) ?? 1) - 1;
			if (remaining > 0) {
				activeOperations.set(owner, remaining);
			} else {
				activeOperations.delete(owner);
				for (const resolve of activeOperationWaiters.get(owner) ?? [])
					resolve();
				activeOperationWaiters.delete(owner);
			}
		};
	});
}

function waitForActiveOperations(owner: ExecRuntimeOwner): Promise<void> {
	if ((activeOperations.get(owner) ?? 0) === 0) return Promise.resolve();
	return new Promise((resolve) => {
		let waiters = activeOperationWaiters.get(owner);
		if (!waiters) {
			waiters = new Set();
			activeOperationWaiters.set(owner, waiters);
		}
		waiters.add(resolve);
	});
}

export class HeadTailBuffer {
	readonly maxBytes: number;
	readonly headBudget: number;
	readonly tailBudget: number;
	private head = Buffer.alloc(0);
	private tail = Buffer.alloc(0);
	private omittedBytes = 0;
	private totalBytes = 0;

	constructor(maxBytes = UNIFIED_EXEC_OUTPUT_MAX_BYTES) {
		if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
			throw new Error("HeadTailBuffer maxBytes must be a non-negative integer");
		}
		this.maxBytes = maxBytes;
		this.headBudget = Math.ceil(maxBytes / 2);
		this.tailBudget = Math.floor(maxBytes / 2);
	}

	append(chunk: Uint8Array): void {
		if (chunk.byteLength === 0) return;
		const bytes = Buffer.from(chunk);
		this.totalBytes += bytes.length;
		let offset = 0;
		if (this.head.length < this.headBudget) {
			const take = Math.min(this.headBudget - this.head.length, bytes.length);
			this.head = Buffer.concat([this.head, bytes.subarray(0, take)]);
			offset = take;
		}
		this.appendToTail(bytes.subarray(offset));
	}

	snapshot(): HeadTailSnapshot {
		return {
			head: this.head,
			tail: this.tail,
			omittedBytes: this.omittedBytes,
			totalBytes: this.totalBytes,
		};
	}

	drain(): HeadTailSnapshot {
		const snapshot = this.snapshot();
		this.head = Buffer.alloc(0);
		this.tail = Buffer.alloc(0);
		this.omittedBytes = 0;
		this.totalBytes = 0;
		return snapshot;
	}

	private appendToTail(chunk: Buffer): void {
		if (chunk.length === 0) return;
		if (this.tailBudget === 0) {
			this.omittedBytes += chunk.length;
			return;
		}
		if (chunk.length >= this.tailBudget) {
			this.omittedBytes += this.tail.length + chunk.length - this.tailBudget;
			this.tail = Buffer.from(chunk.subarray(chunk.length - this.tailBudget));
			return;
		}
		const excess = this.tail.length + chunk.length - this.tailBudget;
		if (excess > 0) {
			this.omittedBytes += excess;
			this.tail = Buffer.concat([this.tail.subarray(excess), chunk]);
			return;
		}
		this.tail = Buffer.concat([this.tail, chunk]);
	}
}

export function createUnifiedExecEnvironment(
	base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	return { ...base, ...UNIFIED_EXEC_ENV_DEFAULTS };
}

function normalizedShellName(shellPath: string): string {
	return basename(shellPath).toLowerCase().replace(/\.exe$/, "");
}

function shellArguments(
	shellPath: string,
	cmd: string,
	login: boolean,
): string[] {
	const name = normalizedShellName(shellPath);
	if (/^(?:bash|zsh|sh|dash|ksh|fish)$/.test(name)) {
		return [login ? "-lc" : "-c", cmd];
	}
	if (name === "powershell" || name === "pwsh") {
		return ["-NoLogo", ...(login ? [] : ["-NoProfile"]), "-Command", cmd];
	}
	if (name === "cmd") {
		return [...(login ? [] : ["/d"]), "/s", "/c", cmd];
	}
	return [cmd];
}

function getUnifiedExecDefaultShell(): ReturnType<typeof getShellConfig> {
	const userShell =
		process.platform === "win32"
			? process.env.ComSpec?.trim()
			: process.env.SHELL?.trim();
	return userShell
		? { shell: userShell, args: ["-c"], commandTransport: "argv" }
		: getShellConfig();
}

export function resolveShellLaunch(
	params: Pick<ExecCommandParams, "cmd" | "login" | "shell">,
	resolveDefaultShell: typeof getShellConfig = getUnifiedExecDefaultShell,
): ShellLaunch {
	const login = params.login ?? true;
	const explicitShell = params.shell?.trim();
	if (explicitShell) {
		return {
			shell: explicitShell,
			args: shellArguments(explicitShell, params.cmd, login),
			commandFromStdin: false,
		};
	}

	const shellConfig = resolveDefaultShell();
	if (shellConfig.commandTransport === "stdin") {
		const args = [...shellConfig.args];
		const name = normalizedShellName(shellConfig.shell);
		if (
			login &&
			name === "bash" &&
			!args.includes("-l") &&
			!args.includes("--login")
		) {
			args.unshift("-l");
		}
		return {
			shell: shellConfig.shell,
			args,
			commandFromStdin: true,
		};
	}
	return {
		shell: shellConfig.shell,
		args: shellArguments(shellConfig.shell, params.cmd, login),
		commandFromStdin: false,
	};
}

export function terminateProcessTree(
	pid: number,
	signal: NodeJS.Signals,
	force: boolean,
	dependencies: ProcessTreeDependencies = defaultProcessTreeDependencies,
): Promise<boolean> {
	if (dependencies.platform === "win32") {
		try {
			const taskkill = dependencies.spawnTaskkill(
				"taskkill",
				["/PID", String(pid), "/T", ...(force ? ["/F"] : [])],
				{
					stdio: "ignore",
					detached: true,
					windowsHide: true,
				},
			);
			if (!taskkill.once) {
				taskkill.unref?.();
				return Promise.resolve(true);
			}
			return new Promise((resolveAttempt) => {
				let settled = false;
				const finish = (success: boolean) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					resolveAttempt(success);
				};
				const timer = setTimeout(() => {
					taskkill.kill?.();
					finish(false);
				}, dependencies.taskkillTimeoutMs ?? TASKKILL_WAIT_MS);
				taskkill.once?.("error", () => finish(false));
				taskkill.once?.("exit", (code) => finish(code === 0));
			});
		} catch {
			return Promise.resolve(false);
		}
	}

	try {
		dependencies.kill(-pid, signal);
		return Promise.resolve(true);
	} catch {
		try {
			dependencies.kill(pid, signal);
			return Promise.resolve(true);
		} catch {
			return Promise.resolve(false);
		}
	}
}

function finiteMilliseconds(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? Math.ceil(value)
		: fallback;
}

function validateOptionalNonNegativeInteger(
	value: unknown,
	name: string,
): void {
	if (
		value !== undefined &&
		(!Number.isSafeInteger(value) || (value as number) < 0)
	) {
		throw new Error(`${name} must be a non-negative integer`);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateOptionalString(value: unknown, name: string): void {
	if (value !== undefined && typeof value !== "string") {
		throw new Error(`${name} must be a string`);
	}
}

function validateOptionalBoolean(value: unknown, name: string): void {
	if (value !== undefined && typeof value !== "boolean") {
		throw new Error(`${name} must be a boolean`);
	}
}

/** Reject lossy TypeBox integer coercion before Pi validates the schema. */
export function prepareExecCommandArguments(args: unknown): ExecCommandParams {
	if (!isRecord(args)) return args as ExecCommandParams;
	validateOptionalString(args.cmd, "cmd");
	validateOptionalString(args.workdir, "workdir");
	validateOptionalString(args.shell, "shell");
	validateOptionalBoolean(args.login, "login");
	validateOptionalBoolean(args.tty, "tty");
	validateOptionalNonNegativeInteger(args.yield_time_ms, "yield_time_ms");
	validateOptionalNonNegativeInteger(
		args.max_output_tokens,
		"max_output_tokens",
	);
	return args as ExecCommandParams;
}

/** Reject lossy TypeBox integer coercion before Pi validates the schema. */
export function prepareWriteStdinArguments(args: unknown): WriteStdinParams {
	if (!isRecord(args)) return args as WriteStdinParams;
	if (
		!Number.isSafeInteger(args.session_id) ||
		(args.session_id as number) <= 0
	) {
		throw new Error("session_id must be a positive integer");
	}
	validateOptionalString(args.chars, "chars");
	validateOptionalNonNegativeInteger(args.yield_time_ms, "yield_time_ms");
	validateOptionalNonNegativeInteger(
		args.max_output_tokens,
		"max_output_tokens",
	);
	return args as WriteStdinParams;
}

function validateExecCommandParams(params: ExecCommandParams): void {
	validateOptionalNonNegativeInteger(params.yield_time_ms, "yield_time_ms");
	validateOptionalNonNegativeInteger(
		params.max_output_tokens,
		"max_output_tokens",
	);
}

function validateWriteStdinParams(params: WriteStdinParams): void {
	if (!Number.isSafeInteger(params.session_id) || params.session_id <= 0) {
		throw new Error("session_id must be a positive integer");
	}
	validateOptionalNonNegativeInteger(params.yield_time_ms, "yield_time_ms");
	validateOptionalNonNegativeInteger(
		params.max_output_tokens,
		"max_output_tokens",
	);
}

function clampMilliseconds(
	value: number,
	minimum: number,
	maximum: number,
): number {
	return Math.min(Math.max(value, minimum), maximum);
}

export function resolveBackgroundTerminalMaxTimeoutMilliseconds(
	configured: unknown = process.env[BACKGROUND_TERMINAL_MAX_TIMEOUT_ENV],
): number {
	let parsed = Number.NaN;
	if (typeof configured === "number") {
		parsed = configured;
	} else if (typeof configured === "string" && configured.trim()) {
		parsed = Number(configured);
	}
	if (!Number.isFinite(parsed) || parsed < 0) {
		return DEFAULT_BACKGROUND_TERMINAL_MAX_TIMEOUT_MS;
	}
	return Math.max(EMPTY_POLL_YIELD_MIN_MS, Math.ceil(parsed));
}

export function effectiveExecCommandYieldMilliseconds(
	value: unknown,
	platform: NodeJS.Platform = process.platform,
): number {
	const minimum =
		platform === "win32" ? INITIAL_YIELD_WINDOWS_MIN_MS : INITIAL_YIELD_MIN_MS;
	return clampMilliseconds(
		finiteMilliseconds(value, INITIAL_YIELD_DEFAULT_MS),
		minimum,
		SESSION_YIELD_MAX_MS,
	);
}

export function effectiveWriteStdinYieldMilliseconds(
	params: Pick<WriteStdinParams, "chars" | "yield_time_ms">,
	backgroundTerminalMaxTimeout: unknown = process.env[
		BACKGROUND_TERMINAL_MAX_TIMEOUT_ENV
	],
): number {
	if (params.chars) {
		return clampMilliseconds(
			finiteMilliseconds(params.yield_time_ms, WRITE_YIELD_DEFAULT_MS),
			WRITE_YIELD_MIN_MS,
			SESSION_YIELD_MAX_MS,
		);
	}

	const maximum = resolveBackgroundTerminalMaxTimeoutMilliseconds(
		backgroundTerminalMaxTimeout,
	);
	return clampMilliseconds(
		finiteMilliseconds(params.yield_time_ms, EMPTY_POLL_YIELD_DEFAULT_MS),
		EMPTY_POLL_YIELD_MIN_MS,
		maximum,
	);
}

function approximateTokenCount(byteCount: number): number {
	return Math.ceil(byteCount / APPROX_BYTES_PER_TOKEN);
}

function resolveMaxOutputTokens(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return DEFAULT_MAX_OUTPUT_TOKENS;
	}
	return Math.min(Math.floor(value), MAX_OUTPUT_TOKENS_POLICY);
}

function isUtf8Continuation(byte: number): boolean {
	return (byte & 0xc0) === 0x80;
}

function utf8SequenceLength(byte: number): number {
	if (byte <= 0x7f) return 1;
	if (byte >= 0xc2 && byte <= 0xdf) return 2;
	if (byte >= 0xe0 && byte <= 0xef) return 3;
	if (byte >= 0xf0 && byte <= 0xf4) return 4;
	return 1;
}

function trimIncompleteUtf8End(bytes: Buffer): Buffer {
	if (bytes.length === 0) return bytes;
	let start = bytes.length - 1;
	while (start > 0 && isUtf8Continuation(bytes[start])) start -= 1;
	const expected = utf8SequenceLength(bytes[start]);
	const available = bytes.length - start;
	if (expected > available) return bytes.subarray(0, start);
	return bytes;
}

function trimIncompleteUtf8Start(bytes: Buffer): Buffer {
	let start = 0;
	while (start < bytes.length && isUtf8Continuation(bytes[start])) start += 1;
	return bytes.subarray(start);
}

const UNICODE_FORMAT_CHARACTER = /\p{Cf}/u;

function decodeUtf8(bytes: Buffer): string {
	return Array.from(stripVTControlCharacters(bytes.toString("utf8")))
		.filter((character) => {
			const code = character.codePointAt(0);
			if (code === undefined) return false;
			if (code === 0x09 || code === 0x0a) return true;
			if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return false;
			if (code >= 0xd800 && code <= 0xdfff) return false;
			if (UNICODE_FORMAT_CHARACTER.test(character)) return false;
			return true;
		})
		.join("");
}

function outputOmissionMarker(omittedBytes: number): string {
	return `... ${omittedBytes} bytes omitted ...`;
}

function collectedOutputText(snapshot: HeadTailSnapshot): {
	text: string;
	omittedBytes: number;
} {
	if (snapshot.omittedBytes === 0) {
		return {
			text: decodeUtf8(Buffer.concat([snapshot.head, snapshot.tail])),
			omittedBytes: 0,
		};
	}
	const head = trimIncompleteUtf8End(snapshot.head);
	const tail = trimIncompleteUtf8Start(snapshot.tail);
	const omittedBytes = Math.max(
		0,
		snapshot.totalBytes - head.length - tail.length,
	);
	return {
		text: `${decodeUtf8(head)}\n${outputOmissionMarker(omittedBytes)}\n${decodeUtf8(tail)}`,
		omittedBytes,
	};
}

function truncateUtf8Middle(
	text: string,
	maxBytes: number,
): { text: string; removedBytes: number } {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= maxBytes) return { text, removedBytes: 0 };
	const leftBudget = Math.floor(maxBytes / 2);
	const rightBudget = maxBytes - leftBudget;
	const head = trimIncompleteUtf8End(bytes.subarray(0, leftBudget));
	const tail = trimIncompleteUtf8Start(
		bytes.subarray(Math.max(0, bytes.length - rightBudget)),
	);
	const removedBytes = Math.max(0, bytes.length - head.length - tail.length);
	return {
		text: `${decodeUtf8(head)}…${approximateTokenCount(removedBytes)} tokens truncated…${decodeUtf8(tail)}`,
		removedBytes,
	};
}

function rustLineCount(text: string): number {
	if (!text) return 0;
	const count = text.split("\n").length;
	return text.endsWith("\n") ? count - 1 : count;
}

export function formatUnifiedExecOutput(
	snapshot: HeadTailSnapshot,
	maxOutputTokens?: number,
): {
	output: string;
	originalTokenCount: number;
	truncated: boolean;
	omittedBytes: number;
} {
	const collected = collectedOutputText(snapshot);
	const originalTokenCount = approximateTokenCount(snapshot.totalBytes);
	const maxTokens = resolveMaxOutputTokens(maxOutputTokens);
	const maxBytes = maxTokens * APPROX_BYTES_PER_TOKEN;
	const collectedBytes = Buffer.byteLength(collected.text, "utf8");
	if (collectedBytes <= maxBytes) {
		return {
			output: collected.text,
			originalTokenCount,
			truncated: collected.omittedBytes > 0,
			omittedBytes: collected.omittedBytes,
		};
	}

	const truncated = truncateUtf8Middle(collected.text, maxBytes);
	let output: string;
	if (collected.omittedBytes === 0) {
		output = `Warning: truncated output (original token count: ${originalTokenCount})\nTotal output lines: ${rustLineCount(collected.text)}\n\n${truncated.text}`;
	} else {
		const marker = outputOmissionMarker(collected.omittedBytes);
		const omissionNotice = truncated.text.includes(marker) ? "" : `${marker}\n`;
		output = `Warning: truncated output (original token count: ${originalTokenCount})\n${omissionNotice}\n${truncated.text}`;
	}
	return {
		output,
		originalTokenCount,
		truncated: true,
		omittedBytes: collected.omittedBytes,
	};
}

function isSessionDone(session: ExecSession): boolean {
	return session.closed || session.error !== undefined;
}

function isSessionRunning(session: ExecSession): boolean {
	return !isSessionDone(session);
}

function touchSession(session: ExecSession): void {
	session.lastUsed = ++lastSessionUse;
}

export function selectSessionIdToPrune(
	meta: SessionPruneCandidate[],
): number | undefined {
	if (meta.length === 0) return undefined;
	const byRecency = [...meta].sort(
		(a, b) => b.lastUsed - a.lastUsed || b.id - a.id,
	);
	const protectedIds = new Set(
		byRecency.slice(0, PROTECTED_RECENT_SESSION_COUNT).map((entry) => entry.id),
	);
	const lru = [...meta].sort((a, b) => a.lastUsed - b.lastUsed || a.id - b.id);
	return (
		lru.find((entry) => !protectedIds.has(entry.id) && entry.exited)?.id ??
		lru.find((entry) => !protectedIds.has(entry.id))?.id
	);
}

export async function writeBufferFully(
	writer: Pick<FileHandle, "write">,
	chunk: Buffer,
): Promise<void> {
	let offset = 0;
	while (offset < chunk.length) {
		const { bytesWritten } = await writer.write(
			chunk,
			offset,
			chunk.length - offset,
			null,
		);
		if (bytesWritten <= 0) {
			throw new Error("complete output log write made no progress");
		}
		offset += bytesWritten;
	}
}

function appendSessionOutput(session: ExecSession, chunk: Buffer): void {
	if (chunk.length === 0) return;
	const appliesBackpressure = !session.logError;
	if (appliesBackpressure) {
		session.logBackpressureDepth += 1;
		session.child.stdout.pause();
		session.child.stderr.pause();
	}
	session.logWrites = session.logWrites
		.then(async () => {
			if (session.logError) return;
			if (session.loggedBytes + chunk.length > MAX_EXEC_LOG_BYTES) {
				session.logError = `complete output exceeded ${MAX_EXEC_LOG_BYTES} bytes`;
				return;
			}
			await writeBufferFully(session.logFile, chunk);
			session.loggedBytes += chunk.length;
		})
		.catch((error) => {
			session.logError = error instanceof Error ? error.message : String(error);
		})
		.finally(() => {
			if (appliesBackpressure && session.logBackpressureDepth > 0) {
				session.logBackpressureDepth -= 1;
			}
			if (
				appliesBackpressure &&
				session.logBackpressureDepth === 0 &&
				!session.closed
			) {
				session.child.stdout.resume();
				session.child.stderr.resume();
			}
		});
	session.pendingOutput.append(chunk);
	for (const listener of session.outputListeners) listener();
}

function closeSessionLog(session: ExecSession): Promise<void> {
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

async function cleanupSessionLog(session: ExecSession): Promise<void> {
	if (!isSessionDone(session) || !session.released || session.activeCalls > 0)
		return;
	await closeSessionLog(session);
	managedSessions.delete(session);
	if (session.preserveLog && !session.shutdownRequested) {
		retainedLogDirectories.set(session.logDirectory, {
			owner: session.owner,
			bytes: session.loggedBytes,
			lastUsed: session.lastUsed,
		});
		await pruneRetainedLogs(session.owner);
		return;
	}
	retainedLogDirectories.delete(session.logDirectory);
	try {
		await rm(session.logDirectory, { recursive: true, force: true });
		managedLogDirectories.delete(session.logDirectory);
	} catch {
		// Keep the directory registered so shutdown can retry cleanup.
	}
}

async function pruneRetainedLogs(owner: ExecRuntimeOwner): Promise<void> {
	while (true) {
		const retained = [...retainedLogDirectories]
			.filter(([, info]) => info.owner === owner)
			.sort((a, b) => a[1].lastUsed - b[1].lastUsed);
		const totalBytes = retained.reduce((sum, [, info]) => sum + info.bytes, 0);
		if (
			retained.length <= MAX_RETAINED_EXEC_LOGS &&
			totalBytes <= MAX_RETAINED_EXEC_LOG_BYTES
		) {
			return;
		}
		const victim = retained[0];
		if (!victim) return;
		const [directory, info] = victim;
		retainedLogDirectories.delete(directory);
		try {
			await rm(directory, { recursive: true, force: true });
			managedLogDirectories.delete(directory);
		} catch {
			retainedLogDirectories.set(directory, info);
			return;
		}
	}
}

function releaseSession(session: ExecSession): Promise<void> {
	if (execSessions.get(session.id) === session) execSessions.delete(session.id);
	session.released = true;
	return cleanupSessionLog(session);
}

function recordTerminationAttempt(
	session: ExecSession,
	attempt: Promise<boolean>,
): void {
	session.terminationAttempt = attempt;
	void attempt.then((success) => {
		if (!success) {
			session.terminationError = `process-tree termination failed for session ${session.id}`;
		}
	});
}

function requestTermination(
	session: ExecSession,
	reason: TerminationReason,
	signal: NodeJS.Signals,
	force = false,
): void {
	if (isSessionDone(session)) return;
	session.terminationReason ??= reason;
	if (reason === "abort") session.aborted = true;

	const pid = session.child.pid;
	if (!pid) return;
	const forceNow = force || process.platform === "win32";
	recordTerminationAttempt(
		session,
		terminateProcessTree(pid, forceNow ? "SIGKILL" : signal, forceNow),
	);
	if (forceNow || session.forceKillTimeout) return;
	session.forceKillTimeout = setTimeout(() => {
		if (!isSessionDone(session) && session.child.pid) {
			recordTerminationAttempt(
				session,
				terminateProcessTree(session.child.pid, "SIGKILL", true),
			);
		}
	}, FORCE_KILL_DELAY_MS);
	session.forceKillTimeout.unref?.();
}

function requestInterrupt(session: ExecSession): void {
	if (isSessionDone(session)) return;
	const pid = session.child.pid;
	if (pid) {
		const force = process.platform === "win32";
		recordTerminationAttempt(
			session,
			terminateProcessTree(pid, force ? "SIGKILL" : "SIGINT", force),
		);
	}
}

function settleSession(
	session: ExecSession,
	waitMs: number,
	signal: AbortSignal | undefined,
): Promise<void> {
	if (isSessionDone(session)) return Promise.resolve();
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
			if (timer) clearTimeout(timer);
			timer = setTimeout(done, FORCE_KILL_DELAY_MS + 1_000);
		};
		session.child.once("close", done);
		session.child.once("error", done);
		timer = setTimeout(done, waitMs);
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });
	});
}

function generateChunkId(): string {
	return randomBytes(3).toString("hex");
}

function wallTimeSeconds(startedAt: bigint): number {
	return Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
}

function buildSessionResult(
	session: ExecSession,
	call: ExecCall,
	snapshot: HeadTailSnapshot,
	preserveTruncatedLog: boolean,
): AgentToolResult<ExecCommandDetails> {
	const running = isSessionRunning(session);
	const processError = session.error ?? session.terminationError;
	const formatted = formatUnifiedExecOutput(snapshot, call.maxOutputTokens);
	if (
		formatted.truncated &&
		preserveTruncatedLog &&
		!session.logError &&
		!session.shutdownRequested
	) {
		session.preserveLog = true;
	}
	const wallTime = wallTimeSeconds(call.startedAt);

	const sections = [
		`Chunk ID: ${call.chunkId}`,
		`Wall time: ${wallTime.toFixed(4)} seconds`,
	];
	if (running) {
		sections.push(`Process running with session ID ${session.id}`);
	} else if (session.exitSignal) {
		sections.push(`Process exited with signal ${session.exitSignal}`);
	} else if (session.aborted) {
		sections.push("Process aborted");
	} else if (typeof session.exitCode === "number") {
		sections.push(`Process exited with code ${session.exitCode}`);
	} else if (processError) {
		sections.push(`Process failed: ${processError}`);
	} else {
		sections.push("Process exited without an exit code");
	}
	sections.push(`Original token count: ${formatted.originalTokenCount}`);
	if (formatted.truncated) {
		if (session.shutdownRequested) {
			sections.push("Complete output log removed during session shutdown.");
		} else if (session.logError) {
			sections.push(
				`Complete output log could not be written: ${session.logError}`,
			);
		} else {
			sections.push(`Full output saved to: ${session.logPath}`);
		}
	}
	sections.push("Output:", formatted.output);

	return {
		content: [{ type: "text", text: sections.join("\n") }],
		details: {
			output: formatted.output,
			cmd: session.cmd,
			workdir: session.workdir,
			chunk_id: call.chunkId,
			wall_time_seconds: wallTime,
			original_token_count: formatted.originalTokenCount,
			...(running ? { session_id: session.id } : {}),
			...(typeof session.exitCode === "number"
				? { exit_code: session.exitCode }
				: {}),
			...(session.exitSignal ? { signal: session.exitSignal } : {}),
			running,
			tty: false,
			...(session.aborted ? { aborted: true } : {}),
			...(formatted.truncated ? { truncated: true } : {}),
			...(formatted.omittedBytes > 0
				? { omitted_bytes: formatted.omittedBytes }
				: {}),
			...(formatted.truncated && !session.logError && !session.shutdownRequested
				? { full_output_path: session.logPath }
				: {}),
			...(session.logError ? { log_error: session.logError } : {}),
			...(processError ? { error: processError } : {}),
		},
	};
}

async function sessionResult(
	session: ExecSession,
	call: ExecCall,
	snapshot: HeadTailSnapshot,
): Promise<AgentToolResult<ExecCommandDetails>> {
	if (isSessionDone(session)) await closeSessionLog(session);
	else await session.logWrites;
	return buildSessionResult(session, call, snapshot, true);
}

function createOutputUpdater(
	session: ExecSession,
	call: ExecCall,
	onUpdate: ExecUpdate | undefined,
): { flush: () => void; dispose: () => void } {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let dirty = false;
	let lastUpdateAt = 0;

	const emit = () => {
		if (!onUpdate || !dirty) return;
		dirty = false;
		lastUpdateAt = Date.now();
		onUpdate(
			buildSessionResult(
				session,
				call,
				session.pendingOutput.snapshot(),
				false,
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

function allocateSessionId(): number {
	for (let attempt = 0; attempt < 1_000; attempt++) {
		const id = randomInt(1_000, 100_000);
		if (!execSessions.has(id)) return id;
	}
	throw new Error("exec_command could not reserve a session ID");
}

async function pruneExecSessionsForCapacity(
	owner: ExecRuntimeOwner,
): Promise<void> {
	const ownedSessions = () =>
		[...execSessions.values()].filter((session) => session.owner === owner);
	while (ownedSessions().length >= MAX_UNIFIED_EXEC_PROCESSES) {
		const id = selectSessionIdToPrune(
			ownedSessions().map((session) => ({
				id: session.id,
				lastUsed: session.lastUsed,
				exited: isSessionDone(session),
			})),
		);
		if (id === undefined) {
			throw new Error("exec_command session capacity could not be pruned");
		}
		const session = execSessions.get(id);
		if (!session) continue;
		if (!isSessionDone(session)) {
			requestTermination(session, "prune", "SIGKILL", true);
			await settleSession(session, SHUTDOWN_WAIT_MS, undefined);
			if (session.terminationAttempt && !(await session.terminationAttempt)) {
				throw new Error(
					session.terminationError ??
						`exec_command process-tree termination failed for session ${session.id}`,
				);
			}
			if (!isSessionDone(session)) {
				throw new Error(
					`exec_command could not terminate session ${session.id} for capacity pruning`,
				);
			}
		}
		await releaseSession(session);
	}
}

async function createExecSession(
	params: ExecCommandParams,
	workdir: string,
	signal: AbortSignal | undefined,
	owner: ExecRuntimeOwner,
): Promise<ExecSession> {
	if (params.tty === true) {
		throw new Error(
			"exec_command tty:true is unavailable in pi-codex-compat: this extension runtime uses plain pipes and cannot truthfully provide a PTY/ConPTY",
		);
	}
	return withManagerLock(async () => {
		throwIfLaunchAborted(signal);
		if (!runtimeOwners.has(owner)) {
			throw new Error("Unified Exec runtime is shut down");
		}
		await pruneExecSessionsForCapacity(owner);
		throwIfLaunchAborted(signal);
		const launch = resolveShellLaunch(params);
		const logDirectory = await mkdtemp(join(tmpdir(), "pi-codex-exec-"));
		const logPath = join(logDirectory, "output.log");
		let logFile: FileHandle;
		try {
			throwIfLaunchAborted(signal);
			logFile = await open(logPath, "wx");
			throwIfLaunchAborted(signal);
		} catch (error) {
			await rm(logDirectory, { recursive: true, force: true }).catch(() => {});
			throw error;
		}
		let child: ChildProcessWithoutNullStreams;
		try {
			child = spawn(launch.shell, launch.args, {
				cwd: workdir,
				detached: process.platform !== "win32",
				env: createUnifiedExecEnvironment(),
				stdio: "pipe",
				windowsVerbatimArguments:
					process.platform === "win32" &&
					normalizedShellName(launch.shell) === "cmd",
				windowsHide: true,
			});
		} catch (error) {
			await logFile.close().catch(() => {});
			await rm(logDirectory, { recursive: true, force: true }).catch(() => {});
			throw error;
		}
		const session: ExecSession = {
			id: allocateSessionId(),
			owner,
			cmd: params.cmd,
			workdir,
			child,
			pendingOutput: new HeadTailBuffer(),
			closed: false,
			outputListeners: new Set(),
			logDirectory,
			logPath,
			logFile,
			logWrites: Promise.resolve(),
			loggedBytes: 0,
			logBackpressureDepth: 0,
			preserveLog: false,
			released: false,
			shutdownRequested: false,
			activeCalls: 1,
			lastUsed: 0,
		};
		touchSession(session);
		managedSessions.add(session);
		managedLogDirectories.set(session.logDirectory, owner);
		execSessions.set(session.id, session);

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
			if (session.forceKillTimeout) clearTimeout(session.forceKillTimeout);
			void closeSessionLog(session).then(() => cleanupSessionLog(session));
		});

		if (launch.commandFromStdin && !signal?.aborted)
			child.stdin.end(params.cmd);
		else child.stdin.end();
		return session;
	});
}

function createExecCall(maxOutputTokens?: number): ExecCall {
	return {
		chunkId: generateChunkId(),
		startedAt: process.hrtime.bigint(),
		maxOutputTokens,
	};
}

export async function executeManagedExecCommand(
	params: ExecCommandParams,
	signal: AbortSignal | undefined,
	ctx: ExecExecutionContext,
	onUpdate?: ExecUpdate,
	owner: ExecRuntimeOwner = DEFAULT_EXEC_RUNTIME_OWNER,
): Promise<AgentToolResult<ExecCommandDetails>> {
	validateExecCommandParams(params);
	throwIfLaunchAborted(signal);
	const leaveOperation = await enterExecOperation(signal, owner);
	try {
		const call = createExecCall(params.max_output_tokens);
		const workdir = params.workdir ?? ctx.cwd;
		const session = await createExecSession(params, workdir, signal, owner);
		try {
			const updater = createOutputUpdater(session, call, onUpdate);
			try {
				const waitMs = effectiveExecCommandYieldMilliseconds(
					params.yield_time_ms,
				);
				await settleSession(session, waitMs, signal);
				updater.flush();
				if (session.error) {
					throw new Error(`exec_command failed to launch: ${session.error}`);
				}
				const result = await sessionResult(
					session,
					call,
					session.pendingOutput.drain(),
				);
				if (!result.details?.running) await releaseSession(session);
				return result;
			} finally {
				updater.dispose();
			}
		} catch (error) {
			requestTermination(session, "abort", "SIGTERM");
			const terminationSucceeded = session.terminationAttempt
				? await session.terminationAttempt
				: true;
			if (terminationSucceeded) {
				await settleSession(session, SHUTDOWN_WAIT_MS, undefined);
			}
			if (!terminationSucceeded || !isSessionDone(session)) {
				const terminationError =
					session.terminationError ??
					`exec_command could not verify process-tree termination for session ${session.id}`;
				session.terminationError = terminationError;
				const original = error instanceof Error ? error.message : String(error);
				throw new Error(`${original}; ${terminationError}`);
			}
			await releaseSession(session);
			throw error;
		} finally {
			session.activeCalls -= 1;
			await cleanupSessionLog(session);
		}
	} finally {
		leaveOperation();
	}
}

export async function executeWriteStdin(
	params: WriteStdinParams,
	signal: AbortSignal | undefined,
	onUpdate?: ExecUpdate,
	owner: ExecRuntimeOwner = DEFAULT_EXEC_RUNTIME_OWNER,
): Promise<AgentToolResult<ExecCommandDetails>> {
	validateWriteStdinParams(params);
	const leaveOperation = await enterExecOperation(signal, owner);
	try {
		const call = createExecCall(params.max_output_tokens);
		const session = await withManagerLock(() => {
			const current = execSessions.get(params.session_id);
			if (!current || current.owner !== owner) {
				throw new Error(
					`write_stdin failed: no unified exec session ${params.session_id}`,
				);
			}
			touchSession(current);
			current.activeCalls += 1;
			return current;
		});
		try {
			if (params.chars && params.chars !== "\u0003") {
				throw new Error(
					"write_stdin failed: stdin is closed for a non-TTY exec_command session; only an exact Ctrl-C character (U+0003) is supported",
				);
			}

			const updater = createOutputUpdater(session, call, onUpdate);
			try {
				if (params.chars === "\u0003") requestInterrupt(session);
				const waitMs = effectiveWriteStdinYieldMilliseconds(params);
				await settleSession(session, waitMs, signal);
				updater.flush();
				const result = await sessionResult(
					session,
					call,
					session.pendingOutput.drain(),
				);
				if (!result.details?.running) await releaseSession(session);
				return result;
			} finally {
				updater.dispose();
			}
		} finally {
			session.activeCalls -= 1;
			await cleanupSessionLog(session);
		}
	} finally {
		leaveOperation();
	}
}

export async function startExecSessionRuntime(
	owner: ExecRuntimeOwner = DEFAULT_EXEC_RUNTIME_OWNER,
): Promise<void> {
	const shuttingDown = shutdownInProgress.get(owner);
	if (shuttingDown) await shuttingDown;
	await withManagerLock(() => {
		runtimeOwners.add(owner);
	});
}

async function performExecSessionShutdown(
	owner: ExecRuntimeOwner,
): Promise<void> {
	let sessions: ExecSession[] = [];
	await withManagerLock(() => {
		runtimeOwners.delete(owner);
		sessions = [...managedSessions].filter(
			(session) => session.owner === owner,
		);
		for (const session of sessions) {
			session.shutdownRequested = true;
			requestTermination(session, "shutdown", "SIGKILL", true);
			execSessions.delete(session.id);
			session.released = true;
		}
	});
	await Promise.all([
		waitForActiveOperations(owner),
		...sessions.map(async (session) => {
			await settleSession(session, SHUTDOWN_WAIT_MS, undefined);
			if (session.terminationAttempt && !(await session.terminationAttempt)) {
				throw new Error(
					session.terminationError ??
						`Unified Exec process-tree termination failed for session ${session.id}`,
				);
			}
			if (!isSessionDone(session)) {
				requestTermination(session, "shutdown", "SIGKILL", true);
				await settleSession(session, SHUTDOWN_WAIT_MS, undefined);
				if (session.terminationAttempt && !(await session.terminationAttempt)) {
					throw new Error(
						session.terminationError ??
							`Unified Exec process-tree termination failed for session ${session.id}`,
					);
				}
			}
			if (!isSessionDone(session)) {
				throw new Error(
					`Unified Exec could not terminate session ${session.id} during shutdown`,
				);
			}
			await closeSessionLog(session);
			session.outputListeners.clear();
		}),
	]);
	const directories = [...managedLogDirectories]
		.filter(([, directoryOwner]) => directoryOwner === owner)
		.map(([directory]) => directory);
	await Promise.all(
		directories.map(async (directory) => {
			try {
				await rm(directory, { recursive: true, force: true });
				managedLogDirectories.delete(directory);
				retainedLogDirectories.delete(directory);
			} catch {
				// A later shutdown retries any platform-specific transient failure.
			}
		}),
	);
	for (const session of sessions) managedSessions.delete(session);
}

export async function shutdownExecSessions(
	owner: ExecRuntimeOwner = DEFAULT_EXEC_RUNTIME_OWNER,
): Promise<void> {
	const activeShutdown = shutdownInProgress.get(owner);
	if (activeShutdown) {
		await activeShutdown;
		return;
	}
	const shutdown = performExecSessionShutdown(owner);
	shutdownInProgress.set(owner, shutdown);
	try {
		await shutdown;
	} finally {
		if (shutdownInProgress.get(owner) === shutdown) {
			shutdownInProgress.delete(owner);
		}
	}
}
