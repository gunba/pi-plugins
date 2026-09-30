import { watch, writeFileSync, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { LEASE_MS, PartyStore, type Member } from "../../../pi-party/store.ts";
import type { PartyDirectory } from "../shared/parties.ts";

/** Metadata and user controls over the same local registry used by pi-party. */
export class Parties {
	private store: PartyStore;
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
		let offset: number | undefined = 0;
		do {
			const page = this.store.discover("", false, offset);
			for (const peer of page.agents) peers.set(peer.session, peer);
			offset = page.nextOffset;
		} while (offset !== undefined);
		for (const id of sessionIds) {
			const peer = this.store.member(id);
			if (peer) peers.set(peer.session, peer);
		}
		const rooms = new Set<string>();
		for (const peer of [...peers.values()]) if (peer.room && !rooms.has(peer.room)) {
			rooms.add(peer.room);
			for (const member of this.store.group(peer.room)) peers.set(member.session, member);
		}
		const now = Date.now();
		const agents = [...peers.values()].map(peer => ({ id: peer.session, label: peer.label, cwd: peer.cwd,
			description: peer.description, kind: peer.kind, party: peer.room || null,
			state: peer.heartbeat > now - LEASE_MS ? peer.state : "offline" })).sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
		const groups = [...rooms].sort().map(name => ({ name, members: agents.filter(agent => agent.party === name).map(agent => agent.id) }));
		const next = { agents, groups }, signature = JSON.stringify(next);
		if (signature === this.signature) return false;
		this.signature = signature; this.snapshot = next; return true;
	}
	setMembership(agents: unknown, room: string | null, expectedRoom?: string): void {
		if (!Array.isArray(agents) || !agents.length || agents.length > 64 || agents.some(id => typeof id !== "string" || id.length > 100)) {
			throw Error("Select 1–64 registered agents.");
		}
		this.store.setMembership(agents, room, expectedRoom);
		writeFileSync(join(this.directory, "changed"), randomUUID(), { mode: 0o600 });
	}
	close(): void { clearTimeout(this.timer); this.watcher.close(); this.store.close(); }
}
