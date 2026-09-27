import type { Presentation, UiAction, UiDetails, UiValue } from "../pi-ui/index.ts";
import type { HistoryPage, HistoryQuery } from "./store.ts";

export interface PartyPeer {
	id: string; label: string; description: string; cwd: string; kind: string; party: string | null;
	self: boolean; state: string; delivery: string; wakeable: boolean;
}
export interface PartyUiOperations {
	state(): { self: PartyPeer; pending: number; armed: boolean };
	members(): PartyPeer[];
	discover(query: string, offline: boolean, offset: number): { agents: PartyPeer[]; nextOffset?: number };
	history(query: HistoryQuery, direct: boolean): HistoryPage;
	join(room: string): void;
	leave(): void;
	delivery(enabled: boolean): void;
	profile(description: string): void;
	remove(id: string): void;
	send(to: string, text: string, wake: boolean, invite: boolean): void;
}

/** Views and form flow only. PartyStore and the owning extension still perform all operations. */
export class PartyPresentation {
	private active = true;
	private page: "members" | "discover" | "history" | "message" = "members";
	private message?: { text: string; title: string; offset: number };
	private query = "";
	private offline = false;
	private offset = 0;
	private historyQuery: HistoryQuery;
	private direct = false;
	private signature = "";
	private readonly remote: Presentation;
	private readonly ops: PartyUiOperations;

	constructor(remote: Presentation, ops: PartyUiOperations) { this.remote = remote; this.ops = ops; }
	close(): void { this.active = false; this.remote.publish("party", undefined); }
	open(direct?: boolean): void {
		if (direct !== undefined) { this.page = "history"; this.direct = direct; this.historyQuery = undefined; }
		this.refresh(); this.remote.open("party");
	}
	private check(): void { if (!this.active) throw new Error("This party view belongs to a previous session or branch."); }
	private checkParty(expected: string | null): void {
		this.check();
		if (this.ops.state().self.party !== expected) throw new Error("Party membership changed. Review the current party before trying again.");
	}
	private async text(title: string, value = "", multiline = false): Promise<string | undefined> {
		const answer = await this.remote.request({ kind: multiline ? "editor" : "input", title, value });
		this.check();
		return answer?.kind === "freeform" ? answer.text : undefined;
	}
	private async confirm(title: string, message: string): Promise<boolean> {
		const answer = await this.remote.request({ kind: "confirm", title, message });
		this.check();
		return answer?.kind === "confirm" && answer.confirmed;
	}
	private async compose(to: string, invite = false): Promise<void> {
		const party = this.ops.state().self.party;
		const text = await this.text(invite ? "Invitation message" : "Message", "", true);
		if (!text?.trim()) return;
		const answer = await this.remote.request({
			kind: "question", title: "Delivery", options: [
				{ title: "Queue without waking", description: "The message can be read when the peer next works." },
				{ title: "Request a reply", description: "May start the peer when it is available and delivery is enabled." },
			], allowMultiple: false, allowFreeform: false, allowComment: false,
		});
		this.check();
		if (answer?.kind !== "selection" || !answer.selections.length) return;
		this.checkParty(party);
		this.ops.send(to, text, answer.selections[0] === "Request a reply", invite);
		this.page = "history"; this.direct = to !== "all"; this.historyQuery = undefined;
	}

