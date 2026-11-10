import { open } from "node:fs/promises";
import { basename } from "node:path";
import type { PushNotice } from "../account/push.ts";
import type { HostEvent, SessionView } from "../shared/protocol.ts";
import type { UiAnswer } from "../../../pi-ui/index.ts";
import { openQuestions, questionKey } from "../shared/attention.ts";

interface NoticeHost {
	/** The user has used Desk recently (presence.ts). */
	present(): boolean;
	/** This computer's id in the account workspace, which the app prefixes to its conversation keys. */
	computer(): string | undefined;
	send(notice: PushNotice): Promise<unknown>;
}

const TAIL = 256 * 1024;
/** Jordan's working hours: weekdays 9:00 to 17:00, Perth time, the same zone as Home's schedules (home-jobs.ts). */
function onDuty(at = Date.now()): boolean {
	const parts = Object.fromEntries(new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Perth", hour: "2-digit", hourCycle: "h23", weekday: "short" })
		.formatToParts(at).map(part => [part.type, part.value]));
	const hour = Number(parts.hour) % 24;
	return !["Sat", "Sun"].includes(parts.weekday!) && hour >= 9 && hour < 17;
}
type Form = NonNullable<SessionView["ui"]>["interactions"][number]["form"];
const name = (view: SessionView) => view.name || view.title || view.snapshot?.name || view.snapshot?.title || basename(view.cwd) || "A conversation";
const excerpt = (text: string, max = 300) => { const flat = text.replace(/\s+/g, " ").trim(); return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat; };

/** The text of the last assistant message in a native history file, read from its end. */
async function lastReply(file: string | undefined): Promise<{ text?: string; error?: string } | undefined> {
	if (!file) return;
	const handle = await open(file, "r").catch(() => undefined);
	if (!handle) return;
	try {
		const { size } = await handle.stat(), length = Math.min(size, TAIL), buffer = Buffer.alloc(length);
		await handle.read(buffer, 0, length, size - length);
		const lines = buffer.toString("utf8").split("\n");
		for (let index = lines.length - 1; index > 0; index--) {
			let entry: { type?: string; message?: { role?: string; content?: unknown; stopReason?: string; errorMessage?: string } };
			try { entry = JSON.parse(lines[index]!); } catch { continue; }
			const message = entry.type === "message" ? entry.message : undefined;
			if (message?.role !== "assistant") continue;
			const text = Array.isArray(message.content) ? message.content.filter((part: { type?: string }) => part?.type === "text").map((part: { text?: string }) => part.text ?? "").join("\n") : "";
			return message.stopReason === "error" ? { error: message.errorMessage ?? "The model request failed." } : { text };
		}
	} finally { await handle.close(); }
}

/**
 * Notices to the user's phone while they are away, during their working hours: a conversation's question, its
 * finishing or stopping on an error with nothing left to wake it (shared/attention.ts). Questions wait for an answer either way; on Android a
 * yes/no or two-choice question can be answered from the notification.
 */
export class AwayNotices {
	private host: NoticeHost;
	/** Questions waiting for an answer, by conversation and question (questionKey: one asked again when its conversation
	 * restarts is the same question), and those sent. One still waiting when the user leaves is sent then. */
	private questions = new Map<string, { view: SessionView; interaction: string; form: Form }>();
	private sent = new Set<string>();
	/** Each conversation's finished mark already considered, by key; marks from before this host started are not news. */
	private finished = new Map<string, number>();
	private readonly started = Date.now();
	private timer: ReturnType<typeof setInterval>;

	constructor(host: NoticeHost) {
		this.host = host;
		// A question asked out of hours goes to the phone once working hours begin.
		this.timer = setInterval(() => this.flush(), 5 * 60_000); this.timer.unref();
	}
	close(): void { clearInterval(this.timer); }

	/** Every host event: conversations' changes, and host state, which also changes when the user arrives or leaves. */
	observe(event: HostEvent): void {
		if (event.type === "session") this.session(event.session);
		else if (event.type === "state") for (const view of event.state.sessions) this.session(view);
		this.flush();
	}
	private get sending(): boolean {
		return !this.host.present() && onDuty();
	}
	private key(view: SessionView): string { const computer = this.host.computer(); return computer ? `${computer}:${view.key}` : view.key; }
	private send(notice: PushNotice): void { void this.host.send(notice).catch(error => console.error(`A notice could not be sent: ${error instanceof Error ? error.message : String(error)}`)); }

	private session(view: SessionView): void {
		const prefix = `${view.key}/`, live = new Set<string>();
		// Those Desk keeps while the conversation sleeps included.
		for (const item of openQuestions(view)) {
			const id = prefix + questionKey(item); live.add(id);
			this.questions.set(id, { view, interaction: item.id, form: item.form });
		}
		for (const id of this.questions.keys()) if (id.startsWith(prefix) && !live.has(id)) { this.questions.delete(id); this.sent.delete(id); }
		// A turn that ends with a watch, a wake or agents still working is not finished: the conversation goes on by itself.
		// Home sends its own updates to the phone (home_notify), so its mark sends nothing more.
		if (view.home || !view.finished || view.finished < this.started || this.finished.get(view.key) === view.finished) return;
		this.finished.set(view.key, view.finished);
		if (!this.sending) return;
		const activity = view.snapshot?.activity;
		void lastReply(view.file ?? view.snapshot?.file).then(reply => {
			const failed = activity === "error" || !!reply?.error;
			this.send({ title: `${name(view)} ${failed ? "stopped" : "finished"}`, body: excerpt(reply?.error ?? reply?.text ?? view.error ?? ""),
				tag: `turn:${this.key(view)}`, session: this.key(view) });
		});
	}
	private flush(): void {
		if (!this.sending) return;
		for (const [id, { view, interaction, form }] of this.questions) if (!this.sent.has(id)) { this.sent.add(id); this.question(view, interaction, form); }
	}
	private question(view: SessionView, interaction: string, form: Form): void {
		const choices: [string, UiAnswer][] = form.kind === "confirm" ? [["Yes", { kind: "confirm", confirmed: true }], ["No", { kind: "confirm", confirmed: false }]]
			: form.kind === "question" && !form.allowMultiple && form.options.length === 2
				? form.options.map(option => [option.title, { kind: "selection", selections: [option.title] }] as [string, UiAnswer]) : [];
		const detail = form.kind === "confirm" ? form.message : form.context ?? "";
		this.send({ title: `${name(view)} asks`, body: excerpt([form.title, detail].filter(Boolean).join("\n"), 500), tag: `question:${this.key(view)}/${interaction}`,
			session: this.key(view), urgency: "high",
			...(choices.length ? { actions: choices.map(([title], index) => ({ action: String(index), title: excerpt(title, 40) })),
				answers: Object.fromEntries(choices.map(([, answer], index) => [String(index),
					{ interaction, ...(form.kind === "question" && form.key ? { key: form.key } : {}), answer }])) } : {}) });
	}
}
