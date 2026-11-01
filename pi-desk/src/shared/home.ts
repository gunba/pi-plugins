import { Type, type Static, type TLiteral } from "typebox";
import { Value } from "typebox/value";
import { catalogValidator, type CatalogDefinition } from "../../../pi-ui/agent-catalog.ts";
import { applySpecPatch, validateSpec, type AgentElement, type AgentPatch, type AgentSpec } from "../../../pi-ui/agent-ui.ts";

export const HOME_MODEL = { provider: "openai-codex", id: "gpt-6.1-terra" } as const;
export const HOME_WORK = "home-work-v1";
const text = (maxLength: number) => Type.String({ maxLength });
const id = Type.String({ minLength: 1, maxLength: 200 });
const choice = <T extends string>(values: T[]) => Type.Union(values.map(value => Type.Literal(value)) as [TLiteral<T>, ...TLiteral<T>[]]);
const liveText = (max: number) => Type.Union([text(max), Type.Object({ $state: Type.String({ pattern: "^/", maxLength: 300 }) }, { additionalProperties: false })]);
export const homeIcons = ["chat", "folder", "preview", "computer", "tools", "clock", "thinking", "party", "code", "globe", "account", "star", "check", "warning", "plan", "layers", "activity"] as const;
/** Theme-aware colours: Desk's own tokens and a few hues Home adds for both themes. */
export const HOME_COLORS = ["accent", "input-needed", "muted", "danger", "text", "sage", "amber", "rose", "teal", "sand", "lilac"] as const;
export const HomeReferenceSchema = Type.Union([
	Type.Object({ kind: Type.Literal("quest"), id }),
	Type.Object({ kind: Type.Literal("conversation"), id, computer: Type.Optional(id), view: Type.Optional(id) }),
	Type.Object({ kind: Type.Literal("file"), session: id, computer: Type.Optional(id), id, name: text(300) }),
	Type.Object({ kind: Type.Literal("url"), url: Type.String({ minLength: 1, maxLength: 4096 }) }),
]);
/** Canvas components extend the shared json-render catalog; bindings are restricted to display text. */
export const HomeItemPropsSchema = Type.Object({
	ref: HomeReferenceSchema, title: liveText(100), subtitle: liveText(180), status: liveText(120),
	icon: choice([...homeIcons]), x: Type.Number({ minimum: -4000, maximum: 4000 }), y: Type.Number({ minimum: -4000, maximum: 4000 }),
	width: Type.Number({ minimum: 160, maximum: 700 }), height: Type.Number({ minimum: 64, maximum: 400 }),
	seed: Type.Integer({ minimum: 0, maximum: 65535 }), wobble: Type.Number({ minimum: 0, maximum: 0.22 }),
	color: choice([...HOME_COLORS]), outline: choice(["solid", "dashed"]),
}, { additionalProperties: false });
const position = { x: Type.Number({ minimum: -4000, maximum: 4000 }), y: Type.Number({ minimum: -4000, maximum: 4000 }) };
const paint = {
	color: choice([...HOME_COLORS]), opacity: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
	rotate: Type.Optional(Type.Number({ minimum: -180, maximum: 180 })), ref: Type.Optional(HomeReferenceSchema),
};
const stroke = {
	fill: Type.Optional(choice([...HOME_COLORS, "none"])), tint: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
	strokeWidth: Type.Optional(Type.Number({ minimum: 0, maximum: 12 })), dashed: Type.Optional(Type.Boolean()),
};
/** Free drawing: text, shapes, paths and icons placed anywhere. One with a ref is a clickable, draggable item. */
export const HomeTextPropsSchema = Type.Object({ ...position, ...paint, text: liveText(400), size: Type.Number({ minimum: 9, maximum: 96 }),
	weight: Type.Optional(Type.Integer({ minimum: 300, maximum: 800 })), width: Type.Optional(Type.Number({ minimum: 20, maximum: 1200 })),
	align: Type.Optional(choice(["start", "middle", "end"])), italic: Type.Optional(Type.Boolean()) }, { additionalProperties: false });
export const HomeShapePropsSchema = Type.Object({ ...position, ...paint, ...stroke, kind: choice(["rect", "ellipse"]),
	width: Type.Number({ minimum: 1, maximum: 4000 }), height: Type.Number({ minimum: 1, maximum: 4000 }),
	radius: Type.Optional(Type.Number({ minimum: 0, maximum: 2000 })) }, { additionalProperties: false });
