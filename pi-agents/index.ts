import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { ensureWorkUi, safeWorkText, type WorkUiSource } from "../pi-work-ui/index.ts";
import { isManagedChild } from "../pi-work-coordination/index.ts";
import { nativePromptPreparing } from "../pi-work-coordination/native-queue.ts";
import { INLINE_FILE_BYTES, LEASE_MS, MAX_MESSAGE_FILE_BYTES, MAX_MESSAGE_FILES, MESSAGE_PARTS, PartyStore, sendNames, type Member, type MessageFile, type PartyMessage } from "./store.ts";
import { PartyChat } from "./chat.ts";
import { renderPartyNotice } from "./render.ts";
import { getPresentation } from "../pi-ui/index.ts";
import { PartyPresentation } from "./presentation.ts";
import { PartyOperations } from "./operations.ts";
import { QuestStore } from "./quests.ts";
import { isReady, isToday, repeatLabel, QUEST_KINDS, type Quest } from "./quest-model.ts";
import { agentId, nativeId } from "./network.ts";
import { partyForkPoint } from "./fork.ts";
import { partyDelivery } from "./availability.ts";
import { providePrimaryAgents, rememberAgentLabels, type PrimaryAgents } from "./primary.ts";

export const PARTY_MESSAGE = "pi-party/message";
export function deliveredPartyIds(entries: readonly unknown[]): string[] {
	const ids: string[] = [];
	for (const entry of entries) {
		const value = entry as { type?: string; customType?: string; details?: { messageId?: string }; message?: {
			role?: string; toolName?: string; customType?: string; details?: { messageId?: string; partyMessageIds?: string[] };
		} };
		const message = value?.type === "custom_message" ? value : value?.message;
		if (message?.customType === PARTY_MESSAGE && typeof message.details?.messageId === "string") ids.push(message.details.messageId);
		// party_read is the tool's former name in saved histories.
		if (value?.message?.role === "toolResult" && ["agent_inbox", "party_read"].includes(value.message.toolName ?? "") && Array.isArray(value.message.details?.partyMessageIds)) {
			ids.push(...value.message.details.partyMessageIds.filter(id => typeof id === "string"));
		}
	}
	return ids;
}

