import type { PartyStore } from "../../../pi-party/store.ts";
import { partyComputer, record, uuid, type PartyComputer, type PartyPacket, type PartyOperation, type OperationResult } from "../../../pi-party/network.ts";
import type { PartyOperations } from "../../../pi-party/operations.ts";

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
	constructor(store: PartyStore, scope: string, changed: () => void, lifecycle?: PartyNetwork["lifecycle"], self?: PartyComputer) {
		this.store = store; this.changed = changed; this.self = self;
		store.setNetworkScope(scope); this.lifecycle = lifecycle; lifecycle?.operations.setScope(scope);
		this.timer = setInterval(() => this.flush(), 10_000); this.timer.unref();
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
		this.peers.set(id, send); this.closers.set(id, close); this.store.setComputerConnected(id, true);
		void this.publish(id, send).catch(() => { this.disconnect(id, send); close(); });
		return () => this.disconnect(id, send);
	}
	private disconnect(id: string, send: Send): void {
		if (this.closed || this.peers.get(id) !== send) return;
		this.peers.delete(id); this.closers.delete(id); this.directories.delete(id);
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
			const agents = this.store.networkDirectory(), signature = JSON.stringify(agents);
			if (this.directories.get(id) === signature) await send({ type: "presence" });
			else { await send({ type: "directory", agents, ...(this.self ? { computer: this.self } : {}) }); this.directories.set(id, signature); }
			if (this.closed || this.peers.get(id) !== send) return;
			const messages = this.store.outgoing(id);
			if (messages.length) await send({ type: "messages", messages });
			const operations = this.lifecycle?.operations.outgoing(id);
			if (operations?.length) await send({ type: "operations", operations });
		} finally { this.flushing.delete(id); }
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
					await send({ type: "directory", agents, ...(this.self ? { computer: this.self } : {}) }); this.directories.set(id, JSON.stringify(agents));
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
		if (packet.type === "directory") {
			const computer = partyComputer(packet.computer);
			if (computer) this.announced.set(id, computer);
			this.store.cacheDirectory(id, packet.agents); this.changed(); return;
		}
		if (packet.type === "messages") {
			if (!Array.isArray(packet.messages) || packet.messages.length > 16) throw Error("Invalid party message batch.");
			const receipts = packet.messages.map(message => this.store.acceptRemoteMessage(id, message));
			this.changed();
			await this.peers.get(id)!({ type: "receipts", receipts }); return;
		}
		if (packet.type === "receipts") { this.store.recordReceipts(id, packet.receipts); this.changed(); return; }
		throw Error("Unknown party packet.");
	}
	close(): void {
		if (this.closed) return;
		clearInterval(this.timer);
		for (const id of this.peers.keys()) if (uuid(id)) this.store.setComputerConnected(id, false);
		this.closed = true; this.peers.clear(); this.closers.clear(); this.directories.clear();
	}
}
