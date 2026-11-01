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