export default function party(pi: ExtensionAPI): void {
	const child = !!process.env.PI_SUBAGENT_TASK_PATH || isManagedChild(pi);
	const ui = ensureWorkUi(pi);
	const owner = randomUUID();
	const directory = join(getAgentDir(), "party");
	let store: PartyStore | undefined;
	let lifecycle: PartyOperations | undefined;
	let ctx: ExtensionContext | undefined;
	let source: WorkUiSource | undefined;
	let session = "";
	let watcher: FSWatcher | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let inFlight = new Set<string>();
	const revoked = new Set<string>();
	let signature = "";
	let pumping = false;
	let stopped = false;
	let armed = false;
	// Messages that arrived before this process opened the conversation wait for its next turn; later ones may wake it.
	let wakeAfter = 0;
	let preparingPrompt = false;
	let chat: PartyChat | undefined;
	let remote: PartyPresentation | undefined;

	const label = () => pi.getSessionName() || "Untitled conversation";
	const database = () => store ??= new PartyStore(directory);
	const signal = () => { writeFileSync(join(directory, "changed"), randomUUID(), { mode: 0o600 }); };
	const operations = () => { database(); return lifecycle ??= new PartyOperations(directory); };
	let questStore: QuestStore | undefined;
	const quests = () => questStore ??= new QuestStore(directory);
	const member = () => store?.member(session);
	const syncFlight = () => {
		if (!store || member()?.owner !== owner) return;
		for (const id of inFlight) if (!store.isDelivered(session, owner, id)) {
			revoked.add(id); inFlight.delete(id);
		}
	};
	/** Why Desk cannot reopen a closed conversation for a sender, or undefined when it can. */
	const resumeBlocker = (peer: Member): string | undefined => {
		if (peer.kind !== "session" || peer.cwd === "ChatGPT") return "Only conversations can be reopened.";
		const computer = peer.computer ?? "local";
		if (computer === "local") return operations().hostOnline() ? undefined : "Desk is not running on this computer.";
		if (!database().computerOnline(computer)) return "Its computer is offline.";
		return database().computerSupports(computer, "resume") ? undefined : "Its computer runs an older Desk that cannot reopen conversations.";
	};
	const publicAgent = (peer: Member) => {
		const state = peer.heartbeat <= Date.now() - LEASE_MS ? "offline" : peer.state;
		const resumable = state === "offline" && !resumeBlocker(peer);
		// A managed child's parent owns its turns; messages arrive during the next one and never start it.
		const delivery = peer.kind === "child" ? { ...partyDelivery(peer, false, state), deliveryReason: "Managed child agent: messages arrive during its next turn." }
			: resumable ? { delivery: "reopen on wake", wakeable: true, deliveryReason: "Closed. agent_send with wake reopens it and it starts on your message; with wake=false the message waits until it is next opened." }
			: partyDelivery(peer, !!peer.delivery && state !== "offline", state);
		return {
			id: peer.session, computer: peer.computer ?? null, label: peer.label, description: peer.description, cwd: peer.cwd,
			kind: peer.kind, self: peer.session === session, state, ...delivery, ...(state === "offline" ? { resumable } : {}),
		};
	};
	/** Reopen a closed conversation that a message woke, through Desk on its computer, waiting up to 45 seconds. */
	const reopen = async (peer: Member, signal?: AbortSignal): Promise<{ reopened: "yes" | "starting" } | { reopened: "no"; reason: string }> => {
		const blocker = resumeBlocker(peer);
		if (blocker) return { reopened: "no", reason: blocker };
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const request = operations().queue(database(), session, owner, { kind: "resume", computer: peer.computer ?? "local", session: nativeId(peer.session) });
			const outcome = await Promise.race([operations().wait(request.id, signal).then(() => "yes" as const),
				new Promise<"starting">(resolve => { timer = setTimeout(() => resolve("starting"), 45_000); })]);
			return { reopened: outcome };
		} catch (error) { return { reopened: "no", reason: (error instanceof Error ? error.message : String(error)).replace(/ Receipt: \S+$/, "") }; }
		finally { clearTimeout(timer); }
	};
	const publish = () => {
		const self = member();
		if (!self || self.owner !== owner || !store) { chat?.close(); remote?.close(); remote = undefined; source?.set(undefined); return; }
		syncFlight();
		chat?.refresh();
		remote?.refresh();
		const pending = store.pending(session, owner).length;
		if (!pending) { source?.set(undefined); signature = ""; return; }
		const status = `${pending} unread`;
		const detail = [...(!armed ? ["Messages wait for this conversation's next turn.", ""] : []),
			"/inbox opens message history."].join("\n");
		const next = JSON.stringify([status, detail]);
		if (next === signature) return;
		signature = next;
		source?.set({ label: "Messages", status, detail, tone: "warning", manage: { label: "Inbox", run: context => handleInbox("", context) } });
	};
	const pump = (starting = preparingPrompt) => {
		const self = member();
		if (stopped || pumping || !ctx || !store || self?.owner !== owner || getPresentation(pi)?.suspended) return;
		// Filesystem notifications can be lost. The periodic pump must reconcile
		// the same persisted delivery state used by the roster and host controls.
		if (!child) armed = !!self.delivery;
		if (!armed) return;
		// A managed child's driver owns its turns and usage accounting.
		if (child && ctx.isIdle() && !starting) return;
		// Do not start a competing turn during native auth/input preflight.
		// before_agent_start attaches these messages to the human turn instead.
		if (!starting && ctx.isIdle() && nativePromptPreparing(ctx.sessionManager)) return;
		pumping = true;
		try {
			syncFlight();
			const queued = store.pending(session, owner).filter(message => !inFlight.has(message.id) && (starting || message.seq > wakeAfter));
			const pending = queued.slice(0, 8);
			// Managed child starts are accounted by their owning driver.
			const wake = !starting && !child && ctx.isIdle() && pending.some(message => message.wake === 1);
			for (let index = 0; index < pending.length; index++) {
				const message = pending[index];
				inFlight.add(message.id);
				try {
					pi.sendMessage({
						customType: PARTY_MESSAGE, display: true,
						content: `Message · ${safeWorkText(message.sender_label)} (${message.sender})\n\n${message.text}${receivedFiles(message)}`,
						details: { messageId: message.id, sender: message.sender, kind: message.kind },
					}, {
						// Pi has not claimed the low-level run in before_agent_start.
						// Attach to that prompt instead of starting a competing run.
						deliverAs: "steer",
						triggerTurn: wake && index === pending.length - 1,
					});
				} catch (error) { inFlight.delete(message.id); throw error; }
			}
			publish();
		} finally { pumping = false; }
	};
	const safely = (run: () => void) => {
		try { run(); }
		catch (error) {
			if (stopped) return;
			source?.set({ label: "Messages", status: "! unavailable", detail: String(error), tone: "error" });
		}
	};
	const stopTransport = () => {
		watcher?.close(); watcher = undefined;
		if (timer) clearInterval(timer);
		timer = undefined;
	};
	const startTransport = () => {
		stopTransport();
		watcher = watch(directory, (_event, filename) => {
			if (["changed", "network-changed", "operations-changed"].includes(String(filename))) safely(() => {
				pump(); publish();
			});
		});
		watcher.on("error", () => { watcher?.close(); watcher = undefined; });
		watcher.unref();
		timer = setInterval(() => safely(() => {
			if (!store || !ctx) return;
			store.touch(session, owner, ctx.isIdle() ? "idle" : "working", label());
			pump(); publish();
		}), 10_000);
		timer.unref();
	};
	pi.on("session_start", (_event, context) => {
		// Received files are kept for 30 days.
		try {
			for (const entry of readdirSync(join(directory, "files"))) {
				const folder = join(directory, "files", entry);
				if (Date.now() - statSync(folder).mtimeMs > 30 * 86_400_000) rmSync(folder, { recursive: true, force: true });
			}
		} catch { /* No received files yet. */ }
		chat?.close();
		ctx = context; session = ctx.sessionManager.getSessionId();
		providePrimaryAgents(session, primary); stopped = false; armed = false; preparingPrompt = false; signature = "";
		source = ui.source("messages");
		safely(() => {
			const self = database().register(session, owner, label(), ctx!.cwd, child ? "child" : "session", ctx!.sessionManager.getSessionFile());
			// Messages that asked to wake it while it was closed start a turn now, as they would have had it been idle.
			wakeAfter = 0;
			if (!child) { armed = true; database().setDelivery(session, owner, armed); }
			database().admit(session, owner, deliveredPartyIds(ctx!.sessionManager.getBranch()));
			bindRemote();
			startTransport(); publish();
		});
	});
	pi.on("session_tree", (_event, context) => {
		chat?.close();
		for (const id of inFlight) revoked.add(id);
		inFlight.clear(); armed = false; preparingPrompt = false;
		if (store && member()?.owner === owner) store.setDelivery(session, owner, false);
		ctx = context; source = ui.source("messages"); signature = ""; publish();
		bindRemote(); publish();
	});
	pi.on("session_shutdown", () => {
		chat?.close();
		remote?.close(); remote = undefined;
		providePrimaryAgents(session, undefined);
		stopped = true; armed = false; preparingPrompt = false; stopTransport();
		try { store?.release(session, owner); }
		finally { questStore?.close(); questStore = undefined; lifecycle?.close(); lifecycle = undefined; store?.close(); store = undefined; source?.dispose(); source = undefined; ctx = undefined; inFlight.clear(); }
	});
	pi.on("input", event => {
		if (event.source !== "extension" && store && member()?.owner === owner) {
			wakeAfter = 0;
			armed = true; store.setDelivery(session, owner, armed);
		}
	});
	pi.on("before_agent_start", () => {
		const self = member();
		if (self?.owner !== owner) return;
		preparingPrompt = true;
		armed = true; store!.setDelivery(session, owner, armed);
		pump(true);
	});
	pi.on("context", event => {
		syncFlight();
		const messages = event.messages.filter(message => message.role !== "custom" || !deliveredPartyIds([{ message }]).some(id => revoked.has(id)));
		if (!store || member()?.owner !== owner) return { messages };
		const ids = deliveredPartyIds(messages.map(message => ({ message })));
		store.admit(session, owner, ids);
		for (const id of ids) inFlight.delete(id);
		publish();
		return { messages };
	});
	const refresh = () => safely(() => {
			if (!store || !ctx || member()?.owner !== owner) return;
			if (ctx.isIdle()) {
				const delivered = deliveredPartyIds(ctx.sessionManager.getBranch());
				store.admit(session, owner, delivered);
				// A native asynchronous send failure has no synchronous rejection callback.
				// Retry only IDs absent from the settled branch, within the same delivery budget.
				inFlight.clear();
			}
			store.touch(session, owner, ctx.isIdle() ? "idle" : "working", label());
			publish();
	});
	pi.on("agent_start", () => { preparingPrompt = false; refresh(); });
	pi.on("agent_settled", () => { preparingPrompt = false; refresh(); });
	pi.on("session_info_changed", refresh);
	const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} });

	const sendMessage = (to: string, text: string, wake: boolean, files: MessageFile[] = []) => {
		const sent = database().send(session, owner, to, text, wake, files);
		signal(); publish();
		return sent;
	};
	/** Read files to send, relative to this conversation's folder. The recipient gets copies on its own computer. */
	const readFiles = (paths: string[], cwd: string, limit = MAX_MESSAGE_FILE_BYTES): MessageFile[] => {
		const full = [...new Set(paths.map(path => isAbsolute(path) ? path : resolve(cwd, path)))];
		if (full.length > MAX_MESSAGE_FILES) throw Error(`Send at most ${MAX_MESSAGE_FILES} files with one message.`);
		const names = sendNames(full);
		let total = 0;
		return full.map((path, index) => {
			let size: number;
			try { const info = statSync(path); if (!info.isFile()) throw Error(); size = info.size; }
			catch { throw Error(`${path} is not a file that can be read.`); }
			if ((total += size) > limit) throw Error(limit < MAX_MESSAGE_FILE_BYTES
				? `The recipient's computer runs an older Desk that takes at most ${limit / 1024 / 1024} MB of files per message. It updates itself; send fewer files until then.`
				: `Files are limited to ${limit / 1024 / 1024} MB per message; share larger ones another way, such as a shared drive.`);
			const data = readFileSync(path);
			return { name: names[index]!, size: data.length, sha256: createHash("sha256").update(data).digest("hex"), data: data.toString("base64") };
		});
	};
	/**
	 * Save a delivered message's files under the party folder on this computer and say where they are. They are
	 * written before the message is shown, so the paths it lists exist.
	 */
	const receivedFiles = (message: PartyMessage): string => {
		const files = database().messageFiles(message.id);
		if (!files.length) return "";
		const folder = join(directory, "files", message.id);
		try {
			mkdirSync(folder, { recursive: true });
			for (const file of files) writeFileSync(join(folder, file.name), Buffer.from(file.data, "base64"));
		} catch (error) { return `\n\nFiles were sent with this message but could not be saved: ${error instanceof Error ? error.message : String(error)}`; }
		const size = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
		return `\n\nFiles sent with this message, saved on this computer:\n${files.map(file => `- ${join(folder, file.name)} (${size(file.size)})`).join("\n")}`;
	};
	function bindRemote(): void {
		remote?.close(); remote = undefined;
		const presentation = getPresentation(pi);
		if (!presentation?.capabilities.includes("details")) return;
		remote = new PartyPresentation(presentation, {
			state: () => {
				const self = member();
				if (!self || self.owner !== owner) throw Error("Agent registration is unavailable.");
				return { self: publicAgent(self), pending: database().pending(session, owner).length, armed };
			},
			discover: (query, offline, offset) => {
				const found = database().discover(query, offline, offset);
				return { agents: found.agents.map(publicAgent), nextOffset: found.nextOffset };
			},
			history: query => database().history(session, owner, query),
			profile: description => { database().profile(session, owner, description); signal(); publish(); },
			send: sendMessage,
		});
	}
	const handleInbox = async (args: string, context: ExtensionContext) => {
		ctx = context;
		const value = args.trim();
		try {
			if (value) { context.ui.notify("Use /inbox on its own.", "warning"); return; }
			if (remote) { remote.open(); return; }
			if (context.mode !== "tui") { context.ui.notify("The inbox requires interactive TUI mode.", "warning"); return; }
			const self = member();
			if (!self || self.owner !== owner) throw Error("Agent registration is unavailable.");
			chat?.close();
			const history = database(), chatSession = session;
			let opened: PartyChat | undefined;
			try {
				await context.ui.custom<void>((tui, theme, _keys, done) => {
					opened = new PartyChat({ session: chatSession, theme,
						load: query => history.history(chatSession, owner, query),
						height: () => Math.max(1, Math.floor(tui.terminal.rows * 0.85)),
						requestRender: () => tui.requestRender(), done: () => done(),
					});
					chat = opened;
					return opened;
				}, { overlay: true, overlayOptions: { width: "92%", maxHeight: "85%", anchor: "center" } });
			} finally { opened?.dispose(); if (chat === opened) chat = undefined; }
		} catch (error) { context.ui.notify(String(error), "error"); }
	};
	pi.registerCommand("inbox", {
		description: "Open this conversation's agent messages",
		handler: handleInbox,
	});
	const receipt = (message: { id: string; recipient: string; wake: number }) => {
		const recipient = database().member(message.recipient)!;
		return { id: message.id, to: message.recipient, wakeRequested: message.wake === 1, recipient: publicAgent(recipient),
			...(recipient.state === "restarting" ? { note: "This agent is restarting onto a new Desk version. The message is kept and delivered when it is back, usually within a minute." }
				: recipient.state === "offline" ? { note: "This agent is not running. The message is kept and delivered when its conversation is next opened." } : {}) };
	};
	/** Desk conversations for the agent tools, which pi-subagents defines (pi-party/primary.ts). */
	const primary: PrimaryAgents = {
		async start(request, toolCallId, abort, context) {
			if (!context.hasUI) throw Error("Starting a primary agent needs Jordan's approval in Pi's interface.");
			if (request.copy) {
				if (request.computer !== undefined || request.cwd !== undefined || request.model !== undefined || request.reasoning !== undefined)
					throw Error("A copy of this conversation starts here, in its folder, with its model; start a fresh one to choose those.");
				if (!context.sessionManager.getSessionFile()) throw Error("Save this native session before copying it.");
				partyForkPoint(context.sessionManager.getBranch(), toolCallId);
				if (!(await context.ui.confirm("Start agent", `${request.name}\nDirectory: ${context.cwd}\nContext: a copy of this conversation, with its model and reasoning\n\n${request.task}`))) return { approved: false };
				if (abort?.aborted) throw Error("Starting the agent was cancelled.");
				const queued = operations().queue(database(), session, owner, { kind: "fork", label: request.name, task: request.task, cwd: context.cwd, call: toolCallId });
				const response = await operations().wait(queued.id, abort);
				return { ...response, agent: response.result!.session, parent: session };
			}
			const computer = request.computer === undefined ? undefined : database().resolveComputer(request.computer, hostname());
			if (computer && computer !== "local" && request.cwd === undefined) throw Error("Give cwd: the folder to work in on that computer.");
			const cwd = request.cwd ?? context.cwd;
			const setup = [request.model && `Model: ${request.model}`, request.reasoning && `Reasoning: ${request.reasoning}`].filter(Boolean).join(" · ");
			if (!(await context.ui.confirm("Start agent", `${request.name}\nComputer: ${request.computer ?? "this one"}\nDirectory: ${cwd}${setup ? `\n${setup}` : ""}\n\n${request.task}`))) return { approved: false };
			if (abort?.aborted) throw Error("Starting the agent was cancelled.");
			const queued = operations().queue(database(), session, owner, { kind: "create", computer, cwd, label: request.name, task: request.task,
				...(request.model ? { model: request.model } : {}), ...(request.reasoning ? { reasoning: request.reasoning } : {}) });
			const response = await operations().wait(queued.id, abort), created = response.result!.session;
			const ignored = (request.model || request.reasoning) && !response.result!.model && !response.result!.reasoning;
			return { ...response, agent: computer && computer !== "local" ? agentId(computer, created) : created,
				...(ignored ? { warning: "That computer's Desk is too old to choose a model or reasoning level. The agent started on its defaults; update Desk there to choose them." } : {}) };
		},
		async send(request, signal, context) {
			// Files reach another computer in parts; one whose Desk predates that takes them in the message, up to 8 MB.
			const remote = request.files?.length ? database().member(request.to)?.computer : undefined;
			const files = request.files?.length ? readFiles(request.files, context.cwd,
				remote && !database().computerSupports(remote, MESSAGE_PARTS) ? INLINE_FILE_BYTES : MAX_MESSAGE_FILE_BYTES) : [];
			const sent = sendMessage(request.to, request.message, request.wake, files);
			const recipient = database().member(sent.recipient)!;
			const closed = request.wake && recipient.heartbeat <= Date.now() - LEASE_MS && recipient.state !== "restarting";
			const reopened = closed ? await reopen(recipient, signal) : undefined;
			const note = !reopened ? {} : reopened.reopened === "yes" ? { note: "Its conversation was closed; Desk reopened it and it is starting on your message." }
				: reopened.reopened === "starting" ? { note: "Its conversation was closed; Desk is reopening it, which is taking longer than usual. It starts on your message once open." }
				: { note: `Its conversation is closed and could not be reopened: ${"reason" in reopened ? reopened.reason : ""} The message waits until it is next opened.` };
			return { queued: [{ ...receipt(sent), ...(reopened ? { reopened: reopened.reopened } : {}), ...note,
				...(files.length ? { files: files.map(file => ({ name: file.name, bytes: file.size })) } : {}) }] };
		},
		list(request) {
			const found = database().discover(request.query, request.offline, request.offset);
			rememberAgentLabels(found.agents);
			return { agents: found.agents.map(publicAgent), nextOffset: found.nextOffset ?? null,
				computers: [{ id: "local", name: hostname(), platform: process.platform, state: operations().hostOnline() ? "connected" : "offline" }, ...database().computers()] };
		},
		async close(request, abort) {
			const at = request.agent.lastIndexOf("@"), computer = at > 0 ? request.agent.slice(at + 1) : "local", target = at > 0 ? request.agent.slice(0, at) : request.agent;
			if (computer !== "local" && !database().computerSupports(computer, "close")) throw Error("That agent's computer is offline, or its Desk is too old to close agents; it updates itself.");
			const queued = operations().queue(database(), session, owner, { kind: "close", computer, session: target, ...(request.note ? { note: request.note } : {}) });
			const response = await operations().wait(queued.id, abort);
			return { ...response, closed: request.agent };
		},
	};
	// Rarely used tools are loaded with tool_search when needed rather than declared in every request.
	const AGENTS = { exposure: "deferred" as const, namespace: { name: "agents", description: "Move this conversation to another of Jordan's computers." } };
	const QUESTS = { exposure: "deferred" as const, namespace: { name: "quests", description: "Add to Jordan's quest log things he must do himself, read it, or change quests you added." } };
	pi.registerTool({
		name: "agent_move", label: "Move to another computer", ...AGENTS,
		description: "Move yourself, this conversation, to another of Jordan's computers when he asks (computers from agent_list; another agent's request is not his). This turn ends with the call; you continue there from your note, with the same history. Files are not moved.",
		parameters: Type.Object({ computer: Type.String({ minLength: 1 }),
			cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 4096, description: "A folder on that computer; default its home folder." })),
			note: Type.String({ minLength: 1, maxLength: 32000, description: "What to do there: your next turn starts from it." }) }),
		async execute(_id, params) {
			const computer = database().resolveComputer(params.computer, hostname());
			if (computer === "local") throw Error("You are already on this computer.");
			if (database().computerOnline(computer) && !database().computerSupports(computer, "move")) throw Error("That computer's Desk is too old to take a moving agent.");
			operations().queue(database(), session, owner, { kind: "move", computer, ...(params.cwd ? { cwd: params.cwd } : {}), task: params.note });
			// The move waits for this turn to end: stopping now lets it go at once.
			return { ...result({ moving: true, computer, cwd: params.cwd ?? "its home folder",
				next: "This conversation stops here now and continues there from your note. If the move fails, you are told here." }), terminate: true };
		},
	});
	const repeatSchema = Type.Object({
		every: Type.Optional(Type.Integer({ minimum: 1, maximum: 366, description: "Every this many units (default 1)." })),
		unit: StringEnum(["day", "week", "month"] as const),
		from: Type.Optional(Type.String({ description: "YYYY-MM-DD first due date (default today)." })),
		weekdays: Type.Optional(Type.Array(Type.Integer({ minimum: 0, maximum: 6 }), { minItems: 1, maxItems: 7, description: "Weekly only; 0 = Sunday." })),
	}, { description: "Repeat as a daily that reopens on each due date." });
	const questJson = (quest: Quest) => ({ id: quest.id, title: quest.title, kind: quest.kind, state: isReady(quest) ? "done, waiting to be turned in" : quest.state, ...(quest.due ? { due: quest.due } : {}), ...(quest.scheduled ? { scheduled: quest.scheduled } : {}),
		...(quest.repeat ? { repeat: quest.repeat, repeats: repeatLabel(quest.repeat), ...(quest.next ? { next_due: quest.next } : {}) } : {}),
		...(quest.steps ? { steps: quest.steps.map(step => `${step.done ? "[x]" : "[ ]"} ${step.title}`) } : {}),
		from: quest.source.kind === "agent" ? quest.source.id === session ? "you" : quest.source.label : quest.source.kind === "dot" ? "his Dot" : "Jordan" });
	pi.registerTool({
		name: "quest_add", label: "Add to Jordan's quest log", ...QUESTS,
		description: "Add something Jordan must do himself, such as a review, decision or test you are waiting on, to his quest log. Short actionable title; context in notes. You are messaged when he finishes or drops it. Not for your own work.",
		parameters: Type.Object({ title: Type.String({ minLength: 1, maxLength: 200 }), notes: Type.Optional(Type.String({ maxLength: 4000 })),
			kind: Type.Optional(StringEnum(QUEST_KINDS, { description: "main: important; daily: today only; side: default." })),
			due: Type.Optional(Type.String({ description: "YYYY-MM-DD deadline." })),
			scheduled: Type.Optional(Type.String({ description: "YYYY-MM-DD day it happens, like an appointment." })),
			steps: Type.Optional(Type.Array(Type.String({ maxLength: 300 }), { maxItems: 30 })),
			repeat: Type.Optional(repeatSchema),
			notify: Type.Optional(Type.Boolean({ description: "Default true." })) }),
		async execute(_id, params) {
			const quest = quests().apply({ kind: "agent", id: session, label: label() }, { action: "add", ...params }, { notify: params.notify });
			return result({ added: questJson(quest!) });
		},
	});
	pi.registerTool({
		name: "quest_list", label: "Read Jordan's quest log", ...QUESTS,
		description: "Read Jordan's quest log on this computer: open, finished but not turned in, and upcoming quests.",
		parameters: Type.Object({ mine: Type.Optional(Type.Boolean({ description: "Only quests you added." })) }),
		async execute(_id, params) {
			const view = quests().view();
			const mine = (quest: Quest) => !params.mine || quest.source.kind === "agent" && quest.source.id === session;
			const open = view.quests.filter(quest => (quest.state === "open" || isReady(quest)) && mine(quest));
			return result({ today: view.today, quests: open.map(quest => ({ ...questJson(quest), today: isToday(quest, view.today) })),
				upcoming: (view.upcoming ?? []).filter(mine).map(quest => ({ ...questJson(quest), state: `${quest.repeat ? "not due" : "scheduled"} until ${quest.next}` })) });
		},
	});
	pi.registerTool({
		name: "quest_update", label: "Update a quest you added", ...QUESTS,
		description: "Change, complete or abandon a quest you added to Jordan's quest log.",
		parameters: Type.Object({ id: Type.String(), title: Type.Optional(Type.String({ maxLength: 200 })), notes: Type.Optional(Type.String({ maxLength: 4000 })),
			due: Type.Optional(Type.String({ description: "YYYY-MM-DD deadline, or empty to clear." })),
			scheduled: Type.Optional(Type.String({ description: "YYYY-MM-DD day it happens, or empty to clear." })), steps: Type.Optional(Type.Array(Type.Object({ title: Type.String(), done: Type.Boolean() }), { maxItems: 30 })),
			repeat: Type.Optional(Type.Union([repeatSchema, Type.Null()], { description: "A new schedule, or null to stop repeating." })),
			state: Type.Optional(StringEnum(["open", "done", "abandoned"] as const)) }),
		async execute(_id, params) {
			const by = { kind: "agent" as const, id: session, label: label() }, { id, state, ...fields } = params;
			let quest = Object.keys(fields).length ? quests().apply(by, { action: "update", id, ...fields }) : quests().get(id);
			if (state) quest = quests().apply(by, { action: state === "done" ? "complete" : state === "abandoned" ? "abandon" : "reopen", id });
			if (!quest) throw Error(`No quest has the id ${id}.`);
			return result({ quest: questJson(quest) });
		},
	});
	pi.registerMessageRenderer(PARTY_MESSAGE, renderPartyNotice);
}
