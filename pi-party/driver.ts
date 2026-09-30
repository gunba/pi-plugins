import { randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { PartyStore } from "./store.ts";
import { PartyOperations, type DriverControl } from "./operations.ts";

/** The owning SDK runtime handles child controls; Desk never opens a child as a root. */
export class PartyDriver {
	private store: PartyStore;
	private operations: PartyOperations;
	private watcher: FSWatcher;
	private timer: ReturnType<typeof setInterval>;
	private owner = randomUUID();
	private root: string;
	private file: () => string;
	private children: () => string[];
	private control: (request: DriverControl) => Promise<string>;
	private closed = false;
	private signature = "";
	private refreshed = 0;
	constructor(directory: string, root: string, file: () => string, children: () => string[], control: PartyDriver["control"]) {
		this.root = root; this.file = file; this.children = children; this.control = control;
		this.store = new PartyStore(directory); this.operations = new PartyOperations(directory);
		this.watcher = watch(directory, (_event, name) => {
			if (String(name) === "driver-changed") this.drain();
			else if (["changed", "network-changed"].includes(String(name))) this.wake();
		});
		this.watcher.on("error", () => this.watcher.close()); this.watcher.unref();
		this.timer = setInterval(() => { this.refresh(); this.drain(); this.wake(); }, 10_000); this.timer.unref();
		this.refresh(); this.drain(); this.wake();
	}
	refresh(): void {
		if (this.closed) return;
		const children = this.children(), file = this.file(), signature = JSON.stringify([file, [...children].sort()]);
		if (signature === this.signature && Date.now() - this.refreshed < 10_000) return;
		try {
			this.operations.registerDriver(this.root, this.owner, file, children);
			this.signature = signature; this.refreshed = Date.now();
		} catch { console.error("Party child ownership could not be saved; its presence lease will expire."); }
	}
	private wake(): void {
		if (this.closed) return;
		try {
			this.operations.autoWakes(this.store, this.children(), this.owner, async (computer, request) => {
				const reference = this.operations.driver(request.target!);
				if (!reference || reference.owner !== this.owner) throw Error("The child driver changed before wake admission.");
				this.operations.queueDriver(reference, { id: request.id, kind: "resume", target: request.target!, party: request.party,
					target_epoch: request.target_epoch!, expires: request.expires, peer: { computer, sender: request.sender, epoch: request.sender_epoch } });
				return (await this.operations.waitDriver(request.id)).result;
			});
		} catch { console.error("Party automatic child wakes could not be read."); }
	}
	private drain(): void {
		if (this.closed) return;
		let requests: DriverControl[];
		try { requests = this.operations.driverRequests(this.root, this.owner); }
		catch { console.error("Party child controls could not be read."); return; }
		try {
			for (const request of requests) {
				if (!this.operations.claimDriver(request.id, this.root, this.owner)) continue;
				void this.run(request).catch(() => {});
			}
		} catch { console.error("Party child control admission could not be saved."); }
	}
	private async run(request: DriverControl): Promise<void> {
		try {
			if (request.expires <= Date.now()) throw Error("The child control expired before admission.");
			const target = this.store.member(request.target);
			if (!target || target.computer || target.kind !== "child" || target.room !== request.party || target.epoch !== request.target_epoch
				|| this.operations.driver(request.target)?.owner !== this.owner) throw Error("The child's party membership or owning driver changed.");
			if (request.peer) this.operations.validate(this.store, request.peer.computer, {
				id: request.id, kind: "resume", sender: request.peer.sender, sender_epoch: request.peer.epoch,
				party: request.party, target: request.target, target_epoch: request.target_epoch, created: Date.now(), expires: request.expires,
			});
			const state = request.kind === "resume" && target.muted ? "paused"
				: request.kind === "resume" && target.wakes >= 8 ? "limited"
				: request.kind === "resume" && !this.store.pending(target.session, target.owner).length ? "ready"
				: await this.control(request);
			if (!this.closed) this.operations.finishDriver(request.id, { id: request.id, result: { session: request.target, state } });
		} catch (error) {
			if (!this.closed) this.operations.finishDriver(request.id, { id: request.id, error: (error instanceof Error ? error.message : String(error)).slice(0, 2000) });
		}
	}
	close(): void {
		if (this.closed) return;
		this.closed = true; clearInterval(this.timer); this.watcher.close();
		try { this.operations.stopDriver(this.root, this.owner); }
		catch { console.error("Party child shutdown could not be saved; its presence lease will expire."); }
		finally { this.operations.close(); this.store.close(); }
	}
}
