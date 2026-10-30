import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { hostname } from "node:os";
import type { PartyOperation } from "../../../pi-agents/network.ts";
import type { ConversationCopy } from "../shared/protocol.ts";
import type { HostCore, ManagedSession } from "./host-core.ts";
import { homeFolder } from "./local-path.ts";
import type { Parties } from "./parties.ts";
import type { PartyNetwork } from "./party-network.ts";
import { configuredSessionDirectory } from "./session-directories.ts";
import { HANDS } from "../shared/hands.ts";
import { COPIES, HOLD, placeMoved, sessionFolder, type Conversation, type Move, type Teleport } from "./teleport.ts";

interface MoveHost {
	teleport(): Teleport | undefined;
	parties(): Parties | undefined;
	network(): PartyNetwork | undefined;
	/** This computer's device id in the workspace, once it is signed in. */
	self(): string | undefined;
	/** Whether an agent's request to move itself is in progress. */
	moving(session: string): boolean | undefined;
}

/**
 * Moving conversations between computers, and this computer's side of conversation copies (teleport.ts): which of
 * its conversations are copied, the copies kept here, and stopping a conversation here when it moves away.
 */
export class ConversationMoves {
	private readonly core: HostCore;
	private readonly host: MoveHost;
	constructor(core: HostCore, host: MoveHost) { this.core = core; this.host = host; }

	/** Kept copies for the app: those open on their computer when it was last seen come first, and say so. */
	keptCopies(): ConversationCopy[] {
		const open = new Map<string, Set<string>>();
		const isOpen = (copy: ConversationCopy) => {
			let sessions = open.get(copy.computer);
			if (!sessions) open.set(copy.computer, sessions = new Set(this.host.parties()?.store.openSessions(copy.computer) ?? []));
			return sessions.has(copy.session);
		};
		return this.host.teleport()!.copies().filter(copy => !copy.moved).map(copy => isOpen(copy) ? { ...copy, open: true } : copy)
			.sort((a, b) => Number(!!b.open) - Number(!!a.open) || b.updated - a.updated).slice(0, 200);
	}

	/** This computer's conversations that are copied to the computers that keep copies. */
	copyable(): Conversation[] {
		const seen = new Set<string>();
		return [...this.core.sessions.values()].flatMap(entry => {
			const session = entry.view.agentId ?? entry.view.snapshot?.id;
			if (!session || seen.has(session)) return [];
			seen.add(session);
			const managed = this.conversation(session)!, file = managed.view.snapshot?.file ?? managed.view.file;
			const title = managed.view.snapshot?.name ?? managed.view.name ?? managed.view.snapshot?.title ?? managed.view.title;
			return session && file ? [{ session, file, cwd: managed.view.cwd, ...(title ? { title } : {}) }] : [];
		});
	}

	/**
	 * This computer's entries for a conversation, the current one first. One that went to another computer and came back
	 * has older entries here too (the file it left from, an earlier return): they must not be moved or copied.
	 */
	conversations(session: string): ManagedSession[] {
		const teleport = this.host.teleport();
		const current = (managed: ManagedSession) => Number(!managed.view.moved && !teleport?.superseded(session, managed.view.snapshot?.file ?? managed.view.file ?? ""));
		return [...this.core.sessions.values()].filter(managed => (managed.view.agentId ?? managed.view.snapshot?.id) === session)
			.sort((a, b) => current(b) - current(a) || Number(!!b.worker) - Number(!!a.worker) || (b.view.created ?? 0) - (a.view.created ?? 0));
	}

	conversation(session: string): ManagedSession | undefined { return this.conversations(session)[0]; }

	/** Stops a conversation here for good: it moved, or is moving, to another computer. */
	async stop(managed: ManagedSession, moved?: Move): Promise<void> {
		const worker = managed.worker;
		if (worker) {
			managed.keepOnClose = false;
			await worker.submitControl({ kind: "close" }, worker.generation, randomUUID());
			for (let wait = 0; wait < 600 && managed.worker === worker; wait++) await new Promise(resolve => setTimeout(resolve, 100));
			if (managed.worker === worker) throw new Error("The conversation did not stop in time.");
		}
		managed.view = { ...managed.view, state: "closed", kept: undefined, wakes: undefined, watching: undefined, watchEvery: undefined, asleep: undefined, waiting: undefined, ...(moved ? { moved } : {}) };
		this.core.persist(true); this.core.emit({ type: "session", session: managed.view });
	}

	/** Another computer took this conversation over: stop it here. */
	async retire(session: string, move: Move): Promise<void> {
		for (const managed of this.conversations(session))
			await this.stop(managed, move).catch(error => console.error(`A moved conversation could not be stopped here: ${error instanceof Error ? error.message : String(error)}`));
	}

