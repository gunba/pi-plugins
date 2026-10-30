import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, constants, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { createLocalBashOperations, detectSupportedImageMimeTypeFromFile, SettingsManager } from "@earendil-works/pi-coding-agent";
import { HANDS_FILE_BYTES, nativePath, type HandsPacket, type HandsRequest } from "../shared/hands.ts";

/** Output is sent in parts of about this size, and at least this often while a command runs. */
const PART = 256 * 1024;
const FLUSH_MS = 50;
/** A command's output beyond its first part and last part stays on the folder's computer, as a terminal's would scroll away. */
const OUTPUT_HEAD = 8 * 1024 * 1024;
const OUTPUT_TAIL = 2 * 1024 * 1024;
const CONTEXT_BYTES = 256 * 1024;

export interface HandsPeer { online: boolean; supports: boolean; name?: string }
export interface HandsBinding {
	send(computer: string, packet: HandsPacket): Promise<void>;
	peer(computer: string): HandsPeer;
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function text(value: unknown, field: string, max = 64 * 1024): string {
	if (typeof value !== "string" || value.length > max) throw new Error(`Invalid ${field}.`);
	return value;
}

/** Checks a call from a worker or another computer; nothing else reaches the file system or a shell. */
export function handsRequest(value: unknown): HandsRequest {
	const raw = (value ?? {}) as Record<string, unknown>, path = () => text(raw.path, "path", 4096);
	switch (raw.op) {
		case "read": case "mime": case "mkdir": case "context": return { op: raw.op, path: path() };
		case "access": return { op: "access", path: path(), ...(raw.write === true ? { write: true } : {}) };
		case "write": return { op: "write", path: path(), content: text(raw.content, "content", HANDS_FILE_BYTES) };
		case "exec": {
			const timeout = raw.timeout;
			if (timeout !== undefined && (typeof timeout !== "number" || !(timeout > 0))) throw new Error("Invalid timeout.");
			return { op: "exec", command: text(raw.command, "command", 1024 * 1024), cwd: text(raw.cwd, "cwd", 4096), ...(timeout ? { timeout } : {}) };
		}
		default: throw new Error("Unknown call.");
	}
}

/** Sends a command's output in parts; past OUTPUT_HEAD only the last OUTPUT_TAIL bytes are kept, sent when it ends. */
export class Output {
	private sent = 0;
	private pending: Buffer[] = [];
	private pendingBytes = 0;
	private tail: Buffer[] = [];
	private tailBytes = 0;
	private dropped = 0;
	private timer?: ReturnType<typeof setTimeout>;
	private readonly emit: (data: Buffer) => void;
	private readonly head: number;
	private readonly keep: number;
	constructor(emit: (data: Buffer) => void, head = OUTPUT_HEAD, keep = OUTPUT_TAIL) { this.emit = emit; this.head = head; this.keep = keep; }
	write(chunk: Buffer): void {
		const room = this.head - this.sent - this.pendingBytes;
		if (room > 0) {
			const part = chunk.subarray(0, room);
			this.pending.push(part); this.pendingBytes += part.length; chunk = chunk.subarray(part.length);
			if (this.pendingBytes >= PART) this.flush();
			else this.timer ??= setTimeout(() => this.flush(), FLUSH_MS);
		}
		if (!chunk.length) return;
		this.tail.push(chunk); this.tailBytes += chunk.length;
		while (this.tail.length > 1 && this.tailBytes - this.tail[0]!.length >= this.keep) {
			const first = this.tail.shift()!;
			this.tailBytes -= first.length; this.dropped += first.length;
		}
	}
	flush(): void {
		clearTimeout(this.timer); this.timer = undefined;
		if (!this.pendingBytes) return;
		const data = Buffer.concat(this.pending);
		this.pending = []; this.sent += this.pendingBytes; this.pendingBytes = 0;
		this.emit(data);
	}
	end(): void {
		this.flush();
		if (this.dropped) this.emit(Buffer.from(`\n[${this.dropped} bytes of output were left on ${hostname()}]\n`));
		if (this.tailBytes) this.emit(Buffer.concat(this.tail));
		this.tail = []; this.tailBytes = 0;
	}
}

/**
 * File and shell calls between computers. As the folder's computer it carries out calls other computers send; as the
 * conversation's computer it sends its workers' calls and streams back what comes in.
 */
export class Hands {
	private readonly agentDir: string;
	private binding?: HandsBinding;
	/** Calls this computer sent, by id. */
	private calls = new Map<string, { computer: string; data(data: string): void; done(result: unknown, error?: string): void }>();
	/** Calls this computer is carrying out, by sender and id. */
	private running = new Map<string, { from: string; controller: AbortController }>();
	constructor(agentDir: string) { this.agentDir = agentDir; }