	refresh(): void {
		if (!this.active) return;
		const state = this.ops.state();
		const callbacks: Record<string, (value: UiValue) => Promise<void>> = {};
		const action = (id: string, label: string, run: () => unknown | Promise<unknown>, destructive = false): UiAction => {
			callbacks[id] = async () => {
				this.check();
				try { await run(); }
				finally { if (this.active) { this.signature = ""; this.refresh(); } }
			};
			return { id, label, destructive };
		};
		const controls = [
			action("members", "Members", () => { this.page = "members"; this.offset = 0; }),
			action("discover", "Discover", () => { this.page = "discover"; this.offset = 0; }),
			action("history", "Party history", () => { this.page = "history"; this.direct = false; this.historyQuery = undefined; }),
			action("direct", "Direct messages", () => { this.page = "history"; this.direct = true; this.historyQuery = undefined; }),
			action("join", state.self.party ? "Change party" : "Join a party", async () => {
				const room = await this.text("Party name", state.self.party ?? "");
				this.checkParty(state.self.party);
				if (room?.trim()) { this.ops.join(room.trim()); this.historyQuery = undefined; this.page = "members"; }
			}),
			action("delivery", state.armed && state.self.delivery === "ready" ? "Pause delivery" : "Resume delivery",
				() => this.ops.delivery(!(state.armed && state.self.delivery === "ready"))),
			action("profile", "Edit profile", async () => {
				const description = await this.text("Describe this session's work", state.self.description, true);
				if (description !== undefined) {
					if (this.ops.state().self.description !== state.self.description) throw new Error("The profile changed. Reopen it before saving.");
					this.ops.profile(description);
				}
			}),
		];
		if (state.self.party) controls.push(
			action("broadcast", "Message party", () => this.compose("all")),
			action("leave", "Leave party", async () => {
				if (await this.confirm("Leave party", `Leave ${state.self.party}? Direct messages remain available.`)) {
					this.checkParty(state.self.party); this.ops.leave();
				}
			}, true),
		);
		const details: UiDetails = {
			summary: `${state.self.party ? `Party ${state.self.party}` : "No current party"} · ${state.pending} pending for Pi`,
			fields: [
				{ label: "Session", value: state.self.label },
				{ label: "Delivery", value: state.armed ? state.self.delivery : "Paused until work resumes" },
			], items: [],
		};
		const peerItem = (peer: PartyPeer) => ({
			id: peer.id, title: `${peer.label}${peer.self ? " (you)" : ""}`, subtitle: `${peer.state} · ${peer.kind} · ${peer.party ?? "No party"}`,
			body: `${peer.description}\n${peer.cwd}\n${peer.id}`.trim(), status: `Delivery ${peer.delivery}`,
			actions: peer.self ? [] : [
				action(`send:${peer.id}`, "Message", () => this.compose(peer.id)),
				...(state.self.party && peer.party !== state.self.party ? [
					action(`invite:${peer.id}`, "Invite", () => this.compose(peer.id, true)),
				] : []),
				...(state.self.party && peer.party === state.self.party ? [
					action(`remove:${peer.id}`, "Remove", async () => {
						if (await this.confirm("Remove member", `Remove ${peer.label} from ${state.self.party}? They can rejoin.`)) {
							this.checkParty(state.self.party); this.ops.remove(peer.id);
						}
					}, true),
				] : []),
			],
		});
		if (this.page === "message" && this.message) {
			const message = this.message;
			details.summary = message.title;
			details.items = [{ id: "body", title: "Message", body: message.text.slice(message.offset, message.offset + 12_000),
				status: `${message.offset + 1}–${Math.min(message.text.length, message.offset + 12_000)} of ${message.text.length} characters` }];
			controls.push(action("back", "Back to history", () => { this.page = "history"; this.message = undefined; }));
			if (message.offset) controls.push(action("previous-text", "Previous page", () => { message.offset = Math.max(0, message.offset - 12_000); }));
			if (message.offset + 12_000 < message.text.length) controls.push(action("next-text", "Next page", () => { message.offset += 12_000; }));
		} else if (this.page === "history") {
			const page = this.ops.history(this.historyQuery, this.direct);
			details.summary = `${this.direct || !state.self.party ? "Direct messages" : `Party ${page.room}`} · reading here does not deliver messages to Pi`;
			details.items = page.messages.map(message => ({
				id: message.id, title: `${message.sender_label} → ${message.recipient_label}`,
				subtitle: new Date(message.created).toLocaleString(), body: message.text.slice(0, 8_000),
				status: message.admitted ? "Delivered to Pi" : "Not yet delivered to Pi",
				actions: [
					...(message.kind === "invite" && message.recipient === state.self.id ? [action(`join:${message.id}`, `Join ${message.invite_room}`, () => this.ops.join(message.invite_room))] : []),
					...(message.text.length > 8_000 ? [action(`read:${message.id}`, "Read complete message", () => {
						this.message = { text: message.text, title: `${message.sender_label} → ${message.recipient_label}`, offset: 0 }; this.page = "message";
					})] : []),
				],
			}));
			if (page.hasOlder) controls.push(action("older", "Older messages", () => {
				const first = page.messages[0]!; this.historyQuery = { before: { created: first.created, id: first.id } };
			}));
			if (page.hasNewer) controls.push(action("newer", "Newer messages", () => {
				const last = page.messages.at(-1)!; this.historyQuery = { after: { created: last.created, id: last.id } };
			}));
			controls.push(action("latest", "Latest messages", () => { this.historyQuery = undefined; }));
		} else if (this.page === "discover") {
			const found = this.ops.discover(this.query, this.offline, this.offset);
			details.summary = `Discover local agents${this.query ? ` · ${this.query}` : ""}`;
			details.items = found.agents.map(peerItem);
			controls.push(action("search", "Search agents", async () => {
				const query = await this.text("Name, directory, description or party", this.query);
				if (query !== undefined) { this.query = query; this.offset = 0; }
			}), action("offline", this.offline ? "Hide offline" : "Include offline", () => { this.offline = !this.offline; this.offset = 0; }));
			if (this.offset) controls.push(action("previous", "Previous agents", () => { this.offset = Math.max(0, this.offset - 50); }));
			if (found.nextOffset !== undefined) controls.push(action("next", "More agents", () => { this.offset = found.nextOffset!; }));
		} else {
			const members = this.ops.members();
			details.items = members.slice(this.offset, this.offset + 50).map(peerItem);
			if (this.offset) controls.push(action("previous", "Previous members", () => { this.offset = Math.max(0, this.offset - 50); }));
			if (members.length > this.offset + 50) controls.push(action("next", "More members", () => { this.offset += 50; }));
		}
		const view = { kind: "details", title: "Party", data: details, actions: controls };
		const signature = JSON.stringify(view);
		if (signature !== this.signature) { this.signature = signature; this.remote.publish("party", view, callbacks); }
	}
}