/** SVG path data only: move, line, curve, arc and close commands with numbers. */
export const HOME_PATH = /^[MmLlHhVvCcSsQqTtAaZz0-9eE.,+\-\s]{1,6000}$/;
export const HomePathPropsSchema = Type.Object({ ...position, ...paint, ...stroke, d: Type.String({ minLength: 1, maxLength: 6000 }) }, { additionalProperties: false });
export const HomeIconPropsSchema = Type.Object({ ...position, ...paint, name: choice([...homeIcons]), size: Type.Number({ minimum: 10, maximum: 160 }) }, { additionalProperties: false });
const FREE_SCHEMAS = { Text: HomeTextPropsSchema, Shape: HomeShapePropsSchema, Path: HomePathPropsSchema, Icon: HomeIconPropsSchema } as const;
export const homeFreeType = (type: string): type is keyof typeof FREE_SCHEMAS => type in FREE_SCHEMAS;
export const HomeConnectorPropsSchema = Type.Object({ from: id, to: id, bend: Type.Number({ minimum: -300, maximum: 300 }) }, { additionalProperties: false });
export const HomePatchSchema = Type.Object({ revision: Type.Integer({ minimum: 0 }), operations: Type.Array(Type.Object({
	op: choice(["add", "remove", "replace", "move", "copy", "test"]), path: Type.String({ maxLength: 1000 }), from: Type.Optional(Type.String({ maxLength: 1000 })), value: Type.Optional(Type.Unknown()),
}, { additionalProperties: false }), { maxItems: 128 }) }, { additionalProperties: false });
export const homeCatalog: Record<string, CatalogDefinition> = {
	Canvas: { props: [], children: true },
	...Object.fromEntries(["Blob", "Pill", "Label"].map(type => [type, { props: Object.keys(HomeItemPropsSchema.properties), required: Object.keys(HomeItemPropsSchema.properties), structured: ["ref"] }])),
	Connector: { props: ["from", "to", "bend"], required: ["from", "to", "bend"] },
	...Object.fromEntries(Object.entries(FREE_SCHEMAS).map(([type, schema]) => [type, { props: Object.keys(schema.properties), required: schema.required ?? [], structured: ["ref"] }])),
};
const validateHomeCatalog = catalogValidator(homeCatalog);
export type HomeReference = Static<typeof HomeReferenceSchema>;
type ItemProps = Static<typeof HomeItemPropsSchema>;
export type HomeItem = Omit<ItemProps, "title" | "subtitle" | "status"> & { id: string; shape: "blob" | "pill" | "label" | "free"; title: string; subtitle: string; status: string };
export type HomePatch = { revision: number; operations: AgentPatch[] };
export interface HomeScene { version: 1; revision: number; spec: AgentSpec; preferences: Record<string, { x: number; y: number }> }
export interface HomeMessage { id: string; role: "user" | "assistant"; text: string; at: number; state?: "queued" | "running" | "done" | "interrupted" }
export interface HomeRun { at: number; cost: number; input: number; output: number; cacheRead: number }
export interface HomeSnapshot { scene: HomeScene; messages: HomeMessage[]; busy: boolean; error?: string; run?: HomeRun; session?: string; state?: Record<string, unknown>; overlap?: boolean }
export interface HomeWork { id: string; computer?: string; title: string; status: string; detail: string; view?: string }
export const emptyHomeScene = (): HomeScene => ({ version: 1, revision: 0, spec: { root: "canvas", elements: { canvas: { type: "Canvas", props: {}, children: [] } } }, preferences: {} });

/** HTTP(S) only; scene references never execute code or navigate Desk to a local-file URL. */
export function homeUrl(value: string): boolean {
	try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
}
/** The smallest box a ready-made item's icon, title, subtitle and status fit in. */
export const HOME_MIN_SIZE: Record<string, [number, number]> = { blob: [300, 170], pill: [220, 84], label: [180, 48] };
export const homeItemType = (type: string): boolean => ["Blob", "Pill", "Label"].includes(type);
/** Elements Jordan can open and drag: the ready-made items, and free drawing that refers to something. */
export const homeMovable = (element: AgentElement | undefined): boolean =>
	!!element && (homeItemType(element.type) || homeFreeType(element.type) && !!element.props.ref);
