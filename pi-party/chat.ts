import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, matchesKey, Spacer, Text, truncateToWidth, visibleWidth, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { safeWorkText } from "../pi-work-ui/view.ts";
import type { HistoryPage, HistoryQuery } from "./store.ts";

interface ChatOptions {
	room: string;
	session: string;
	load: (query?: HistoryQuery) => HistoryPage;
	theme: Theme;
	height: () => number;
	requestRender: () => void;
	done: () => void;
}

/** A bounded page of complete messages. Navigation and refresh only read history. */
export class PartyChat implements Component {
	private options: ChatOptions;
	private page: HistoryPage;
	private content: Component[] = [];
	private signature = "";
	private top = 0;
	private total = 0;
	private viewport = 1;
	private live = true;
	private newer = false;
	private error = "";
	private closed = false;
	private width = 0;
	private height = 0;

	constructor(options: ChatOptions) {
		this.options = options;
		this.page = { room: options.room, messages: [], hasOlder: false, hasNewer: false };
		this.latest();
	}
	private load(query?: HistoryQuery): HistoryPage {
		const page = this.options.load(query);
		if (page.room !== this.options.room) throw Error("Party membership changed. Close and reopen the chat.");
		return page;
	}
	private attempt(action: () => void): void {
		if (this.closed) return;
		try { action(); this.error = ""; }
		catch (error) { this.error = safeWorkText(error instanceof Error ? error.message : String(error)); }
		this.options.requestRender();
	}
	private install(page: HistoryPage): void {
		this.page = page;
		const signature = JSON.stringify(page.messages.map(message => [message.id, message.admitted, message.sender_label, message.recipient_label]));
		if (signature === this.signature) return;
		this.signature = signature;
		const theme = this.options.theme;
		const participant = (id: string, label: string) => `${safeWorkText(label)}${id === this.options.session ? " (you)" : ""}`;
		this.content = page.messages.flatMap(message => {
			const time = new Date(message.created).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
			const route = `${participant(message.sender, message.sender_label)} → ${participant(message.recipient, message.recipient_label)}`;
			const delivery = message.admitted ? "Delivered" : "Queued";
			const wake = message.wake ? "reply requested" : "FYI";
			return [new Text(theme.fg("accent", theme.bold(route)) + "\n" + theme.fg("muted", `${time} · ${delivery} · ${wake}`), 0, 0),
				new Markdown(safeWorkText(message.text, true), 0, 0, getMarkdownTheme()), new Spacer(1)];
		});
		if (!this.content.length) this.content.push(new Text(theme.fg("muted", "No messages yet. Messages sent with party_send will appear here."), 0, 0));
	}
	refresh(): void {
		this.attempt(() => {
			const latest = this.load();
			if (this.live) { this.install(latest); this.newer = false; }
			else this.newer = latest.messages.at(-1)?.id !== this.page.messages.at(-1)?.id;
		});
	}
	private latest(): void {
		this.attempt(() => { this.install(this.load()); this.live = true; this.newer = false; });
	}
	private oldest(): void {
		this.attempt(() => { this.install(this.load({ oldest: true })); this.live = false; this.top = 0; this.newer = this.page.hasNewer; });
	}
	private adjacent(older: boolean): void {
		this.attempt(() => {
			const cursor = older ? this.page.messages[0] : this.page.messages.at(-1);
			if (!cursor || (older && !this.page.hasOlder)) return;
			const next = this.load(older ? { before: cursor } : { after: cursor });
			if (!next.messages.length) return;
			this.install(next);
			this.live = false;
			this.top = older ? Number.MAX_SAFE_INTEGER : 0;
			this.newer = next.hasNewer;
		});
	}
	private scroll(delta: number): void {
		const end = Math.max(0, this.total - this.viewport);
		if (delta < 0 && this.top === 0 && this.page.hasOlder) { this.adjacent(true); return; }
		if (delta > 0 && this.top >= end && (this.page.hasNewer || this.newer)) { this.adjacent(false); return; }
		this.live = false;
		this.top = Math.max(0, Math.min(end, this.top + delta));
		this.options.requestRender();
	}
	handleInput(data: string): void {
		if (this.closed) return;
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") this.close();
		else if (matchesKey(data, "up")) this.scroll(-1);
		else if (matchesKey(data, "down")) this.scroll(1);
		else if (matchesKey(data, "pageUp")) this.scroll(-this.viewport);
		else if (matchesKey(data, "pageDown") || data === " ") this.scroll(this.viewport);
		else if (matchesKey(data, "left")) this.adjacent(true);
		else if (matchesKey(data, "right")) this.adjacent(false);
		else if (matchesKey(data, "home")) this.oldest();
		else if (matchesKey(data, "end")) this.latest();
		else if (data === "r") this.refresh();
	}
	handleMouse(event: TuiMouseEvent) {
		if (this.closed || event.alt || event.ctrl || event.shift) return;
		if (event.type === "wheel") { this.scroll(event.wheelDelta ?? 0); return { handled: true }; }
		if (event.type === "click" && event.button === "left") {
			if (event.y === 0 && event.x >= this.width - 5) this.close();
			else if (event.y === this.height - 2) this.latest();
			return { handled: true };
		}
	}
	close(): void { if (!this.closed) { this.closed = true; this.options.done(); } }
	dispose(): void { this.closed = true; }
	invalidate(): void { this.signature = ""; this.install(this.page); }
	render(width: number): string[] {
		if (this.closed || width < 1) return [];
		this.width = Math.floor(width);
		this.height = Math.max(1, Math.floor(this.options.height()));
		this.viewport = Math.max(1, this.height - 5);
		const inner = Math.max(1, this.width - 4);
		const lines = this.content.flatMap(component => component.render(inner));
		this.total = lines.length;
		const end = Math.max(0, this.total - this.viewport);
		this.top = this.live ? end : Math.min(this.top, end);
		const theme = this.options.theme;
		const fit = (line: string) => truncateToWidth(line, this.width, "…");
		const frame = (line: string) => {
			const body = truncateToWidth(line, inner, "…");
			return fit(theme.fg("border", "│ ") + body + " ".repeat(Math.max(0, inner - visibleWidth(body))) + theme.fg("border", " │"));
		};
		const title = truncateToWidth(` Party ${safeWorkText(this.options.room)} · Chat `, Math.max(1, this.width - 7), "…");
		const top = theme.fg("border", `╭${title}${"─".repeat(Math.max(0, this.width - visibleWidth(title) - 5))} × ╮`);
		const count = this.page.messages.length;
		const status = this.error || `${this.live ? "Live · " : ""}${count} ${count === 1 ? "message" : "messages"} · ${this.top + 1}–${Math.min(this.total, this.top + this.viewport)} of ${this.total} lines${this.newer || this.page.hasNewer ? " · newer messages — End to view" : ""}`;
		const help = inner >= 76 ? "↑↓ / wheel scroll · PgUp/PgDn · ←→ history · Home oldest · End live · Esc close" : "↑↓ scroll · ←→ history · End live · Esc close";
		const content = lines.slice(this.top, this.top + this.viewport);
		while (content.length < this.viewport) content.push("");
		return [fit(top), frame(theme.fg(this.error ? "error" : "muted", status)),
			...content.map(frame), frame(theme.fg("dim", help)),
			frame(theme.fg("muted", this.newer ? "New messages · click here or press End to follow" : this.live ? "Following the conversation" : "Reading history · End returns to live")),
			fit(theme.fg("border", `╰${"─".repeat(Math.max(0, this.width - 2))}╯`)),
		].slice(0, this.height);
	}
}
