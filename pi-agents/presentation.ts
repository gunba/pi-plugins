import type { Presentation, UiAction, UiDetails, UiValue } from "../pi-ui/index.ts";
import type { HistoryPage, HistoryQuery } from "./store.ts";

export interface PartyPeer {
	id: string; label: string; description: string; cwd: string; kind: string;
	self: boolean; state: string; delivery: string; wakeable: boolean; deliveryReason?: string;
}
export interface PartyUiOperations {
	state(): { self: PartyPeer; pending: number; armed: boolean };
	discover(query: string, offline: boolean, offset: number): { agents: PartyPeer[]; nextOffset?: number };
	history(query: HistoryQuery): HistoryPage;
	delivery(enabled: boolean): void;
	profile(description: string): void;
	send(to: string, text: string, wake: boolean): void;
}
export const MESSAGES_VIEW = "messages";

/** Views and form flow only. PartyStore and the owning extension still perform all operations. */
export class PartyPresentation {
	private active = true;
	private page: "discover" | "history" | "message" = "history";
	private message?: { text: string; title: string; offset: number };
	private query = "";
	private offline = false;
	private offset = 0;
	private historyQuery: HistoryQuery;
	private signature = "";
	private readonly remote: Presentation;
	private readonly ops: PartyUiOperations;

	constructor(remote: Presentation, ops: PartyUiOperations) { this.remote = remote; this.ops = ops; }
	close(): void { this.active = false; this.remote.publish(MESSAGES_VIEW, undefined); }
	open(): void {
		this.page = "history"; this.historyQuery = undefined;
		this.refresh(); this.remote.open(MESSAGES_VIEW);
	}
	private check(): void { if (!this.active) throw new Error("This messages view belongs to a previous session or branch."); }
	private async text(title: string, value = "", multiline = false): Promise<string | undefined> {
		const answer = await this.remote.request({ kind: multiline ? "editor" : "input", title, value });
		this.check();
		return answer?.kind === "freeform" ? answer.text : undefined;
	}
	private async compose(to: string): Promise<void> {
		const text = await this.text("Message", "", true);
		if (!text?.trim()) return;
		const answer = await this.remote.request({
			kind: "question", title: "Delivery", options: [
				{ title: "Queue without waking", description: "The message can be read when the peer next works." },
				{ title: "Request a reply", description: "May start the peer when it is available and delivery is enabled." },
			], allowMultiple: false, allowFreeform: false, allowComment: false,
		});
		this.check();
		if (answer?.kind !== "selection" || !answer.selections.length) return;
		this.ops.send(to, text, answer.selections[0] === "Request a reply");
		this.page = "history"; this.historyQuery = undefined;
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
			action("history", "Messages", () => { this.page = "history"; this.historyQuery = undefined; }),
			action("discover", "Find agents", () => { this.page = "discover"; this.offset = 0; }),
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
		const details: UiDetails = {
			summary: `${state.pending} pending for Pi`,
			fields: [
				{ label: "Session", value: state.self.label },
				{ label: "Delivery", value: state.armed ? state.self.delivery : "Paused until work resumes" },
				...(state.self.deliveryReason ? [{ label: "Reason", value: state.self.deliveryReason }] : []),
			], items: [],
		};
		const peerItem = (peer: PartyPeer) => ({
			id: peer.id, title: `${peer.label}${peer.self ? " (you)" : ""}`, subtitle: `${peer.state} · ${peer.kind}`,
			body: `${peer.description}\n${peer.cwd}\n${peer.id}`.trim(), status: peer.deliveryReason ?? `Delivery ${peer.delivery}`,
			actions: peer.self ? [] : [action(`send:${peer.id}`, "Message", () => this.compose(peer.id))],
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
			const page = this.ops.history(this.historyQuery);
			details.summary = "Messages · reading here does not deliver them to Pi";
			details.items = page.messages.map(message => ({
				id: message.id, title: `${message.sender_label} → ${message.recipient_label}`,
				subtitle: new Date(message.created).toLocaleString(), body: message.text.slice(0, 8_000),
				status: `${message.admitted ? "Delivered to Pi" : "Queued"} · ${message.wake ? "Reply requested" : "No wake requested"}`,
				actions: [
					...(message.sender !== state.self.id ? [action(`reply:${message.id}`, "Reply", () => this.compose(message.sender))] : []),
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
			details.summary = `Discover agents${this.query ? ` · ${this.query}` : ""}`;
			details.items = found.agents.map(peerItem);
			controls.push(action("search", "Search agents", async () => {
				const query = await this.text("Name, directory or description", this.query);
				if (query !== undefined) { this.query = query; this.offset = 0; }
			}), action("offline", this.offline ? "Hide offline" : "Include offline", () => { this.offline = !this.offline; this.offset = 0; }));
			if (this.offset) controls.push(action("previous", "Previous agents", () => { this.offset = Math.max(0, this.offset - 50); }));
			if (found.nextOffset !== undefined) controls.push(action("next", "More agents", () => { this.offset = found.nextOffset!; }));
		}
		const view = { kind: "details", title: "Messages", data: details, actions: controls };
		const signature = JSON.stringify(view);
		if (signature !== this.signature) { this.signature = signature; this.remote.publish(MESSAGES_VIEW, view, callbacks); }
	}
}