/** Geometry and references for interaction; the shared renderer resolves display-text bindings. */
export function homeItems(scene: HomeScene): HomeItem[] {
	return Object.entries(scene.spec.elements).filter(([, element]) => homeMovable(element))
		.map(([id, element]) => {
			const item = { width: 0, height: 0, ...element.props, id, shape: homeItemType(element.type) ? element.type.toLowerCase() : "free" } as HomeItem;
			// Drawn no smaller than its words need, whatever size the agent gave it.
			const [width, height] = HOME_MIN_SIZE[item.shape] ?? [0, 0];
			return { ...item, width: Math.max(item.width, width), height: Math.max(item.height, height) };
		});
}
export function validateHomeElement(element: AgentElement, id: string, spec: AgentSpec): void {
	validateHomeCatalog(element, id, spec);
	if (element.type === "Canvas") {
		if (id !== spec.root || Object.keys(element.props).length) throw Error("Home has one Canvas root with empty props.");
		return;
	}
	if (spec.elements[spec.root]?.type !== "Canvas" || !spec.elements[spec.root]?.children?.includes(id) || element.children?.length)
		throw Error("Home elements must be direct children of Canvas.");
	if (element.type === "Connector") {
		if (!Value.Check(HomeConnectorPropsSchema, element.props)) throw Error("Invalid Home connector props.");
		const { from, to } = element.props;
		if (from === to || !homeItemType(spec.elements[from]?.type ?? "") || !homeItemType(spec.elements[to]?.type ?? "")) throw Error("A connector must join two existing, different items.");
	} else if (homeFreeType(element.type)) {
		if (!Value.Check(FREE_SCHEMAS[element.type], element.props)) throw Error(`Invalid Home ${element.type} props: ${id}`);
		if (element.type === "Path" && !HOME_PATH.test((element.props as { d: string }).d)) throw Error("A Path's d holds SVG path commands and numbers only.");
		const ref = element.props.ref as HomeReference | undefined;
		if (ref?.kind === "url" && !homeUrl(ref.url)) throw Error("Home links must be HTTP or HTTPS URLs without credentials.");
	} else {
		if (!homeItemType(element.type) || !Value.Check(HomeItemPropsSchema, element.props)) throw Error(`Invalid Home component props: ${id}`);
		if (element.props.ref.kind === "url" && !homeUrl(element.props.ref.url)) throw Error("Home links must be HTTP or HTTPS URLs without credentials.");
	}
}
/** Shared RFC 6902 transaction, fenced by scene revision. A stale run cannot overwrite a drag. */
export function patchHome(scene: HomeScene, patch: HomePatch): HomeScene {
	if (patch.revision !== scene.revision) throw Error("Home changed. Read the current scene and retry the patch.");
	const spec = applySpecPatch(scene.spec, patch.operations, validateHomeElement);
	for (const [id, position] of Object.entries(scene.preferences)) if (homeMovable(spec.elements[id])) Object.assign(spec.elements[id]!.props, position);
	validateSpec(spec, validateHomeElement);
	return { ...scene, spec, preferences: structuredClone(scene.preferences), revision: scene.revision + 1 };
}

/** Deterministic, bounded closed curve. The agent supplies parameters, never executable SVG. */
/** A small deterministic generator, so an item's seed always gives it the same outline. */
function seeded(seed: number): () => number {
	let state = (seed * 2654435761) >>> 0 || 1;
	return () => { state ^= state << 13; state >>>= 0; state ^= state >>> 17; state ^= state << 5; state >>>= 0; return state / 4294967296; };
}
/**
 * A pebble: a smooth closed curve through a few points around the item's box, each pulled inward by a seeded amount
 * of up to `wobble` and nudged along the outline, so no two items share a shape. It never leaves its box.
 */
export function homeBlob(item: Pick<HomeItem, "width" | "height" | "seed" | "wobble">): string {
	const { width: w, height: h, seed, wobble } = item;
	const random = seeded(seed), count = 8 + seed % 2, turn = random() * Math.PI * 2;
	// Catmull-Rom curves bulge past their points, so the points sit a little inside the box.
	const points = Array.from({ length: count }, (_, i) => {
		const angle = turn + (i + (random() - 0.5) * 0.35) / count * Math.PI * 2, radius = 0.95 - wobble * random();
		return [w / 2 + Math.cos(angle) * w / 2 * radius, h / 2 + Math.sin(angle) * h / 2 * radius];
	});
	const at = (i: number) => points[(i + count) % count]!, f = (n: number) => Math.max(0, n).toFixed(1);
	let path = `M ${f(at(0)[0]!)} ${f(at(0)[1]!)}`;
	for (let i = 0; i < count; i++) {
		const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
		path += ` C ${f(p1[0]! + (p2[0]! - p0[0]!) / 6)} ${f(p1[1]! + (p2[1]! - p0[1]!) / 6)}, ${f(p2[0]! - (p3[0]! - p1[0]!) / 6)} ${f(p2[1]! - (p3[1]! - p1[1]!) / 6)}, ${f(p2[0]!)} ${f(p2[1]!)}`;
	}
	return path + " Z";
}