	bind(binding: HandsBinding): void { this.binding = binding; }
	unbind(binding: HandsBinding): void {
		if (this.binding !== binding) return;
		this.binding = undefined;
		for (const [id, call] of this.calls) { this.calls.delete(id); call.done(undefined, "This computer left your workspace."); }
		for (const run of this.running.values()) run.controller.abort();
	}

	/** A computer disconnected: its calls here stop, and calls sent to it fail. */
	disconnected(computer: string): void {
		for (const [id, call] of this.calls) if (call.computer === computer) {
			this.calls.delete(id);
			call.done(undefined, `${this.binding?.peer(computer).name ?? "The other computer"} disconnected before it finished.`);
		}
		for (const run of this.running.values()) if (run.from === computer) run.controller.abort();
	}

	receive(from: string, packet: HandsPacket, reply: (packet: HandsPacket) => Promise<void>): void {
		if (typeof packet.id !== "string" || packet.id.length > 100) return;
		if (packet.type === "hands-call") { void this.execute(from, packet.id, packet.request, reply); return; }
		if (packet.type === "hands-cancel") { this.running.get(`${from} ${packet.id}`)?.controller.abort(); return; }
		const call = this.calls.get(packet.id);
		if (!call || call.computer !== from) return;
		if (packet.type === "hands-data" && typeof packet.data === "string") call.data(packet.data);
		else if (packet.type === "hands-done") {
			this.calls.delete(packet.id);
			call.done(packet.result, typeof packet.error === "string" ? packet.error : undefined);
		}
	}

	/** Sends one call; `data` receives its output, base64, in order, before it resolves. */
	call(computer: string, request: HandsRequest, data: (data: string) => void, signal?: AbortSignal): Promise<unknown> {
		const binding = this.binding;
		if (!binding) return Promise.reject(new Error("Acting on another computer needs your workspace."));
		const peer = binding.peer(computer), name = peer.name ?? "That computer";
		if (!peer.online) return Promise.reject(new Error(`${name} is not connected: its files and commands can't be reached until it is.`));
		if (!peer.supports) return Promise.reject(new Error(`${name} runs an older Desk that can't act for other computers: update Desk there.`));
		const id = randomUUID();
		return new Promise((resolve, reject) => {
			const abort = () => {
				if (!this.calls.delete(id)) return;
				void binding.send(computer, { type: "hands-cancel", id }).catch(() => {});
				reject(new Error("aborted"));
			};
			this.calls.set(id, { computer, data, done: (result, error) => {
				signal?.removeEventListener("abort", abort);
				if (error !== undefined) reject(new Error(error)); else resolve(result);
			} });
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) { abort(); return; }
			binding.send(computer, { type: "hands-call", id, request }).catch(error => {
				const call = this.calls.get(id);
				if (call) { this.calls.delete(id); call.done(undefined, `${name} could not be reached: ${message(error)}`); }
			});
		});
	}

