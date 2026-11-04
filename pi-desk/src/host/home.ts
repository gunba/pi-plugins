import type { UiConversation } from "../../../pi-ui/index.ts";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { InputSubmission } from "../shared/inputs.ts";
import type { SessionView } from "../shared/protocol.ts";
import { HOME_MODEL, type HomeSnapshot, type HomeWatch, type HomeWork, type HomeRun } from "../shared/home.ts";
import type { HostCore, ManagedSession } from "./host-core.ts";
import { HomeStore } from "./home-store.ts";

/**
 * The conversations Home lists: every open one, and closed ones a watch will reopen (status Closed, shown only on the
 * timeline of wakes), each with what it is doing and when a watch next wakes it; secondary agents that are working are listed too. Token and usage changes don't change it.
 */
/** The longest tasks file the page shows and lets Jordan change. */
const PAGE_LIMIT = 200_000;
const pageVersion = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

export function homeWork(sessions: SessionView[]): HomeWork[] {
	return sessions.filter(session => !session.home && (session.state !== "closed" || !!session.wakes)).flatMap(session => {
		const questions = session.ui?.interactions?.filter(item => !item.settings) ?? [];
		const plans = (session.ui?.views ?? []).filter(view => view.kind === "details" && (view.id === "plan" || view.id.endsWith("/plan")));
		const blocked = plans.find(view => (view.data as { fields?: { label: string; value: string }[] }).fields?.some(field => field.label === "State" && field.value === "blocked"));
		const status = questions.length ? "Waiting on you" : blocked ? "Blocked" : session.snapshot?.activity === "running" ? "Working"
			: session.state === "failed" ? "Failed" : session.watching ? "Watching" : session.state === "closed" ? "Closed" : "Idle";
		const title = session.name ?? session.title ?? "Conversation";
		const children = (session.ui?.views ?? []).filter(view => view.kind === "conversation").flatMap(view => {
			const data = view.data as UiConversation;
			return data.active || ["running", "working", "waiting", "blocked"].includes(data.status) ? [{
				id: session.key, title: view.title, status: data.status.replace(/^./, letter => letter.toUpperCase()),
				detail: (data.activity ?? data.subtitle ?? "").slice(0, 1000), view: view.id, parent: title,
			}] : [];
		});
		return [{ id: session.key, title, status,
			detail: questions.map(item => item.form.title).join(" · ").slice(0, 1000) || (blocked ? JSON.stringify(blocked.data).slice(0, 1500) : ""),
			...(blocked ? { view: blocked.id } : {}), ...(session.wakes ? { wakes: session.wakes } : {}) }, ...children];
	}).slice(0, 200);
}

/** The watches Home's conversation has set, from the list pi-watch shows in it. */
export function homeWatches(view: SessionView | undefined): HomeWatch[] {
	const watches = view?.ui?.views?.find(item => item.id === "pi-watch")?.data as { items?: { id: string; title: string; at?: number }[] } | undefined;
	return (watches?.items ?? []).map(item => ({ id: item.id, title: item.title, ...(typeof item.at === "number" ? { at: item.at } : {}) }));
}