	/** Gives a conversation up for a move: stopped here, its file handed over. Refused while it is working or asking. */
	async release(session: string): Promise<{ file: string; cwd: string; title?: string }> {
		const managed = this.conversation(session), file = managed && (managed.view.snapshot?.file ?? managed.view.file);
		if (!managed || !file) throw new Error("That conversation is not on this computer.");
		const busy = () => ["running", "waiting"].includes(managed.view.snapshot?.activity ?? "");
		// An agent moving itself asked during its turn, which that call ends: give the turn time to finish.
		for (let wait = 0; busy() && wait < 600 && this.host.moving(session); wait++) await new Promise(resolve => setTimeout(resolve, 100));
		if (busy()) throw new Error("It is working on its computer: let it finish, or stop it, then move it.");
		const title = managed.view.snapshot?.name ?? managed.view.name ?? managed.view.snapshot?.title ?? managed.view.title;
		await this.stop(managed);
		return { file, cwd: managed.view.cwd, ...(title ? { title } : {}) };
	}

	/** An agent's move to another computer did not happen: it is told, or, if it was already stopped, its conversation says so. */
	async failed(request: PartyOperation, computer: string, error: string): Promise<void> {
		if (this.host.teleport()?.movedAway(request.sender)) return;
		const managed = this.conversation(request.sender);
		if (!managed) return;
		const name = this.host.network()?.computers().find(item => item.id === computer)?.name ?? "the other computer";
		const text = `Your move to ${name} did not happen: ${error} You are still on ${hostname()} (${managed.view.snapshot?.cwd ?? managed.view.cwd}). Tell Jordan.`;
		if (managed.worker && managed.view.state === "ready") {
			try { await managed.worker.command({ kind: "continue", text }); return; } catch { /* An older worker: shown on the conversation instead. */ }
		}
		managed.view = { ...managed.view, kept: managed.view.state === "closed" || managed.view.kept, error: `Move to ${name} failed: ${error}` };
		this.core.persist(true); this.core.emit({ type: "session", session: managed.view });
	}

	/**
	 * Opens another computer's conversation here, in `cwd`: from its own computer when that is on (which stops it there),
	 * otherwise from a kept copy. The move is recorded and shared, so the original never runs again. With `hands`, its
	 * file and shell tools keep acting in the folder it was in on its computer, which must be on for them to work.
	 */
	async move(source: string, session: string, cwd: string, asked = false, hands = false): Promise<{ key: string; note: string }> {
		const teleport = this.host.teleport(), network = this.host.network(), self = this.host.self();
		if (!teleport || !network || !self) throw new Error("Moving a conversation needs your workspace.");
		if (source === self) throw new Error("This conversation is already on this computer.");
		let folder: string;
		try { folder = realpathSync(homeFolder(cwd)); if (!statSync(folder).isDirectory()) throw new Error(); } catch { throw new Error(`${cwd} is not a folder on this computer.`); }
		const computers = network.computers(), name = (id: string) => computers.find(computer => computer.id === id)?.name ?? "its computer";
		if (hands && !computers.find(computer => computer.id === source)?.operations.includes(HANDS))
			throw new Error(`${name(source)} runs an older Desk that can't act for other computers: update Desk there first.`);
		const owner = computers.find(computer => computer.id === source && computer.online && computer.operations.includes(COPIES));
		let fetched = owner ? await teleport.fetch(packet => network.send(source, packet), source, session, true) : teleport.copyLocal(source, session);
		if (!fetched) {
			let failure: unknown;
			for (const holder of computers.filter(computer => computer.online && computer.operations.includes(HOLD))) {
				try { fetched = await teleport.fetch(packet => network.send(holder.id, packet), source, session, false); break; } catch (error) { failure = error; }
			}
			if (!fetched) throw failure instanceof Error ? failure : new Error(`${name(source)} is off, and no computer that is on keeps a copy of this conversation.`);
		}
		if (hands && !fetched.cwd) throw new Error(`${name(source)} did not say which folder the conversation was in, so its tools can't stay there.`);
		const binding = hands ? { computer: source, name: name(source), platform: computers.find(computer => computer.id === source)?.platform ?? "", folder: fetched.cwd! } : null;
		const note = binding ? `This conversation moved${asked ? ", as you asked," : ""} from ${binding.name} to ${hostname()}. Its read, write, edit and bash tools still act on ${binding.name}, in ${binding.folder}; everything else runs on ${hostname()}.`
			: `This conversation moved${asked ? ", as you asked," : ""} from ${name(source)}${fetched.cwd ? ` (${fetched.cwd})` : ""} to ${hostname()} (${folder}). Files, paths and tools from earlier in it may differ or be missing here: check before relying on them.`;
		// An agent that asked to move gets the note as the message that starts its next turn instead.
		const { agentDir, sessionDir } = this.core.options;
		const file = placeMoved(fetched.file, sessionFolder(agentDir, folder, configuredSessionDirectory(folder, agentDir, sessionDir)), folder, asked ? undefined : note, binding);
		teleport.record(session, { from: source, to: self, at: Date.now(), file: realpathSync(file) });
		network.flush();
		return { key: this.core.createSession(folder, file), note };
	}
}
