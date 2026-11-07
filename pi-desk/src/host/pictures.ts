import { createHash, randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { ModelRuntime, resizeImage } from "@earendil-works/pi-coding-agent";
import { atomicJson } from "../../manage/store.ts";
import { withOpenAIImages } from "../../../pi-openai-images/index.ts";
import { ServiceUsage } from "../../../pi-service-usage/index.ts";
import { trackServiceModels } from "../../../pi-service-usage/models.ts";
import type { SessionPicture } from "../shared/protocol.ts";
import { openingMessage } from "../shared/session-title.ts";
import { isOpenSession } from "../shared/workspace.ts";
import { publishFileSync } from "./file-publication.ts";
import type { HostCore, ManagedSession } from "./host-core.ts";

/** The ChatGPT subscription's image models, the faster first. Desk draws with no other provider, so pictures cost no API credit. */
const PROVIDER = "openai-codex", MODELS = ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"];
const NO_SIGN_IN = "Sign in to ChatGPT on this computer (Settings, Logins) for Desk to draw banners.";
const SCAN_MS = 30_000;
const AT_ONCE = 2;
/** A picture that failed is tried again after this long, doubling with each failure for the same name up to a day. */
const RETRY_MS = 10 * 60_000, LONGEST_RETRY_MS = 24 * 3_600_000;
/** Without a ChatGPT sign-in, Desk rereads the logins after this long. */
const SIGN_IN_RETRY_MS = 5 * 60_000;
/** A picture whose agent hasn't been in the sidebar for this long is deleted. */
const KEPT_MS = 60 * 86_400_000;
/**
 * Deep colours that tell the pictures apart, in order round the colour wheel; a new picture takes the one fewest of
 * this computer's agents have, and of those unused, the one furthest round the wheel from those in use.
 */
const COLOURS = ["crimson red", "rust brown", "burnt orange", "golden ochre", "olive green", "forest green", "teal", "turquoise",
	"slate blue-grey", "royal blue", "indigo", "violet", "plum", "magenta"];
/** Folder names that say nothing about an agent's work. */
const PLAIN_FOLDERS = /^(desktop|documents|downloads|projects|home|src|code)$/i;
const AGENT = /^[a-f0-9-]{36}$/;

/**
 * A picture drawn for an agent: the name it was drawn for, what it shows, its file's version and type, and when the
 * agent was last in the sidebar.
 */
interface Drawn { name: string; subject?: string; version: string; type: string; colour: string; drawn: number; listed: number }
interface Failure { name: string; at: number; attempts: number; error: string }

/**
 * Banner pictures for the conversations on this computer, drawn by an image model from each one's name once it has one,
 * and drawn again when it is renamed. Each conversation's view carries its picture's version (SessionView.picture),
 * and browsers fetch the image by it (host-api.ts).
 */
export class Pictures {
	private readonly core: HostCore;
	private readonly folder: string;
	private readonly index: Record<string, Drawn> = {};
	private runtime?: Promise<ModelRuntime>;
	private usage?: ServiceUsage;
	/** Agents being drawn, with the colour and subject each takes, and those waiting their turn. */
	private readonly drawing = new Map<string, { colour: string; subject?: string }>();
	private queue: string[] = [];
	private readonly failed = new Map<string, Failure>();
	/** Agents to draw again though their picture fits their name. */
	private readonly redraws = new Set<string>();
	/** When Desk last found no ChatGPT sign-in here. */
	private unsigned?: number;
	private timer?: ReturnType<typeof setInterval>;
	private soon?: ReturnType<typeof setTimeout>;
	private readonly abort = new AbortController();
	private closed = false;
	/** The subject being chosen: one at a time, so each choice knows the one before it. */
	private choosing: Promise<void> = Promise.resolve();

	constructor(core: HostCore) {
		this.core = core;
		this.folder = join(core.directory, "pictures");
		mkdirSync(this.folder, { recursive: true, mode: 0o700 });
		try {
			const saved = JSON.parse(readFileSync(join(this.folder, "index.json"), "utf8")) as { version?: number; agents?: Record<string, Drawn> };
			if (saved.version === 1 && saved.agents) for (const [agent, drawn] of Object.entries(saved.agents))
				if (AGENT.test(agent) && typeof drawn?.version === "string" && /^[a-f0-9]{16}$/.test(drawn.version)) this.index[agent] = drawn;
		} catch { /* None drawn yet, or unreadable: they are drawn again. */ }
	}

	/** Publishes the pictures there are, and draws those missing now and every half minute. */
	start(): void {
		this.tidy();
		this.scan();
		this.timer = setInterval(() => this.scan(), SCAN_MS);
		this.timer.unref();
	}

	/** A conversation may have been renamed: looks within a second rather than at the next scan. */
	changed(): void {
		if (this.closed || this.soon) return;
		this.soon = setTimeout(() => { this.soon = undefined; this.scan(); }, 1_000);
		this.soon.unref();
	}

	close(): void {
		this.closed = true;
		clearInterval(this.timer); clearTimeout(this.soon);
		this.abort.abort();
		this.usage?.close();
	}

	/** The conversation's picture as an API asset, or undefined when it has none. */
	read(key: string): { mimeType: string; base64: string } | undefined {
		const agent = agentOf(this.core.sessions.get(key)), drawn = agent ? this.index[agent] : undefined;
		if (!drawn) return undefined;
		try { return { mimeType: drawn.type, base64: readFileSync(this.file(agent!, drawn)).toString("base64") }; }
		catch { return undefined; }
	}

	/** Draws a new picture for the conversation, in a different colour, though the one it has fits its name. */
	redraw(key: string): void {
		const managed = this.core.sessions.get(key), agent = agentOf(managed);
		if (!managed || !agent || !eligible(managed)) throw new Error("This conversation can't have a banner.");
		if (!nameOf(managed)) throw new Error("Name this conversation first: its banner is drawn from its name.");
		this.failed.delete(agent);
		this.unsigned = undefined;
		this.redraws.add(agent);
		this.scan();
	}

	private scan(): void {
		if (this.closed || this.core.closing) return;
		// It runs from timers, where an error would stop the host.
		try { this.look(); }
		catch (error) { console.error("Desk's banners:", error instanceof Error ? error.message : String(error)); }
	}

	private look(): void {
		const now = Date.now();
		let listed = false;
		for (const managed of this.core.sessions.values()) {
			const agent = agentOf(managed);
			if (!agent || !eligible(managed)) continue;
			const name = nameOf(managed), drawn = this.index[agent];
			if (drawn && now - drawn.listed > 86_400_000) { drawn.listed = now; listed = true; }
			if (name && this.wanted(agent, name, now)) this.queue.push(agent);
		}
		if (listed) this.save();
		this.pump();
		this.publishAll();
	}

	private wanted(agent: string, name: string, now: number): boolean {
		if (this.drawing.has(agent) || this.queue.includes(agent)) return false;
		if (this.index[agent]?.name === name && !this.redraws.has(agent)) return false;
		if (this.unsigned && now - this.unsigned < SIGN_IN_RETRY_MS) return false;
		const failure = this.failed.get(agent);
		return !failure || failure.name !== name || now - failure.at >= Math.min(RETRY_MS * 2 ** (failure.attempts - 1), LONGEST_RETRY_MS);
	}

	private pump(): void {
		while (!this.closed && this.drawing.size < AT_ONCE && this.queue.length) {
			const agent = this.queue.shift()!;
			this.drawing.set(agent, { colour: this.colour(agent) });
			void this.draw(agent).finally(() => {
				this.drawing.delete(agent);
				this.scan();
			});
		}
	}

	private async draw(agent: string): Promise<void> {
		const managed = [...this.core.sessions.values()].find(item => agentOf(item) === agent && eligible(item));
		const name = managed && nameOf(managed);
		if (!managed || !name) return;
		const redraw = this.redraws.delete(agent), drawing = this.drawing.get(agent)!, colour = drawing.colour;
		try {
			if (this.unsigned && Date.now() - this.unsigned < SIGN_IN_RETRY_MS) throw new Error(NO_SIGN_IN);
			const runtime = await this.models();
			const available = await runtime.getAvailableOfType("image", PROVIDER);
			const model = MODELS.map(id => available.find(item => item.id === id)).find(item => item) ?? available[0];
			if (!model) {
				// The logins are read again next time.
				this.unsigned = Date.now(); this.runtime = undefined;
				throw new Error(NO_SIGN_IN);
			}
			const view = managed.view, cwd = view.snapshot?.cwd ?? view.cwd, opening = openingRequest(view.snapshot?.file ?? view.file);
			const folder = basename(cwd), about = { name, opening, folder: cwd !== homedir() && folder && !PLAIN_FOLDERS.test(folder) ? folder : undefined };
			// Left to itself, the image model draws the same few things (a lighthouse) for unlike agents.
			const chosen = this.choosing.then(async () => {
				// Asked for a new picture, it shows something new.
				const taken = [...this.subjects(agent), ...redraw && this.index[agent]?.subject ? [this.index[agent].subject] : []];
				drawing.subject = await this.subject(runtime, about, taken).catch(error => {
					if (this.abort.signal.aborted) throw error;
					console.error(`Desk couldn't choose what to draw for ${JSON.stringify(name)}: ${error instanceof Error ? error.message : String(error)}`);
					return undefined;
				});
			});
			this.choosing = chosen.catch(() => {});
			await chosen;
			const result = await runtime.generateImages(model, { input: [{ type: "text", text: prompt(about, drawing.subject, colour) }] },
				{ signal: this.abort.signal });
			const image = result.output.find(block => block.type === "image");
			if (result.stopReason !== "stop" || !image || image.type !== "image") throw new Error(result.errorMessage || "The image model drew nothing.");
			// Rows are about 270 pixels wide and the top bar the width of the window; the picture is cropped to fit both.
			const small = await resizeImage(Buffer.from(image.data, "base64"), image.mimeType, { maxWidth: 1200, maxHeight: 400, jpegQuality: 80 });
			if (!small) throw new Error("Desk couldn't shrink the picture.");
			if (this.closed) return;
			const bytes = Buffer.from(small.data, "base64"), previous = this.index[agent];
			const drawn: Drawn = { name, ...(drawing.subject ? { subject: drawing.subject } : {}), version: createHash("sha256").update(bytes).digest("hex").slice(0, 16),
				type: small.mimeType, colour, drawn: Date.now(), listed: Date.now() };
			const temporary = join(this.folder, `${randomUUID()}.tmp`);
			try { writeFileSync(temporary, bytes, { mode: 0o600 }); publishFileSync(temporary, this.file(agent, drawn)); }
			finally { rmSync(temporary, { force: true }); }
			this.index[agent] = drawn;
			this.save();
			if (previous && this.file(agent, previous) !== this.file(agent, drawn)) rmSync(this.file(agent, previous), { force: true });
			this.failed.delete(agent);
		} catch (error) {
			if (this.closed) return;
			const message = error instanceof Error ? error.message : String(error), failure = this.failed.get(agent);
			// Without a sign-in nothing was tried, so it doesn't count towards the wait.
			this.failed.set(agent, { name, at: Date.now(), error: message,
				attempts: message === NO_SIGN_IN ? 1 : failure?.name === name ? failure.attempts + 1 : 1 });
			if (redraw) this.redraws.add(agent);
			if (message !== NO_SIGN_IN) console.error(`Desk couldn't draw a banner for ${JSON.stringify(name)}: ${message}`);
		}
	}

	private models(): Promise<ModelRuntime> {
		if (!this.runtime) {
			const runtime = this.runtime = ModelRuntime.create({ authPath: join(this.core.options.agentDir, "auth.json"),
				modelsPath: join(this.core.options.agentDir, "models.json") }).then(runtime => {
				// The image models come from a Pi extension, which conversations load and this runtime does not.
				const base = runtime.getProvider(PROVIDER);
				if (base && !base.getAllModels?.().some(model => model.type === "image")) runtime.registerNativeProvider(withOpenAIImages(base));
				this.usage ??= new ServiceUsage(this.core.options.agentDir);
				trackServiceModels(runtime, this.usage, warning => console.error(warning));
				return runtime;
			});
			runtime.catch(() => { if (this.runtime === runtime) this.runtime = undefined; });
		}
		return this.runtime;
	}

	/**
	 * A text model's choice of one thing to draw for the agent, unlike what the others' pictures show; undefined when
	 * there is no ChatGPT chat model here.
	 */
	private async subject(runtime: ModelRuntime, about: About, taken: string[]): Promise<string | undefined> {
		const model = [...await runtime.getAvailableOfType("chat", PROVIDER)].sort((a, b) => a.cost.output - b.cost.output)[0];
		if (!model) return undefined;
		const result = await runtime.completeSimple(model, { systemPrompt: SUBJECT, messages: [{ role: "user", timestamp: Date.now(), content: [
			`Agent: ${about.name}`, about.opening ? `Its first request: ${about.opening}` : "", about.folder ? `Its folder: ${about.folder}` : "",
			taken.length ? `Already used, so not these: ${taken.join("; ")}` : ""].filter(Boolean).join("\n") }] },
			{ signal: this.abort.signal, maxTokens: 2000, reasoning: "low" });
		try { this.usage?.record({ service: model.provider, operation: "picture subject", cost: result.usage.cost.total, estimated: true }); }
		catch { console.error("A banner's subject was chosen, but its cost could not be recorded on this computer."); }
		if (result.stopReason === "error" || result.stopReason === "aborted") throw new Error(result.errorMessage || "The model chose nothing.");
		const text = result.content.flatMap(block => block.type === "text" ? [block.text] : []).join(" ").replace(/\s+/g, " ").trim()
			.replace(/^["'“]+|["'”.]+$/g, "");
		return text && text.length <= 200 ? text : undefined;
	}

	/** What the other listed agents' pictures show. */
	private subjects(agent: string): string[] {
		const listed = new Set([...this.core.sessions.values()].filter(eligible).map(agentOf));
		return [...Object.entries(this.index).filter(([id]) => id !== agent && listed.has(id)).map(([, drawn]) => drawn.subject),
			...[...this.drawing].filter(([id]) => id !== agent).map(([, drawing]) => drawing.subject)].filter((subject): subject is string => !!subject);
	}

	/**
	 * The colour fewest of the listed agents' pictures have, other than the agent's own when it is drawn again; of
	 * those, the one furthest round the wheel from the colours in use.
	 */
	private colour(agent: string): string {
		const own = this.redraws.has(agent) ? this.index[agent]?.colour : undefined;
		if (this.index[agent] && !own) return this.index[agent].colour;
		const listed = new Set([...this.core.sessions.values()].filter(eligible).map(agentOf));
		const counts = new Map(COLOURS.filter(colour => colour !== own).map(colour => [colour, 0]));
		const taken = [...Object.entries(this.index).filter(([id]) => id !== agent && listed.has(id) && !this.drawing.has(id)).map(([, drawn]) => drawn.colour),
			...[...this.drawing.values()].map(drawing => drawing.colour)];
		for (const colour of taken) if (counts.has(colour)) counts.set(colour, counts.get(colour)! + 1);
		const fewest = Math.min(...counts.values()), choices = [...counts].filter(([, count]) => count === fewest).map(([colour]) => colour);
		const used = [...taken, ...own ? [own] : []].map(colour => COLOURS.indexOf(colour)).filter(index => index >= 0);
		const gap = (colour: string) => Math.min(COLOURS.length, ...used.map(index => {
			const apart = Math.abs(COLOURS.indexOf(colour) - index);
			return Math.min(apart, COLOURS.length - apart);
		}));
		const widest = Math.max(...choices.map(gap)), spread = choices.filter(colour => gap(colour) === widest);
		return spread[[...agent].reduce((hash, character) => (hash * 31 + character.charCodeAt(0)) >>> 0, 7) % spread.length]!;
	}

	private publishAll(): void {
		for (const managed of this.core.sessions.values()) {
			const agent = agentOf(managed);
			this.publish(managed, agent && eligible(managed) ? this.status(agent, nameOf(managed)) : undefined);
		}
	}

	private status(agent: string, name: string | undefined): SessionPicture | undefined {
		const drawn = this.index[agent], failure = this.failed.get(agent);
		const picture: SessionPicture = { ...(drawn ? { version: drawn.version } : {}),
			...(this.drawing.has(agent) || this.queue.includes(agent) ? { drawing: true } : {}),
			...(failure && failure.name === name ? { error: failure.error } : {}) };
		return Object.keys(picture).length ? picture : undefined;
	}

	private publish(managed: ManagedSession, picture: SessionPicture | undefined): void {
		if (JSON.stringify(picture) === JSON.stringify(managed.view.picture)) return;
		managed.view = { ...managed.view, picture };
		if (!this.core.closing) this.core.emit({ type: "session", session: managed.view });
	}

	/** Deletes pictures of agents long gone from the sidebar, and files a crash left behind. */
	private tidy(): void {
		const listed = new Set([...this.core.sessions.values()].filter(eligible).map(agentOf)), now = Date.now();
		let changed = false;
		for (const [agent, drawn] of Object.entries(this.index)) if (!listed.has(agent) && now - drawn.listed > KEPT_MS) { delete this.index[agent]; changed = true; }
		if (changed) this.save();
		const kept = new Set(Object.entries(this.index).map(([agent, drawn]) => basename(this.file(agent, drawn))));
		for (const name of readdirSync(this.folder)) if (name !== "index.json" && !kept.has(name)) rmSync(join(this.folder, name), { force: true });
	}

	private file(agent: string, drawn: Drawn): string {
		return join(this.folder, `${agent}.${drawn.version}.${drawn.type === "image/png" ? "png" : "jpg"}`);
	}

	private save(): void {
		atomicJson(join(this.folder, "index.json"), { version: 1, agents: this.index }, { compact: true });
	}
}

function agentOf(managed: ManagedSession | undefined): string | undefined {
	const agent = managed?.view.snapshot?.id ?? managed?.view.agentId;
	return agent && AGENT.test(agent) ? agent : undefined;
}
function nameOf(managed: ManagedSession): string | undefined {
	return (managed.view.snapshot?.name ?? managed.view.name)?.trim() || undefined;
}
/** Conversations in the sidebar have pictures; Home has its own place, and a moved one is drawn where it went. */
function eligible(managed: ManagedSession): boolean {
	return !managed.view.home && !managed.view.moved && isOpenSession(managed.view);
}

/** What a picture is drawn from: the agent's name, the start of its first request, and its folder's name when that says something. */
interface About { name: string; opening?: string; folder?: string }
const SUBJECT = `You choose the picture on an AI agent's banner in an app's sidebar, which helps its user tell the agents apart at a glance.
Reply with only the subject: one concrete physical object, or a small group of objects, that stands for the agent's work and is easy to recognise when small, in under 12 words.
No screens, computers, robots, faces, text, numbers or logos. It must clearly differ from every subject already used.`;

function prompt(about: About, subject: string | undefined, colour: string): string {
	return [`Wide panoramic banner, about three times wider than tall, for an AI agent named ${JSON.stringify(about.name)}.`,
		...subject ? [`A calm scene built around ${subject}, placed in the right third.`] : [
			about.opening ? `Its first request was: ${JSON.stringify(about.opening)}.` : "",
			about.folder ? `It works in a folder named ${JSON.stringify(about.folder)}.` : "",
			"A calm scene built around one simple, recognisable physical object or symbol that stands for this agent's work (not a computer screen), placed in the right third."],
		`The left two thirds are open, quiet background with little detail, in deep shades of ${colour}.`,
		"Mid-century travel-poster screen print: flat shapes, a few inks, slight paper grain.",
		"No text, letters, numbers, logos or brand marks. No border or frame."].filter(Boolean).join(" ");
}

/**
 * The start of the conversation's first message, from the head of its session file. Some files are hundreds of
 * megabytes, so at most the first 8 MiB are read.
 */
function openingRequest(file: string | undefined): string | undefined {
	if (!file) return undefined;
	let descriptor: number;
	try { descriptor = openSync(file, "r"); } catch { return undefined; }
	try {
		const chunk = Buffer.alloc(1 << 20), decoder = new StringDecoder("utf8");
		let position = 0, rest = "";
		while (position < 8 << 20) {
			const count = readSync(descriptor, chunk, 0, chunk.length, position);
			if (!count) break;
			position += count;
			const lines = (rest + decoder.write(chunk.subarray(0, count))).split("\n");
			rest = lines.pop()!;
			for (const line of lines) {
				let entry: unknown;
				try { entry = JSON.parse(line); } catch { continue; }
				const opening = openingMessage([entry], undefined, 400);
				if (opening) return opening;
			}
		}
	} finally { closeSync(descriptor); }
	return undefined;
}
