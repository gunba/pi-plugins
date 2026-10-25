import { realpathSync, rmSync } from "node:fs";
import { isControl } from "../shared/controls.ts";
import type { InputSubmission } from "../shared/inputs.ts";
import type { ApiRequest, ApiResponse } from "../shared/relay-protocol.ts";
import { commandFrom, string, workerCommandFrom } from "./commands.ts";
import { reply, type HostCore } from "./host-core.ts";
import type { SavedSessionIndex } from "./saved-sessions.ts";
import { StaleGeneration } from "./worker-errors.ts";

/**
 * The API for conversations: starting and resuming them, messages and uploads, restart, close and pin, their native
 * commands and reads (history, assets, artifacts, files), and searching saved conversations to resume.
 * Undefined when the request is for another route.
 */
export async function sessionRoute(core: HostCore, saved: () => SavedSessionIndex, url: URL, request: ApiRequest,
	data: Record<string, unknown>): Promise<ApiResponse | undefined> {
	if (url.pathname === "/api/sessions" && request.method === "POST") {
		// Validate everything first: a rejected request must not leave a conversation behind.
		const model = data.model === undefined ? undefined : string(data.model, 300), reasoning = data.reasoning === undefined ? undefined : string(data.reasoning, 20);
		const key = core.createSession(string(data.cwd, 4000) || core.options.cwd);
		const managed = core.sessions.get(key);
		if (managed && (model || reasoning)) managed.setup = { ...(model ? { model } : {}), ...(reasoning ? { reasoning } : {}) };
		return reply({ key }, 202);
	}
	if (url.pathname === "/api/resume" && request.method === "POST") {
		const file = realpathSync(string(data.file, 4000));
		const old = [...core.sessions.values()].find(item => (item.view.snapshot?.file ?? item.view.file) === file);
		return reply({ key: core.createSession(core.options.cwd, file, old, data.takeover === true) }, 202);
	}
	const inputRoute = /^\/api\/sessions\/([a-f0-9-]+)\/(inputs|uploads|restart)(?:\/([a-f0-9-]+)(?:\/(cancel|dismiss))?)?$/.exec(url.pathname);
	if (inputRoute) {
		const key = inputRoute[1]!, managed = core.sessions.get(key);
		if (!managed) return reply({ error: "Unknown session." }, 404);
		const id = inputRoute[3];
		if (inputRoute[2] === "inputs" && id) {
			if (request.method === "GET" && !inputRoute[4]) return reply(core.inputs.read(key, id));
			if (request.method === "POST" && inputRoute[4]) {
				const result = inputRoute[4] === "cancel" ? core.inputs.cancel(key, id) : core.inputs.dismiss(key, id);
				core.inputEvent(managed);
				return reply({ result: result ?? null });
			}
		} else if (!id && request.method === "POST") {
			if (inputRoute[2] === "restart") {
				if (managed.worker && data.replace === true) return reply({ key: await core.replaceWorker(managed) }, 202);
				if (managed.worker && (managed.view.state === "starting" || managed.view.state === "ready")) return reply({ key });
				if (managed.worker) throw new Error("Wait for this session worker to stop before restarting it.");
				// A sleeping conversation's model can be changed: it opens, takes the choice once ready, and sleeps again.
				const setup = data.setup && typeof data.setup === "object" ? data.setup as Record<string, unknown> : undefined;
				const choice = setup ? { ...(setup.model !== undefined ? { model: string(setup.model, 300) } : {}),
					...(setup.reasoning !== undefined ? { reasoning: string(setup.reasoning, 20) } : {}) } : undefined;
				const started = core.createSession(managed.view.cwd, managed.view.file, managed, data.takeover === true);
				const opened = core.sessions.get(started);
				if (opened && choice) opened.setup = choice;
				if (opened && data.sleep === true) opened.sleepWhenIdle = true;
				return reply({ key: started }, 202);
			}
			const command = commandFrom(data.command);
			const activation = string(data.activation, 100);
			const generation = data.generation === undefined ? undefined : string(data.generation, 100);
			let input: InputSubmission | undefined;
			if (inputRoute[2] === "inputs") {
				if (command.kind !== "prompt") throw new Error("Expected a message.");
				const id = string(data.id, 100);
				if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid message receipt.");
				input = { id, activation, generation, command };
				const previous = core.inputs.existing(key, input);
				if (previous) return reply({ accepted: true, input: previous });
			}
			if (core.closing || !managed.worker || managed.view.state === "closed" || managed.view.state === "failed")
				throw new Error("Start or resume this conversation before sending.");
			if (activation !== managed.view.activation) throw new StaleGeneration();
			if (inputRoute[2] === "uploads") {
				switch (command.kind) {
					case "upload_begin": case "upload_chunk": case "upload_finish": case "upload_discard":
						return reply({ result: core.attachments(key).command(command) ?? null });
					default: throw new Error("Expected an upload command.");
				}
			}
			if (managed.view.controls?.some(control => control.state === "running")) throw new Error("Wait for the current operation before sending.");
			if (generation !== undefined ? generation !== managed.view.ui?.generation
				: managed.initialized && managed.initialGeneration !== managed.view.ui?.generation) throw new StaleGeneration();
			if (!input!.command.text.trim() && !input!.command.attachments?.length) throw new Error("Enter a message or attach a file.");
			core.attachments(key).check(input!.command.attachments ?? []);
			if (input!.command.behavior === "now" && !managed.worker.runtime?.sendNow) throw new Error("This worker does not support Send now. Restart this conversation when idle to enable it.");
			const accepted = core.inputs.admit(key, input!);
			// The user is here: a conversation Desk woke for a watch stays open.
			managed.sleepWhenIdle = undefined;
			core.inputEvent(managed);
			core.drainInputs(managed);
			return reply({ accepted: true, input: accepted }, 202);
		}
		return reply({ error: "Unknown input operation." }, 404);
	}
	const control = /^\/api\/sessions\/([a-f0-9-]+)\/(close|metadata)$/.exec(url.pathname);
	if (control && request.method === "POST") {
		const managed = core.sessions.get(control[1]!);
		if (!managed) throw new Error("Unknown session.");
		if (control[2] === "close") {
			if (string(data.activation, 100) !== managed.view.activation) throw new StaleGeneration();
			if (!managed.worker) {
				core.inputs.interrupt(managed.view.key, "The conversation closed");
				// Removing a conversation from the sidebar cancels Desk's reopening it for a watch. Deleting its wake files tells
				// what writes them, which goes on while it sleeps, to stop (pi-ui UiView.wakeFiles).
				if (data.keep !== true) for (const file of managed.view.asleep?.files ?? []) rmSync(file.path, { force: true });
				managed.view = { ...managed.view, state: "closed", interrupted: false, error: undefined, kept: data.keep === true || undefined,
					...(data.keep === true ? {} : { wakes: undefined, watching: undefined, asleep: undefined }),
					snapshot: undefined, ui: undefined, inputs: core.inputs.pending(managed.view.key) };
				core.persist(true);
				core.emit({ type: "session", session: managed.view });
				return reply({ accepted: true });
			}
			managed.keepOnClose = data.keep === true;
			const result = await managed.worker.submitControl({ kind: "close", ...(data.keep === true ? { keep: true } : {}) }, managed.worker.generation, string(data.id, 100));
			if (result.control.state === "running") {
				core.inputs.interrupt(managed.view.key, "The conversation is closing");
				core.inputEvent(managed);
			}
			return reply(result, 202);
		} else {
			if (managed.worker && data.generation !== managed.view.ui?.generation) throw new StaleGeneration();
			managed.view = { ...managed.view, pinned: data.pinned === true };
		}
		core.persist(true);
		core.emit({ type: "session", session: managed.view });
		return reply({});
	}
	const route = /^\/api\/sessions\/([a-f0-9-]+)\/(command|history|assets\/([a-f0-9]{64})|artifacts\/(sha256-[a-f0-9]{64})|files\/([a-f0-9]{64})(?:\/(text|chunk|open|reveal))?)$/.exec(url.pathname);
	if (route) {
		const managed = core.sessions.get(route[1]!);
		if (!managed) return reply({ error: "Unknown session." }, 404);
		if (!managed.worker || managed.view.state === "closed" || managed.view.state === "failed") throw new Error("Resume this conversation before using its controls.");
		const origin = { message: url.searchParams.get("message"), source: url.searchParams.get("source") ?? undefined };
		if (route[2] === "command" && request.method === "POST") {
			const command = workerCommandFrom(data.command);
			if (["asset", "artifact", "file", "history", "snapshot", "prompt"].includes(command.kind)) throw new Error("Use the corresponding session endpoint.");
			if (isControl(command)) {
				if (command.kind === "queue_now" && !managed.worker.runtime?.queueNow) throw new Error("Restart this conversation to use Send now on waiting messages.");
				if (command.kind !== "abort" && command.kind !== "queue_now" && core.inputs.pending(managed.view.key).some(input => input.state === "queued" || input.state === "sending"))
					throw new Error("Cancel or finish pending messages before changing this session.");
				return reply({ result: await managed.worker.submitControl(command, string(data.generation, 100), string(data.id, 100)) }, 202);
			}
			if (command.kind === "queue_cancel" && !managed.worker.runtime?.queueCancel) throw new Error("Restart this conversation to cancel waiting messages.");
			const result = await managed.worker.command(command, string(data.generation, 100), string(data.id, 100));
			return reply({ result: result ?? null });
		}
		if (route[2] === "history" && request.method === "GET") {
			return reply(await managed.worker.command(workerCommandFrom({ kind: "history",
				before: url.searchParams.has("before") ? string(url.searchParams.get("before"), 100) : undefined,
				after: url.searchParams.get("after") ?? undefined, from: url.searchParams.get("from") ?? undefined,
				source: url.searchParams.has("source") ? string(url.searchParams.get("source"), 100) : undefined })));
		}
		if (route[3] && request.method === "GET") {
			const asset = await managed.worker.command(workerCommandFrom({ kind: "asset", id: route[3], origin })) as { mimeType: string; base64: string };
			return { status: 200, body: null, asset };
		}
		if (route[4] && request.method === "GET") {
			return reply(await managed.worker.command(workerCommandFrom({ kind: "artifact", id: route[4], origin,
				offset: url.searchParams.has("offset") ? Number(url.searchParams.get("offset")) : 0,
				query: url.searchParams.has("query") ? url.searchParams.get("query") : undefined })));
		}
		if (route[5] && ["open", "reveal"].includes(route[6] ?? "") && request.method === "POST") {
			return reply(await managed.worker.command(workerCommandFrom({ kind: "file", id: route[5], origin, operation: route[6], version: data.version }),
				undefined, string(data.id, 100)));
		}
		if (route[5] && !["open", "reveal"].includes(route[6] ?? "") && request.method === "GET") {
			return reply(await managed.worker.command(workerCommandFrom({ kind: "file", id: route[5], origin, operation: route[6] ?? "info",
				version: url.searchParams.get("version"),
				offset: url.searchParams.has("offset") ? Number(url.searchParams.get("offset")) : undefined,
				line: url.searchParams.has("line") ? Number(url.searchParams.get("line")) : undefined })));
		}
	}
	if (url.pathname === "/api/history" && request.method === "GET") {
		return reply(await saved().page({
			query: url.searchParams.get("query") ?? "",
			offset: url.searchParams.has("offset") ? Number(url.searchParams.get("offset")) : 0,
			revision: url.searchParams.get("revision") ?? undefined,
			refresh: url.searchParams.get("refresh") === "1",
			cwd: url.searchParams.get("cwd") ?? undefined,
			scan: url.searchParams.get("scan") ?? undefined,
			named: url.searchParams.get("named") === "1",
			reader: url.searchParams.get("reader") ?? undefined,
		}));
	}
	if (url.pathname === "/api/history/cancel" && request.method === "POST") {
		saved().cancel(string(request.body?.scan, 100), string(request.body?.reader, 100));
		return reply({});
	}
	return undefined;
}