/** Owns one normal Desk conversation; all browsers address the same workspace-server instance. */
export class Home {
	readonly store: HomeStore;
	readonly directory: string;
	private timer: ReturnType<typeof setInterval>;
	private starting?: Promise<ManagedSession>;
	private ticking = false;
	private closed = false;
	private closeWhenIdle = false;
	private error?: string;
	private core: HostCore;
	private enabled: () => boolean;
	private remote: () => HomeWork[];
	private notify?: (notice: { title: string; body: string; tag: string; session: string }) => Promise<unknown>;
	/** Whether Home may start its conversation unasked: on the workspace server. Elsewhere opening Home starts it. */
	startsAlone: () => boolean = () => false;
	constructor(core: HostCore, enabled: () => boolean, remote: () => HomeWork[], notify?: Home["notify"]) {
		this.notify = notify;
		this.core = core; this.enabled = enabled; this.remote = remote;
		this.directory = join(core.directory, "home"); this.store = new HomeStore(this.directory); this.store.recover();
		this.timer = setInterval(() => void this.tick(), 1000); this.timer.unref();
	}
	private current(): ManagedSession | undefined { const key = this.store.get<string>("session"); return key ? this.core.sessions.get(key) : undefined; }
	private assertEnabled(): void { if (!this.enabled() || this.closed) throw Error("Home runs on the workspace server, the computer that keeps conversation copies."); }
	private ensure(): Promise<ManagedSession> {
		this.assertEnabled();
		if (this.starting) return this.starting;
		this.starting = (async () => {
			let managed = this.current();
			if (!managed) {
				const key = randomUUID();
				managed = { view: { key, cwd: this.directory, created: Date.now(), state: "closed", name: "Home", home: true } };
				this.store.set("session", key);
				this.core.createSession(this.directory, undefined, managed);
			} else if (!managed.worker) this.core.createSession(managed.view.cwd, managed.view.file, managed);
			managed = await this.core.waitForSession(this.store.get<string>("session")!);
			const snapshot = managed.view.snapshot;
			if (snapshot?.model?.id !== HOME_MODEL.id || snapshot?.model?.provider !== HOME_MODEL.provider) {

				await managed.worker!.command({ kind: "model", ...HOME_MODEL });
			}
			// Drawing well takes thought; Terra is cheap enough to think hard every turn.
			if (snapshot?.thinking !== "xhigh") await managed.worker!.command({ kind: "thinking", level: "xhigh" });
			if (managed.view.name !== "Home") await managed.worker!.command({ kind: "name", name: "Home" });
			return managed;
		})().finally(() => { this.starting = undefined; });
		return this.starting;
	}
	async open(): Promise<HomeSnapshot> { this.assertEnabled(); await this.ensure(); this.error = undefined; return this.snapshot(); }
	snapshot(): HomeSnapshot {
		this.assertEnabled();
		const managed = this.current();
		return { messages: this.store.messages(), busy: !!this.starting || managed?.view.snapshot?.activity === "running",
			error: this.error || managed?.view.error || (managed?.view.snapshot?.activity === "error" ? "Home’s last turn failed. Open History to see the error and continue." : undefined),
			run: this.store.get<HomeRun>("run"), session: managed?.view.key, activation: managed?.view.activation,
			work: [...homeWork([...this.core.sessions.values()].map(item => item.view)), ...this.remote()], watches: homeWatches(managed?.view), ...this.page() };
	}
	private get pageFile(): string { return join(this.core.options.agentDir, "home", "tasks.md"); }
	/**
	 * Jordan's tasks file, which the Home conversation keeps and Home shows as his page. Its version lets him change it
	 * from the page; a file too long to show whole has none, so a change can't drop its end.
	 */
	private page(): Pick<HomeSnapshot, "page" | "pageVersion"> {
		let text = "";
		try { text = readFileSync(this.pageFile, "utf8"); } catch { /* No tasks yet. */ }
		return text.length > PAGE_LIMIT ? { page: text.slice(0, PAGE_LIMIT) } : { page: text, pageVersion: pageVersion(text) };
	}
	/** Jordan's own change to his page, saved only over the version he changed; otherwise undefined, and nothing is written. */
	savePage(version: string, text: string): HomeSnapshot | undefined {
		this.assertEnabled();
		if (this.page().pageVersion !== version) return undefined;
		const file = this.pageFile, temp = `${file}.${randomUUID()}.tmp`;
		mkdirSync(dirname(file), { recursive: true });
		try { writeFileSync(temp, text); renameSync(temp, file); }
		finally { rmSync(temp, { force: true }); }
		return this.snapshot();
	}
	async message(id: string, text: string, attachments?: string[]): Promise<HomeSnapshot> {
		this.assertEnabled();
		if (!/^[a-f0-9-]{36}$/.test(id) || typeof text !== "string" || text.length > 32_000 || (!text.trim() && !attachments?.length)) throw Error("Enter a message or attach a file.");
		const command = { kind: "prompt" as const, text, ...(attachments?.length ? { attachments } : {}), behavior: "followUp" as const };
		let saved = this.store.get<{ session: string; input: InputSubmission }>(`input:${id}`);
		if (saved) {
			if (JSON.stringify(saved.input.command) !== JSON.stringify(command)) throw Error("This message receipt belongs to different contents.");
			if (this.core.inputs.existing(saved.session, saved.input)) return this.snapshot();
		}
		const managed = await this.ensure();
		if (saved && (saved.session !== managed.view.key || saved.input.activation !== managed.view.activation || saved.input.generation !== managed.worker!.generation))
			throw Error("Home restarted before accepting this message. Check History before sending it again.");
		const files = this.core.attachments(managed.view.key).check(attachments ?? []);
		saved ??= { session: managed.view.key, input: { id, activation: managed.view.activation!, generation: managed.worker!.generation, command } };
		this.store.set(`input:${id}`, saved);
		this.core.inputs.admit(saved.session, saved.input);
		this.core.inputEvent(managed); this.core.drainInputs(managed);
		this.store.message({ id, role: "user", text, at: Date.now(), ...(files.length ? { files } : {}) }); this.error = undefined;
		return this.snapshot();
	}
	async tick(): Promise<void> {
		if (this.ticking || this.closed || !this.enabled() || this.core.closing || this.core.held || this.core.restoringUpdate) return;
		this.ticking = true;
		try {
			for (const request of this.store.pending()) {
				if (!this.store.claim(request.id)) continue;
				try {
					if (request.command.action === "notify") {
						const { title, text } = request.command;
						this.store.message({ id: request.id, role: "assistant", text, at: Date.now() });
						if (!this.notify) throw Error("Home saved the update, but phone delivery is not configured.");
						await this.notify({ title,
							body: text.replace(/\s+/g, " ").slice(0, 500), tag: `home:${request.id}`, session: "home" });
						this.store.settle(request.id, { value: { delivered: true, message: request.id } });
					}
				}
				catch (error) { this.store.settle(request.id, { error: error instanceof Error ? error.message : String(error) }); }
			}
			// On the workspace server Home starts by itself, so its scheduled jobs run without anyone opening it.
			if (!this.store.get("session") && this.startsAlone()) await this.ensure();
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
		} finally { this.ticking = false; if (this.closeWhenIdle) this.store.close(); }
	}
	close(): void { this.closed = true; clearInterval(this.timer); if (this.ticking) this.closeWhenIdle = true; else this.store.close(); }
}
