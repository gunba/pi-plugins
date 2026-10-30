import type { PartyStore } from "../../../pi-agents/store.ts";
import { partyComputer, record, uuid, type PartyComputer, type PartyPacket, type PartyOperation, type OperationResult } from "../../../pi-agents/network.ts";
import type { PartyOperations } from "../../../pi-agents/operations.ts";
import { QUEST_LOG, QUEST_NOTICES } from "../../../pi-agents/quest-log.ts";
import type { HostQuests } from "./host-quests.ts";
import { SEARCH_PACKET_TYPES, type SearchPacket } from "../shared/conversation-search.ts";
import type { ConversationSearch, SearchBinding } from "./conversation-search.ts";
import type { SettingsSync } from "./settings-sync.ts";
import { TELEPORT_PACKETS, type Teleport, type TeleportPacket } from "./teleport.ts";
import { HANDS, HANDS_PACKETS, type HandsPacket } from "../shared/hands.ts";
import type { Hands, HandsBinding } from "./hands.ts";

type Send = (payload: PartyPacket) => Promise<void>;

/** Desk forwards the native registry/outbox; Pi processes retain ownership and delivery budgets. */
export class PartyNetwork {
	private store: PartyStore;
	private changed: () => void;
	private peers = new Map<string, Send>();
	private closers = new Map<string, () => void>();
	private flushing = new Set<string>();
	private directories = new Map<string, string>();
	private timer: ReturnType<typeof setInterval>;
	private closed = false;
	private lifecycle?: { operations: PartyOperations; execute(computer: string, request: PartyOperation): Promise<OperationResult["result"]> };
	/** This computer, as announced with its directory, and what each peer announced (older hosts announce nothing). */
	private self?: PartyComputer;
	private announced = new Map<string, PartyComputer>();
	private sync?: SettingsSync;
	/** The settings manifest last sent to each computer. */
	private manifests = new Map<string, string>();
	private teleport?: Teleport;
	private search?: ConversationSearch;
	private searchBinding?: SearchBinding;
	/** When this computer last asked each computer for a file part, while waiting for it. */
	private asking = new Map<string, number>();
	private quests?: HostQuests;
	/** Computers sent a batch of this computer's old quests, or of notices for their agents, not taken yet. */
	private handing = new Set<string>();
	private noticing = new Set<string>();
	private hands?: Hands;
	private handsBinding?: HandsBinding;
	constructor(store: PartyStore, scope: string, changed: () => void, lifecycle?: PartyNetwork["lifecycle"], self?: PartyComputer, sync?: SettingsSync, teleport?: Teleport, search?: ConversationSearch,
		quests?: HostQuests, hands?: Hands) {
		this.store = store; this.changed = changed; this.self = self; this.sync = sync; this.teleport = teleport; this.quests = quests;
		store.setNetworkScope(scope); this.lifecycle = lifecycle; lifecycle?.operations.setScope(scope);
		this.timer = setInterval(() => this.flush(), 10_000); this.timer.unref();
		this.search = search;
		if (search) {
			this.searchBinding = { scope, computers: () => this.computers(), send: (id, packet) => this.send(id, packet), flush: () => this.flush() };
			search.bind(this.searchBinding);
		}
		this.hands = hands;
		if (hands) {
			this.handsBinding = { send: (id, packet) => this.send(id, packet), peer: id => {
				const announced = this.announced.get(id);
				return { online: this.peers.has(id), supports: !!announced?.operations.includes(HANDS), ...(announced?.name ? { name: announced.name } : {}) };
			} };
			hands.bind(this.handsBinding);
		}
	}
	/** Other computers in this workspace, with what they announced; an empty operations list means an older Desk. */
	computers(): { id: string; online: boolean; name?: string; platform?: string; version?: string; operations: string[] }[] {
		return this.store.computers().map(({ id, state }) => {
			const announced = this.announced.get(id);
			return { id, online: state === "connected", ...(announced ? { name: announced.name, platform: announced.platform, version: announced.version } : {}),
				operations: announced?.operations ?? [] };
		});
	}
	connected(id: string, send: Send, close: () => void): () => void {
		if (this.closed) throw Error("Party network is closed.");
		this.search?.disconnected(id);
		this.peers.set(id, send); this.closers.set(id, close); this.store.setComputerConnected(id, true);
		void this.publish(id, send).catch(() => { this.disconnect(id, send); close(); });
		return () => this.disconnect(id, send);
	}
	private disconnect(id: string, send: Send): void {
		if (this.closed || this.peers.get(id) !== send) return;
		this.peers.delete(id); this.closers.delete(id); this.directories.delete(id); this.manifests.delete(id); this.teleport?.disconnected(id); this.search?.disconnected(id); this.hands?.disconnected(id); this.asking.delete(id); this.handing.delete(id); this.noticing.delete(id);
		try { this.store.setComputerConnected(id, false); this.changed(); }
		catch { console.error("Party connection state could not be saved; its presence lease will expire."); }
	}
	flush(): void {
		if (this.closed) return;
		for (const [id, send] of this.peers) void this.publish(id, send).catch(() => {
			const close = this.closers.get(id); this.disconnect(id, send); close?.();
		});
	}
	private async publish(id: string, send: Send): Promise<void> {
		if (this.closed || this.flushing.has(id) || this.peers.get(id) !== send) return;
		this.flushing.add(id);
		try {
			// What this computer announces is part of it: a changed announcement (keeping copies, say) is sent again.
			const agents = this.store.networkDirectory(), signature = JSON.stringify([agents, this.self]);
			if (this.directories.get(id) === signature) await send({ type: "presence" });
			else { await send({ type: "directory", agents, ...(this.self ? { computer: this.self } : {}) }); this.directories.set(id, signature); }
			if (this.closed || this.peers.get(id) !== send) return;
			const messages = this.store.outgoing(id);
			if (messages.length) await send({ type: "messages", messages });
			const operations = this.lifecycle?.operations.outgoing(id);
			if (operations?.length) await send({ type: "operations", operations });
			// The quest log's calls, and the quests this computer kept before, go to the computer that keeps it.
			if (this.quests && this.quests.server()?.id === id && this.announced.get(id)?.operations.includes(QUEST_LOG)) {
				const calls = this.quests.outgoing();
				if (calls.length) await send({ type: "quest-calls", calls });
				const quests = this.handing.has(id) ? [] : this.quests.leftover();
				if (quests.length) { this.handing.add(id); await send({ type: "quest-import", quests }); }
			}
			if (this.quests && !this.noticing.has(id) && this.announced.get(id)?.operations.includes(QUEST_NOTICES)) {
				const notices = this.quests.notices(id);
				if (notices.length) { this.noticing.add(id); await send({ type: "quest-notices", notices }); }
			}
			// Pi settings go only to computers that say they mirror them; older ones would refuse the packet.
			if (this.sync && this.announced.get(id)?.operations.includes("settings")) {
				const manifest = this.sync.manifest(), signature = JSON.stringify(manifest);
				if (this.manifests.get(id) !== signature) { await send({ type: "settings", manifest }); this.manifests.set(id, signature); }
			}
			// Conversation copies and moves, to computers that announce them.
			if (this.teleport) for (const packet of this.teleport.outgoing(id, this.announced.get(id)?.operations ?? [])) {
				if (this.closed || this.peers.get(id) !== send) return;
				await send(packet as PartyPacket);
			}
			await this.search?.publish(id, this.announced.get(id)?.operations ?? [], packet => {
				if (this.closed || this.peers.get(id) !== send) return Promise.reject(Error("The search peer disconnected."));
				return send(packet as PartyPacket);
			});
		} finally { this.flushing.delete(id); }
	}
	/** Ask a computer for the next part of a held message's files: one at a time, so a large set never fills the channel. */
	private async askForPart(id: string): Promise<void> {
		const asked = this.asking.get(id);
		if (asked && Date.now() - asked < 120_000) return;
		const next = this.store.nextFilePart(id), send = this.peers.get(id);
		if (!next || !send) { this.asking.delete(id); return; }
		this.asking.set(id, Date.now());
		await send({ type: "message-file-request", ...next });
	}
	async receive(id: string, raw: unknown): Promise<void> {
		if (this.closed || !this.peers.has(id)) throw Error("Party computer is disconnected.");
		const packet = record(raw);
		if (packet.type === "operations") {
			if (!this.lifecycle || !Array.isArray(packet.operations) || packet.operations.length > 8) throw Error("Invalid party operations.");
			const lifecycle = this.lifecycle, send = this.peers.get(id)!;
			for (const request of packet.operations) void lifecycle.operations.receive(id, request, operation => lifecycle.execute(id, operation))
				.then(async result => {
					if (!result || this.closed || this.peers.get(id) !== send) return;
					const agents = this.store.networkDirectory();
					await send({ type: "directory", agents, ...(this.self ? { computer: this.self } : {}) }); this.directories.set(id, JSON.stringify([agents, this.self]));
					await send({ type: "operation-results", results: [result] });
				})
				.catch(() => { if (this.peers.get(id) === send) this.closers.get(id)?.(); });
			return;
		}
		if (packet.type === "operation-results") {
			if (!this.lifecycle || !Array.isArray(packet.results) || packet.results.length > 8) throw Error("Invalid party operation results.");
			for (const result of packet.results) this.lifecycle.operations.settle(id, result);
			return;
		}
		if (packet.type === "presence") { this.store.touchComputer(id); return; }
		if (this.quests && packet.type === "quest-calls") {
			if (!Array.isArray(packet.calls) || packet.calls.length > 16) throw Error("Invalid quest calls.");
			const quests = this.quests, replies = [];
			for (const call of packet.calls) replies.push(await quests.serve(id, call).catch(() => ({ id: String((call as { id?: unknown })?.id), error: "Invalid quest call." })));
			await this.peers.get(id)?.({ type: "quest-replies", replies }); return;
		}
		if (this.quests && packet.type === "quest-replies") {
			if (!Array.isArray(packet.replies) || packet.replies.length > 16) throw Error("Invalid quest replies.");
			for (const reply of packet.replies) this.quests.settle(reply);
			return;
		}
		if (this.quests && packet.type === "quest-import") {
			// A batch that cannot be taken is left with its sender (sent again after a reconnect); the link stays up.
			let ids: string[];
			try { ids = this.quests.take(id, packet.quests); }
			catch (error) { console.error(`Quests from another computer could not be taken: ${error instanceof Error ? error.message : String(error)}`); return; }
			await this.peers.get(id)?.({ type: "quest-imported", ids }); return;
		}
		if (this.quests && packet.type === "quest-notices") {
			if (!Array.isArray(packet.notices) || packet.notices.length > 16) throw Error("Invalid quest notices.");
			for (const notice of packet.notices) this.quests.deliver(String(notice.agent), String(notice.text).slice(0, 4000));
			this.changed();
			await this.peers.get(id)?.({ type: "quest-notices-taken", ids: packet.notices.map(notice => Number(notice.id)) }); return;
		}
		if (this.quests && packet.type === "quest-notices-taken") {
			if (!Array.isArray(packet.ids)) throw Error("Invalid quest notice receipt.");
			this.noticing.delete(id); this.quests.noticesTaken(id, packet.ids.map(Number)); return;
		}
		if (this.quests && packet.type === "quest-imported") {
			if (!Array.isArray(packet.ids)) throw Error("Invalid quest receipt.");
			this.handing.delete(id); this.quests.taken(packet.ids.map(String)); this.changed(); return;
		}
		if (packet.type === "directory") {
			const computer = partyComputer(packet.computer);
			if (computer) { this.announced.set(id, computer); this.store.setComputerOperations(id, computer.operations, computer.name, computer.platform); this.search?.announced(id, computer.operations); }
			this.store.cacheDirectory(id, packet.agents); this.changed(); return;
		}
		if (packet.type === "messages") {
			if (!Array.isArray(packet.messages) || packet.messages.length > 16) throw Error("Invalid party message batch.");
			// A message whose files come in parts has no receipt until they have arrived (store.ts holdForParts).
			const receipts = packet.messages.map(message => this.store.acceptRemoteMessage(id, message)).filter(receipt => receipt !== undefined);
			this.changed();
			if (receipts.length) await this.peers.get(id)!({ type: "receipts", receipts });
			await this.askForPart(id); return;
		}
		if (packet.type === "message-file-request") {
			const offset = Number(packet.offset), part = Number.isSafeInteger(offset) && offset >= 0
				? this.store.filePart(id, String(packet.message), String(packet.name), offset) : undefined;
			await this.peers.get(id)?.({ type: "message-file-part", message: String(packet.message), name: String(packet.name), offset,
				...(part?.length ? { data: part.toString("base64") } : { error: "The sender no longer has this file." }) });
			return;
		}
		if (packet.type === "message-file-part") {
			this.asking.delete(id);
			const receipt = this.store.addFilePart(id, packet);
			if (receipt) { this.changed(); await this.peers.get(id)?.({ type: "receipts", receipts: [receipt] }); }
			await this.askForPart(id); return;
		}
		if (packet.type === "receipts") { this.store.recordReceipts(id, packet.receipts); this.changed(); return; }
		if (packet.type === "settings" && this.sync) {
			const keys = this.sync.compare(packet.manifest);
			if (keys.length) await this.peers.get(id)?.({ type: "settings-request", keys });
			return;
		}
		if (packet.type === "settings-request" && this.sync) {
			let batch: unknown[] = [], size = 0;
			for (const file of this.sync.serve(packet.keys)) {
				if (size && size + (file.data?.length ?? 0) > 1024 * 1024) { await this.peers.get(id)?.({ type: "settings-files", files: batch }); batch = []; size = 0; }
				batch.push(file); size += file.data?.length ?? 0;
			}
			if (batch.length) await this.peers.get(id)?.({ type: "settings-files", files: batch });
			return;
		}
		if (packet.type === "settings-files" && this.sync) {
			const from = this.announced.get(id)?.name ?? id;
			if (this.sync.apply(packet.files, from)) { this.manifests.clear(); this.changed(); }
			return;
		}
		if (this.teleport && TELEPORT_PACKETS.has(String(packet.type))) {
			await this.teleport.receive(id, packet as unknown as TeleportPacket, reply => this.send(id, reply));
			return;
		}
		if (this.search && SEARCH_PACKET_TYPES.has(String(packet.type))) {
			const send = this.peers.get(id)!;
			await this.search.receive(id, packet, reply => {
				if (this.closed || this.peers.get(id) !== send) return Promise.reject(Error("The search peer disconnected."));
				return send(reply as PartyPacket);
			});
			return;
		}
		if (this.hands && HANDS_PACKETS.has(String(packet.type))) {
			const send = this.peers.get(id)!;
			// Not awaited: a long command must not hold up this computer's other packets.
			this.hands.receive(id, packet as unknown as HandsPacket, reply => this.peers.get(id) === send ? send(reply as unknown as PartyPacket)
				: Promise.reject(Error("The computer disconnected.")));
			return;
		}
		throw Error("Unknown party packet.");
	}
	/** This computer's announcement changed (what it supports): every computer is sent it again. */
	reannounce(self: PartyComputer): void { this.self = self; this.directories.clear(); this.flush(); }
	/** One packet to a connected computer. */
	send(id: string, packet: TeleportPacket | SearchPacket | HandsPacket): Promise<void> {
		const send = this.peers.get(id);
		return send ? send(packet as PartyPacket) : Promise.reject(new Error("That computer is not connected."));
	}
	close(): void {
		if (this.closed) return;
		clearInterval(this.timer);
		if (this.searchBinding) this.search?.unbind(this.searchBinding);
		if (this.handsBinding) this.hands?.unbind(this.handsBinding);
		for (const id of this.peers.keys()) if (uuid(id)) this.store.setComputerConnected(id, false);
		this.closed = true; this.peers.clear(); this.closers.clear(); this.directories.clear();
	}
}
