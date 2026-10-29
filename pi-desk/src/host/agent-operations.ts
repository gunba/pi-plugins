import { homedir, hostname } from "node:os";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createPartyFork } from "../../../pi-agents/fork.ts";
import type { PartyComputer, PartyOperation, OperationResult } from "../../../pi-agents/network.ts";
import type { PartyOperations } from "../../../pi-agents/operations.ts";
import { MESSAGE_PARTS } from "../../../pi-agents/store.ts";
import { RELEASE } from "../shared/release.ts";
import type { ConversationSearch } from "./conversation-search.ts";
import type { ConversationMoves } from "./conversation-moves.ts";
import type { HostCore, ManagedSession, ModelChoice } from "./host-core.ts";
import type { Parties } from "./parties.ts";
import type { PartyNetwork } from "./party-network.ts";
import { configuredSessionDirectory } from "./session-directories.ts";
import { HOLD, type Teleport } from "./teleport.ts";
import { QUEST_LOG, QUEST_NOTICES } from "../../../pi-agents/quest-log.ts";

/** An agent as this computer names it: its id here, or id@computer for one on another computer. */
const requester = (computer: string, sender: string) => computer === "local" ? sender : `${sender}@${computer}`;

/** Set a new agent's requested model and reasoning before its task is admitted. */
export async function applyModelChoice(managed: ManagedSession, request: ModelChoice): Promise<{ model?: string; reasoning?: string }> {
	const worker = managed.worker!, applied: { model?: string; reasoning?: string } = {};
	if (request.model) {
		const models = managed.view.snapshot?.models ?? [];
		const matches = models.filter(model => `${model.provider}/${model.id}` === request.model || model.id === request.model);
		const listed = () => models.slice(0, 60).map(model => `${model.provider}/${model.id}`).join(", ");
		if (!matches.length) throw Error(`Model ${request.model} is not available on this computer. Available: ${listed() || "none"}.`);
		if (matches.length > 1) throw Error(`Model ${request.model} is ambiguous. Use one of: ${matches.map(model => `${model.provider}/${model.id}`).join(", ")}.`);
		await worker.command({ kind: "model", provider: matches[0]!.provider, id: matches[0]!.id });
		applied.model = `${matches[0]!.provider}/${matches[0]!.id}`;
	}
	if (request.reasoning) {
		try { await worker.command({ kind: "thinking", level: request.reasoning }); }
		catch (error) {
			const levels = (await worker.command({ kind: "snapshot" }) as { thinkingLevels?: string[] }).thinkingLevels;
			throw Error(`${error instanceof Error ? error.message : String(error)}${levels?.length ? ` Available: ${levels.join(", ")}.` : ""}`);
		}
		applied.reasoning = request.reasoning;
	}
	return applied;
}

interface AgentHost {
	parties(): Parties;
	operations(): PartyOperations | undefined;
	network(): PartyNetwork | undefined;
	teleport(): Teleport | undefined;
	search?(): ConversationSearch | undefined;
	moves: ConversationMoves;
}

/**
 * What agents ask of this computer through agent messaging, from here or from another computer: start, fork, resume,
 * move or close a conversation. Requests from agents on this computer are carried out here directly.
 */
export class AgentOperations {
	private readonly core: HostCore;
	private readonly host: AgentHost;
	constructor(core: HostCore, host: AgentHost) { this.core = core; this.host = host; }

	/** How this computer describes itself to the others: what they may ask of it. */
	computer(): PartyComputer {
		const teleport = this.host.teleport();
		return { name: hostname(), platform: process.platform, version: RELEASE.version,
			operations: ["create", "fork", "resume", "files", "settings", "close", MESSAGE_PARTS, ...teleport ? [...teleport.operations(), "move"] : [],
				// The computer that keeps conversation copies keeps the account's quest log too.
				...teleport?.operations().includes(HOLD) ? [QUEST_LOG] : [], QUEST_NOTICES, ...this.host.search?.()?.operations() ?? []] };
	}

	/** Carry out the requests agents on this computer have made of it. */
	flushLocal(): void {
		const operations = this.host.operations();
		if (this.core.closing || this.core.held || this.core.restoringUpdate || !operations) return;
		let requests: PartyOperation[];
		try { requests = operations.outgoing("local"); }
		catch { console.error("Party operations could not be read."); return; }
		for (const request of requests) void operations.receive("local", request,
			operation => this.execute("local", operation)).then(result => {
			if (result && !this.core.closing) operations.settle("local", result);
		}).catch(error => { if (!this.core.closing) console.error("Party operation failed:", error instanceof Error ? error.message : String(error)); });
	}