	/** A worker's call, from the operator-only loopback API: output streams back as NDJSON lines, then the result. */
	async serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
		let body: Record<string, unknown>;
		try {
			const chunks: Buffer[] = [];
			let length = 0;
			for await (const chunk of request) {
				length += chunk.length;
				if (length > HANDS_FILE_BYTES * 1.2 + 64 * 1024) throw new Error("The call is too large.");
				chunks.push(chunk);
			}
			body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		} catch (error) {
			response.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: message(error) })); return;
		}
		response.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" });
		const controller = new AbortController();
		response.on("close", () => { if (!response.writableEnded) controller.abort(); });
		try {
			const result = await this.call(text(body.computer, "computer", 100), handsRequest(body.request),
				data => { response.write(`${JSON.stringify({ data })}\n`); }, controller.signal);
			response.end(`${JSON.stringify({ result: result ?? null })}\n`);
		} catch (error) { response.end(`${JSON.stringify({ error: message(error) })}\n`); }
	}

	private async execute(from: string, id: string, raw: unknown, reply: (packet: HandsPacket) => Promise<void>): Promise<void> {
		const key = `${from} ${id}`, controller = new AbortController();
		this.running.get(key)?.controller.abort();
		this.running.set(key, { from, controller });
		// Parts go out one at a time, in order, so a large file never fills the connection.
		let queue = Promise.resolve();
		const send = (packet: HandsPacket) => { queue = queue.then(() => reply(packet)).catch(() => { controller.abort(); }); return queue; };
		try {
			const result = await this.run(handsRequest(raw), controller.signal, data => send({ type: "hands-data", id, data: data.toString("base64") }));
			await send({ type: "hands-done", id, result: result ?? null });
		} catch (error) {
			await send({ type: "hands-done", id, error: message(error) });
		} finally { this.running.delete(key); }
	}

	private async run(request: HandsRequest, signal: AbortSignal, data: (data: Buffer) => Promise<void>): Promise<unknown> {
		switch (request.op) {
			case "read": {
				const path = nativePath(request.path), info = await stat(path);
				if (info.isDirectory()) throw new Error(`EISDIR: illegal operation on a directory, read '${path}'`);
				if (info.size > HANDS_FILE_BYTES) throw new Error(`${path} is ${Math.ceil(info.size / 1024 / 1024)} MB, more than one call carries (${HANDS_FILE_BYTES / 1024 / 1024} MB): read parts of it with bash.`);
				for await (const chunk of createReadStream(path, { highWaterMark: PART, signal })) await data(chunk as Buffer);
				return null;
			}
			case "access": await access(nativePath(request.path), request.write ? constants.R_OK | constants.W_OK : constants.R_OK); return null;
			case "mime": return await detectSupportedImageMimeTypeFromFile(nativePath(request.path)) ?? null;
			case "write": await writeFile(nativePath(request.path), request.content, "utf-8"); return null;
			case "mkdir": await mkdir(nativePath(request.path), { recursive: true }); return null;
			case "exec": {
				const cwd = nativePath(request.cwd), settings = SettingsManager.create(cwd, this.agentDir), prefix = settings.getShellCommandPrefix();
				const output = new Output(chunk => { void data(chunk); });
				try {
					const { exitCode } = await createLocalBashOperations({ shellPath: settings.getShellPath() }).exec(prefix ? `${prefix}\n${request.command}` : request.command, cwd,
						{ onData: chunk => output.write(chunk), signal, ...(request.timeout ? { timeout: request.timeout } : {}) });
					return { exitCode };
				} finally { output.end(); }
			}
			case "context": {
				// What Pi loads as project context: from the folder up to the root, each folder's AGENTS.md, else its CLAUDE.md.
				const files: { path: string; content: string }[] = [];
				for (let folder = nativePath(request.path); ; folder = dirname(folder)) {
					for (const name of ["AGENTS.md", "CLAUDE.md"]) {
						const path = join(folder, name);
						try {
							if ((await stat(path)).size > CONTEXT_BYTES) continue;
							files.unshift({ path, content: await readFile(path, "utf8") }); break;
						} catch { /* Not there. */ }
					}
					if (dirname(folder) === folder) break;
				}
				return { platform: process.platform, home: homedir(), files };
			}
		}
	}
}
