import { hostname } from "node:os";
import {
	createBashToolDefinition, createEditToolDefinition, createReadToolDefinition, createWriteToolDefinition, getAgentDir, SettingsManager,
	type BashOperations, type ExtensionAPI, type ExtensionContext, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { connection } from "../../pi-conversation-search/index.ts";
import { API_HEADER, API_VERSION } from "../src/shared/release.ts";
import { HANDS_ENTRY, handsBinding, modelPath, toolPath, type HandsBinding, type HandsRequest } from "../src/shared/hands.ts";

interface Context { platform: string; home: string; files: { path: string; content: string }[] }

/** One call through this computer's Desk to the folder's computer; `data` receives output as it arrives. */
async function call(agentDir: string, binding: HandsBinding, request: HandsRequest, signal?: AbortSignal, data?: (chunk: Buffer) => void): Promise<unknown> {
	const host = await connection(agentDir);
	let response: Response;
	try {
		response = await fetch(`${host.origin}/api/hands`, { method: "POST", redirect: "error", signal,
			headers: { Authorization: `Bearer ${host.operator}`, [API_HEADER]: String(API_VERSION), "Content-Type": "application/json" },
			body: JSON.stringify({ computer: binding.computer, request }) });
	} catch (error) { if (signal?.aborted) throw new Error("aborted"); throw error; }
	if (response.status === 404) { await response.body?.cancel(); throw new Error("This computer's Desk can't act on other computers yet: update it."); }
	if (!response.ok || !response.body) throw new Error(`Desk refused the call: ${(await response.text()).slice(0, 500)}`);
	const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
	let buffered = "";
	try {
		for (;;) {
			const part = await reader.read();
			if (part.done) throw new Error(`The connection to ${binding.name} ended before the call finished.`);
			buffered += part.value;
			for (let end = buffered.indexOf("\n"); end >= 0; end = buffered.indexOf("\n")) {
				const line = JSON.parse(buffered.slice(0, end)) as { data?: string; result?: unknown; error?: string };
				buffered = buffered.slice(end + 1);
				if (typeof line.data === "string") data?.(Buffer.from(line.data, "base64"));
				else if (typeof line.error === "string") throw new Error(line.error);
				else return line.result;
			}
		}
	} catch (error) {
		if (signal?.aborted) throw new Error("aborted");
		throw error;
	} finally { reader.releaseLock(); }
}

/**
 * A conversation moved here with its tools left on its old computer ("Move to another computer", keeping its folder):
 * read, write, edit, bash and ! commands act in that folder there; everything else runs here. The session's last
 * pi-desk/hands entry says where; a move without that option records null, and the tools act here again.
 */
export default function hands(pi: ExtensionAPI) {
	const agentDir = getAgentDir();
	let binding: HandsBinding | undefined, context: Context | undefined, failed: string | undefined, registered = false;
	const cwd = () => toolPath(binding!.folder, binding!.platform);
	const path = (value: unknown) => {
		if (typeof value !== "string") return value;
		const home = context?.home;
		if (home && (value === "~" || value.startsWith("~/"))) return `${toolPath(home, binding!.platform)}${value.slice(1)}`;
		return modelPath(value, binding!.platform);
	};
	const send = (request: HandsRequest, signal?: AbortSignal, data?: (chunk: Buffer) => void) => call(agentDir, binding!, request, signal, data);
	const read = async (file: string) => {
		const parts: Buffer[] = [];
		await send({ op: "read", path: file }, undefined, chunk => parts.push(chunk));
		return Buffer.concat(parts);
	};
	const bash: BashOperations = {
		// The tool passes its own folder; a ! command passes this computer's, so the binding's folder is used for both.
		exec: async (command, _cwd, { onData, signal, timeout }) =>
			await send({ op: "exec", command, cwd: cwd(), ...(timeout ? { timeout } : {}) }, signal, onData) as { exitCode: number | null },
	};
	const tools = (local: string): ToolDefinition<any, any, any>[] => {
		if (!binding) {
			const settings = SettingsManager.create(local, agentDir);
			return [createReadToolDefinition(local, { autoResizeImages: settings.getImageAutoResize() }), createWriteToolDefinition(local),
				createEditToolDefinition(local), createBashToolDefinition(local, { commandPrefix: settings.getShellCommandPrefix(), shellPath: settings.getShellPath() })];
		}
		return [
			createReadToolDefinition(cwd(), { operations: {
				readFile: read, access: async file => { await send({ op: "access", path: file }); },
				detectImageMimeType: async file => await send({ op: "mime", path: file }) as string | null,
			} }),
			createWriteToolDefinition(cwd(), { operations: {
				writeFile: async (file, content) => { await send({ op: "write", path: file, content }); },
				mkdir: async dir => { await send({ op: "mkdir", path: dir }); },
			} }),
			createEditToolDefinition(cwd(), { operations: {
				readFile: read, writeFile: async (file, content) => { await send({ op: "write", path: file, content }); },
				access: async file => { await send({ op: "access", path: file, write: true }); },
			} }),
			createBashToolDefinition(cwd(), { operations: bash }),
		];
	};
	const register = () => {
		if (registered) return;
		registered = true;
		// Same names, descriptions and parameters as Pi's own: each call is built for where the session's tools act now.
		for (const tool of tools(process.cwd())) pi.registerTool({ ...tool, execute: (id, params, signal, onUpdate, ctx) => {
			const current = tools(ctx.cwd).find(item => item.name === tool.name)!;
			const input = binding && params && typeof params === "object" && "path" in params ? { ...params, path: path(params.path) } : params;
			return current.execute(id, input, signal, onUpdate, ctx);
		} });
	};

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		binding = undefined; context = undefined; failed = undefined;
		for (const entry of ctx.sessionManager.getBranch()) if (entry.type === "custom" && entry.customType === HANDS_ENTRY) binding = handsBinding(entry.data);
		if (!binding) return;
		register();
		// Its project instructions are read once, so the prompt stays the same from turn to turn.
		try { context = await send({ op: "context", path: cwd() }, AbortSignal.timeout(15_000)) as Context; }
		catch (error) { failed = error instanceof Error ? error.message : String(error); }
	});
	pi.on("user_bash", () => binding ? { operations: bash } : undefined);
	pi.on("before_agent_start", event => {
		if (!binding) return;
		const options = event.systemPromptOptions, windows = binding.platform === "win32";
		options.cwd = binding.folder;
		options.contextFiles = [...options.contextFiles ?? [], ...(context?.files ?? []).map(file => ({ path: `${binding!.name}: ${file.path}`, content: file.content }))];
		options.sections = { ...options.sections, hands: [
			`Your read, write, edit and bash tools act on ${binding.name}${windows ? " (Windows)" : ""}, in ${binding.folder}${windows ? `, which its Git Bash calls ${cwd()}` : ""}.`,
			`This conversation runs on ${hostname()}: every other tool, including codemode, watches, web tools and the agents you start, runs there and cannot reach ${binding.name}'s files. Pass files between them with read, write and bash.`,
			...failed ? [`${binding.name}'s project instructions could not be read when this conversation started: ${failed}`] : [],
		].join("\n") };
	});
}