type Box = { id: string; x: number; y: number; width: number; height: number };
const PATH_ARGS: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
/** The box around a path's points, control points included, so it may be a little larger than the curve. */
function pathBox(d: string): [number, number, number, number] | undefined {
	const tokens = d.match(/[A-Za-z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) ?? [];
	let x = 0, y = 0, startX = 0, startY = 0, command = "", i = 0;
	const xs: number[] = [], ys: number[] = [];
	while (i < tokens.length) {
		if (/[A-Za-z]/.test(tokens[i]!)) command = tokens[i++]!;
		const upper = command.toUpperCase(), relative = command !== upper, count = PATH_ARGS[upper];
		if (count === undefined) return undefined;
		if (upper === "Z") { x = startX; y = startY; command = ""; continue; }
		const args = tokens.slice(i, i + count).map(Number);
		if (args.length < count || args.some(Number.isNaN)) break;
		i += count;
		const point = (px: number, py: number) => { xs.push(relative ? x + px : px); ys.push(relative ? y + py : py); };
		if (upper === "H") { x = relative ? x + args[0]! : args[0]!; xs.push(x); ys.push(y); continue; }
		if (upper === "V") { y = relative ? y + args[0]! : args[0]!; xs.push(x); ys.push(y); continue; }
		if (upper === "A") point(args[5]!, args[6]!);
		else for (let k = 0; k < count; k += 2) point(args[k]!, args[k + 1]!);
		x = xs.at(-1)!; y = ys.at(-1)!;
		if (upper === "M") { startX = x; startY = y; command = relative ? "l" : "L"; }
	}
	return xs.length ? [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] : undefined;
}
/** Where a free element or item is drawn; text is measured at about 0.55 em a character, as the theme's sans-serif averages. */
function homeBox(id: string, element: AgentElement): Box | undefined {
	const props = element.props as Record<string, unknown>, x = Number(props.x ?? 0), y = Number(props.y ?? 0);
	if (homeItemType(element.type)) {
		const [width, height] = HOME_MIN_SIZE[element.type.toLowerCase()] ?? [0, 0];
		return { id, x, y, width: Math.max(Number(props.width), width), height: Math.max(Number(props.height), height) };
	}
	if (element.type === "Icon") return { id, x, y, width: Number(props.size), height: Number(props.size) };
	if (element.type === "Shape") return { id, x, y, width: Number(props.width), height: Number(props.height) };
	if (element.type === "Path") {
		const box = pathBox(String(props.d));
		return box && { id, x: x + box[0], y: y + box[1], width: box[2] - box[0], height: box[3] - box[1] };
	}
	if (element.type !== "Text") return undefined;
	const size = Number(props.size), length = typeof props.text === "string" ? props.text.length : 20;
	const natural = length * size * (Number(props.weight ?? 400) >= 600 ? 0.58 : 0.55), wrap = Number(props.width ?? 0);
	const width = wrap || natural, height = size * 1.3 * (wrap ? Math.max(1, Math.ceil(natural / wrap)) : 1);
	const left = props.align === "middle" ? x - width / 2 : props.align === "end" ? x - width : x;
	return { id, x: left, y, width, height };
}
const overlap = (a: Box, b: Box) => Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 2 && Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 2;
/** Layout faults the agent should fix before it finishes: words on top of other words or items, areas running into each other, and a drawing too big for the screen. */
export function homeLayoutProblems(scene: HomeScene): string[] {
	const elements = Object.entries(scene.spec.elements).filter(([id]) => id !== scene.spec.root);
	const boxes = elements.map(([id, element]) => ({ element, box: homeBox(id, element) })).filter(entry => entry.box) as { element: AgentElement; box: Box }[];
	// Shapes and paths at least this big in both directions are areas; smaller ones are marks such as dots and ticks.
	const area = (entry: { element: AgentElement; box: Box }) => ["Shape", "Path"].includes(entry.element.type) && entry.box.width >= 120 && entry.box.height >= 80;
	const words = boxes.filter(entry => !["Shape", "Path"].includes(entry.element.type)), areas = boxes.filter(area);
	const problems: string[] = [];
	for (let i = 0; i < words.length; i++) for (let j = i + 1; j < words.length; j++)
		if (overlap(words[i]!.box, words[j]!.box)) problems.push(`${words[i]!.box.id} overlaps ${words[j]!.box.id}`);
	for (let i = 0; i < areas.length; i++) for (let j = i + 1; j < areas.length; j++) {
		const a = areas[i]!.box, b = areas[j]!.box, inside = (o: Box, c: Box) => o.x <= c.x && o.y <= c.y && o.x + o.width >= c.x + c.width && o.y + o.height >= c.y + c.height;
		if (overlap(a, b) && !inside(a, b) && !inside(b, a)) problems.push(`areas ${a.id} and ${b.id} run into each other`);
	}
	if (boxes.length) {
		const left = Math.min(...boxes.map(entry => entry.box.x)), top = Math.min(...boxes.map(entry => entry.box.y));
		const width = Math.max(...boxes.map(entry => entry.box.x + entry.box.width)) - left, height = Math.max(...boxes.map(entry => entry.box.y + entry.box.height)) - top;
		if (width > 1320 || height > 780) problems.push(`the drawing is ${Math.round(width)} by ${Math.round(height)}; keep it within about 1200 by 700`);
	}
	return problems.slice(0, 20);
}
