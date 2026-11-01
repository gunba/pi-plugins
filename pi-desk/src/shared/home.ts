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
	color: choice(["accent", "input-needed", "muted", "danger"]), outline: choice(["solid", "dashed"]),
}, { additionalProperties: false });
export const HomeConnectorPropsSchema = Type.Object({ from: id, to: id, bend: Type.Number({ minimum: -300, maximum: 300 }) }, { additionalProperties: false });
export const HomePatchSchema = Type.Object({ revision: Type.Integer({ minimum: 0 }), operations: Type.Array(Type.Object({
	op: choice(["add", "remove", "replace", "move", "copy", "test"]), path: Type.String({ maxLength: 1000 }), from: Type.Optional(Type.String({ maxLength: 1000 })), value: Type.Optional(Type.Unknown()),
}, { additionalProperties: false }), { maxItems: 128 }) }, { additionalProperties: false });
export const homeCatalog: Record<string, CatalogDefinition> = {
	Canvas: { props: [], children: true },
	...Object.fromEntries(["Blob", "Pill", "Label"].map(type => [type, { props: Object.keys(HomeItemPropsSchema.properties), required: Object.keys(HomeItemPropsSchema.properties), structured: ["ref"] }])),
	Connector: { props: ["from", "to", "bend"], required: ["from", "to", "bend"] },
};
const validateHomeCatalog = catalogValidator(homeCatalog);
export type HomeReference = Static<typeof HomeReferenceSchema>;
type ItemProps = Static<typeof HomeItemPropsSchema>;
export type HomeItem = Omit<ItemProps, "title" | "subtitle" | "status"> & { id: string; shape: "blob" | "pill" | "label"; title: string; subtitle: string; status: string };
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
export const homeItemType = (type: string): boolean => ["Blob", "Pill", "Label"].includes(type);
/** Geometry and references for interaction; the shared renderer resolves display-text bindings. */
export function homeItems(scene: HomeScene): HomeItem[] {
	return Object.entries(scene.spec.elements).filter(([, element]) => homeItemType(element.type))
		.map(([id, element]) => ({ ...element.props, id, shape: element.type.toLowerCase() } as HomeItem));
}
export function validateHomeElement(element: AgentElement, id: string, spec: AgentSpec): void {
	validateHomeCatalog(element, id, spec);
	if (element.type === "Canvas") {
		if (id !== spec.root || Object.keys(element.props).length) throw Error("Home has one Canvas root with empty props.");
		return;
	}
	if (spec.elements[spec.root]?.type !== "Canvas" || !spec.elements[spec.root]?.children?.includes(id) || element.children?.length)
		throw Error("Home items and connectors must be direct children of Canvas.");
	if (element.type === "Connector") {
		if (!Value.Check(HomeConnectorPropsSchema, element.props)) throw Error("Invalid Home connector props.");
		const { from, to } = element.props;
		if (from === to || !homeItemType(spec.elements[from]?.type ?? "") || !homeItemType(spec.elements[to]?.type ?? "")) throw Error("A connector must join two existing, different items.");
	} else {
		if (!homeItemType(element.type) || !Value.Check(HomeItemPropsSchema, element.props)) throw Error(`Invalid Home component props: ${id}`);
		if (element.props.ref.kind === "url" && !homeUrl(element.props.ref.url)) throw Error("Home links must be HTTP or HTTPS URLs without credentials.");
	}
}
/** Shared RFC 6902 transaction, fenced by scene revision. A stale run cannot overwrite a drag. */
export function patchHome(scene: HomeScene, patch: HomePatch): HomeScene {
	if (patch.revision !== scene.revision) throw Error("Home changed. Read the current scene and retry the patch.");
	const spec = applySpecPatch(scene.spec, patch.operations, validateHomeElement);
	for (const [id, position] of Object.entries(scene.preferences)) if (spec.elements[id] && homeItemType(spec.elements[id]!.type)) Object.assign(spec.elements[id]!.props, position);
	validateSpec(spec, validateHomeElement);
	return { ...scene, spec, preferences: structuredClone(scene.preferences), revision: scene.revision + 1 };
}

/** Deterministic, bounded closed curve. The agent supplies parameters, never executable SVG. */
export function homeBlob(item: Pick<HomeItem, "width" | "height" | "seed" | "wobble">): string {
	const { width: w, height: h, seed, wobble } = item;
	const points = Array.from({ length: 8 }, (_, i) => {
		const a = i * Math.PI / 4, r = 1 - wobble * (0.5 + 0.5 * Math.sin(seed + i * 2.39));
		return [w / 2 + Math.cos(a) * w / 2 * r, h / 2 + Math.sin(a) * h / 2 * r];
	});
	const mid = (a: number[], b: number[]) => `${((a[0]! + b[0]!) / 2).toFixed(2)} ${((a[1]! + b[1]!) / 2).toFixed(2)}`;
	return `M ${mid(points[7]!, points[0]!)} ` + points.map((p, i) => `Q ${p[0]!.toFixed(2)} ${p[1]!.toFixed(2)} ${mid(p, points[(i + 1) % 8]!)}`).join(" ") + " Z";
}
