import { watch, writeFileSync, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { LEASE_MS, PartyStore, type Member } from "../../../pi-party/store.ts";
import type { PartyDirectory } from "../shared/parties.ts";
import { partyDelivery } from "../../../pi-party/availability.ts";

/** Agent registry metadata for the client, over the same store used by agent messaging. */
export class Parties {
	readonly store: PartyStore;
	private watcher: FSWatcher;
	private timer?: ReturnType<typeof setTimeout>;
	private directory: string;
	private signature = "";
	snapshot: PartyDirectory = { agents: [], groups: [] };
	constructor(agentDir: string, changed: () => void) {
		this.directory = join(agentDir, "party");
		this.store = new PartyStore(this.directory);
		this.watcher = watch(this.directory, (_event, name) => {
			if (String(name) !== "changed") return;
			clearTimeout(this.timer); this.timer = setTimeout(changed, 30);
		});
		this.watcher.on("error", () => this.watcher.close());
	}
	refresh(sessionIds: string[]): boolean {
		const peers = new Map<string, Member>();
		for (const peer of this.store.localMembers()) peers.set(peer.session, peer);
		for (const id of sessionIds) {
			const peer = this.store.member(id);
			if (peer) peers.set(peer.session, peer);
		}
		const now = Date.now();
		const agents = [...peers.values()].map(peer => {
			const state = peer.heartbeat > now - LEASE_MS ? peer.state : "offline";
			return { id: peer.session, label: peer.label, cwd: peer.cwd, description: peer.description, kind: peer.kind, state,
				...partyDelivery(peer, !!peer.delivery, state) };
		}).sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
		const next = { agents, groups: [] }, signature = JSON.stringify(next);
		if (signature === this.signature) return false;
		this.signature = signature; this.snapshot = next; return true;
	}
	networkChanged(): void { writeFileSync(join(this.directory, "network-changed"), randomUUID(), { mode: 0o600 }); }
	close(): void { clearTimeout(this.timer); this.watcher.close(); this.store.close(); }
}