	async execute(computer: string, request: PartyOperation): Promise<OperationResult["result"]> {
		if (this.core.closing || this.core.held || this.core.restoringUpdate) throw Error("Desk is updating or shutting down.");
		const store = this.host.parties().store, operations = this.host.operations()!;
		operations.validate(store, computer, request);
		// As long as the requester waits, leaving time for the reply to reach it.
		const wait = Math.max(30_000, request.expires - Date.now() - 15_000);
		if (request.kind === "resume") return this.resume(request.session!, wait);
		if (request.kind === "move") return this.moveHere(computer, request, wait);
		if (request.kind === "close") return this.closeCreated(computer, request);
		let fork: { cwd: string; file: string } | undefined;
		if (request.kind === "fork") {
			const member = store.member(request.sender)!;
			const file = store.sessionFile(member.session)
				?? SessionManager.findById(member.cwd, member.session, configuredSessionDirectory(member.cwd, this.core.options.agentDir, this.core.options.sessionDir));
			if (!file) throw Error("The source agent\'s saved native session is unavailable.");
			fork = createPartyFork(file, member.session, request.call!);
		}
		const key = this.core.createSession(fork?.cwd ?? request.cwd, fork?.file);
		// The agent that asked may close it later (agent_close), and only it.
		const created = this.core.sessions.get(key);
		if (created) { created.view = { ...created.view, createdBy: requester(computer, request.sender) }; this.core.persist(true); }
		try {
			const managed = await this.core.waitForSession(key, wait), worker = managed.worker!;
			operations.validate(store, computer, request);
			await worker.command({ kind: "name", name: request.label });
			const setup = await applyModelChoice(managed, request);
			operations.validate(store, computer, request);
			this.core.inputs.admit(key, { id: request.id, activation: managed.view.activation!, generation: worker.generation,
				command: { kind: "prompt", text: request.task, behavior: "followUp" } });
			this.core.inputEvent(managed); this.core.drainInputs(managed); this.core.refreshParties(); this.host.network()?.flush();
			return { session: managed.view.agentId!, state: "queued", key, ...setup };
		} catch (error) {
			const managed = this.core.sessions.get(key);
			if (managed?.worker) {
				await managed.worker.close(); managed.worker = undefined;
				managed.view = { ...managed.view, state: "closed", snapshot: undefined, ui: undefined, historyReady: false };
				this.core.emit({ type: "session", session: managed.view }); this.core.persist(true);
			}
			throw error;
		}
	}

	/** Reopen a conversation by its agent id, as the Dot asks. One that is already running is left as it is. */
	private async resume(session: string, wait?: number): Promise<NonNullable<OperationResult["result"]>> {
		const store = this.host.parties().store, managed = [...this.core.sessions.values()].find(item => item.view.agentId === session);
		if (managed?.worker && (managed.view.state === "ready" || managed.view.state === "starting")) return { session, state: "running", key: managed.view.key };
		if (managed?.worker) throw Error("This conversation is still stopping. Try again in a moment.");
		const member = store.member(session);
		const file = managed?.view.file ?? store.sessionFile(session)
			?? (member ? SessionManager.findById(member.cwd, session, configuredSessionDirectory(member.cwd, this.core.options.agentDir, this.core.options.sessionDir)) : undefined);
		if (!file) throw Error("This conversation's saved history is not on this computer.");
		const key = managed ? this.core.createSession(managed.view.cwd, managed.view.file ?? file, managed, true) : this.core.createSession(member?.cwd ?? "", file, undefined, true);
		await this.core.waitForSession(key, wait);
		this.core.refreshParties(); this.host.network()?.flush();
		return { session, state: "resumed", key };
	}

	/**
	 * Closes a conversation the asking agent started with agent_start: a note says so in it, its work is
	 * stopped, and it leaves the sidebar and stops being wakeable. Any other conversation is refused.
	 */
	private async closeCreated(computer: string, request: PartyOperation): Promise<NonNullable<OperationResult["result"]>> {
		const managed = this.host.moves.conversation(request.session!);
		if (!managed) throw new Error("No conversation with that ID is on this computer.");
		if (managed.view.createdBy !== requester(computer, request.sender)) throw new Error("You can close only conversations you started with agent_start.");
		if (managed.worker && managed.view.state === "ready") {
			const note = request.task.trim() ? `Closed by the agent that started it: ${request.task.trim()}` : "Closed by the agent that started it.";
			try { await managed.worker.command({ kind: "note", text: note }); } catch { /* An older worker: closed without the note. */ }
		}
		await this.host.moves.stop(managed);
		return { session: request.session!, state: "closed", key: managed.view.key };
	}

	/** An agent on another computer moves itself here, as Jordan asked it, and continues from its note. */
	private async moveHere(source: string, request: PartyOperation, wait: number): Promise<NonNullable<OperationResult["result"]>> {
		const { key, note } = await this.host.moves.move(source, request.sender, request.cwd.trim() || homedir(), true);
		const managed = await this.core.waitForSession(key, wait);
		await managed.worker!.command({ kind: "continue", text: `${note}\n\nYour note for continuing here:\n${request.task}` });
		return { session: request.sender, state: "moved", key };
	}
}
