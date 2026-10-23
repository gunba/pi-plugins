import type { IncomingMessage, ServerResponse } from "node:http";
import type { HostEvent, HostState } from "../shared/protocol.ts";

interface EventClient { response: ServerResponse; device: string }

/**
 * Host changes as browsers receive them: browsers on this computer over server-sent events, with a short history to
 * replay after a reconnection, and remote browsers through the relay. Host code can also watch every change.
 */
export class HostEvents {
	private clients = new Set<EventClient>();
	private watchers = new Set<(event: HostEvent) => void>();
	/** Remote browsers, through the relay or directly; they receive what local browsers do. */
	private browsers = new Set<(event: HostEvent) => void>();
	/** What browsers last received: each conversation, and the host state apart from its conversations. */
	private sentSessions = new Map<string, string>();
	private sentHost?: string;
	private sequence = 0;
	private history: { id: number; frame: string }[] = [];
	private historyBytes = 0;

	emit(event: HostEvent): void {
		for (const next of this.unsent(event)) this.deliver(next);
		// Internal waits see every event: they check state outside the views, which can change without the views changing.
		for (const handler of this.watchers) handler(event);
	}

	/** Call `handler` with every event until the returned function is called. */
	watch(handler: (event: HostEvent) => void): () => void {
		this.watchers.add(handler);
		return () => this.watchers.delete(handler);
	}

	/** A remote browser: it receives each event delivered to browsers until the returned function is called. */
	addBrowser(handler: (event: HostEvent) => void): () => void {
		this.browsers.add(handler);
		return () => this.browsers.delete(handler);
	}

	/** Serve the event stream to a browser on this computer, replaying what it missed when the history still has it. */
	stream(request: IncomingMessage, response: ServerResponse, device: string, state: () => HostState): void {
		response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
		const client = { response, device };
		this.clients.add(client);
		const last = Number(request.headers["last-event-id"]);
		const first = this.history[0]?.id ?? this.sequence + 1;
		if (Number.isSafeInteger(last) && last >= first - 1 && last <= this.sequence && request.headers["last-event-id"]) {
			for (const item of this.history) if (item.id > last) this.write(response, item.frame);
		} else this.write(response, `id: ${this.sequence}\ndata: ${JSON.stringify({ type: "state", state: state() })}\n\n`);
		request.on("close", () => this.clients.delete(client));
	}

	heartbeat(): void {
		for (const client of this.clients) this.write(client.response, ": heartbeat\n\n");
	}

	/** End the event streams of one paired browser, or of every browser. */
	end(device?: string): void {
		for (const client of this.clients) if (device === undefined || client.device === device) client.response.end();
	}

	private write(response: ServerResponse, frame: string): void {
		if (response.destroyed) return;
		if (response.writableLength > 1024 * 1024) { response.destroy(); return; }
		response.write(frame);
	}

	/**
	 * Every change sends the whole conversation, or for host state every conversation, to every browser: most of the
	 * relay's traffic. An unchanged conversation is not sent again, and host state whose only changes are in
	 * conversations is sent as those conversations.
	 */
	private unsent(event: HostEvent): HostEvent[] {
		if (event.type === "session") {
			const sent = JSON.stringify(event.session);
			if (this.sentSessions.get(event.session.key) === sent) return [];
			this.sentSessions.set(event.session.key, sent);
			return [event];
		}
		if (event.type !== "state") return [event];
		const host = JSON.stringify({ ...event.state, sessions: event.state.sessions.map(session => session.key) });
		if (host === this.sentHost) return event.state.sessions.flatMap(session => this.unsent({ type: "session", session }));
		this.sentHost = host;
		this.sentSessions = new Map(event.state.sessions.map(session => [session.key, JSON.stringify(session)]));
		return [event];
	}

	private deliver(event: HostEvent): void {
		const id = ++this.sequence;
		const frame = `id: ${id}\ndata: ${JSON.stringify(event)}\n\n`;
		this.history.push({ id, frame });
		this.historyBytes += Buffer.byteLength(frame);
		while (this.history.length > 512 || this.historyBytes > 2 * 1024 * 1024) {
			this.historyBytes -= Buffer.byteLength(this.history.shift()!.frame);
		}
		for (const client of this.clients) this.write(client.response, frame);
		for (const handler of this.browsers) handler(event);
	}
}
