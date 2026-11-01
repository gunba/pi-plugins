import { validateJson, type AgentElement, type AgentSpec } from "./agent-ui.ts";

export type CatalogDefinition = { props: readonly string[]; required?: readonly string[]; children?: boolean; structured?: readonly string[] };
export const workCatalog: Record<string, CatalogDefinition> = {
	Column: { props: [], children: true }, Row: { props: [], children: true },
	Part: { props: ["title", "collapsed"], children: true },
	Text: { props: ["text"], required: ["text"] },
	Progress: { props: ["label", "done", "total", "item", "rate", "eta"], required: ["done", "total"] },
	Metric: { props: ["label", "value", "detail"], required: ["label", "value"] },
	Table: { props: ["columns", "rows"], required: ["columns", "rows"] },
	List: { props: ["items"], required: ["items"] },
	Link: { props: ["label", "url"], required: ["url"] },
	Image: { props: ["item", "alt"], required: ["item", "alt"] },
	File: { props: ["item"], required: ["item"] },
	Code: { props: ["text", "language"], required: ["text"] },
	Diff: { props: ["before", "after"], required: ["before", "after"] },
	Chart: { props: ["spec"], required: ["spec"] },
};
export function safeUiUrl(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length > 8000) return;
	try { const url = new URL(value); if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password) return url.href; } catch { /* Invalid links are not navigable. */ }
	return;
}
/** Chart data is inline; expressions, URL loaders and user transforms are not a rendering capability. */
export function validateChart(value: unknown): void {
	validateJson(value);
	let values = 0;
	const walk = (value: unknown, depth: number) => {
		if (depth > 12) throw new Error("Chart is too deeply nested.");
		if (!value || typeof value !== "object") return;
		for (const [key, child] of Object.entries(value)) {
			if (["url", "href", "expr", "signal", "calculate", "transform", "params", "datasets", "repeat"].includes(key)) throw new Error(`Chart ${key} is not supported; use inline data and encodings.`);
			if (key === "values") { if (!Array.isArray(child)) throw new Error("Chart values must be rows."); values += child.length; }
			if (key === "mark" && (child === "image" || typeof child === "object" && child && "type" in child && child.type === "image")) throw new Error("Chart image marks are not supported.");
			walk(child, depth + 1);
		}
	};
	walk(value, 0);
	if (values > 1000) throw new Error("Charts support at most 1,000 inline rows.");
}
const bound = (value: unknown) => !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 1 && "$state" in value && typeof value.$state === "string" && /^\/(?:[^~]|~[01])*$/.test(value.$state) && !value.$state.split("/").some(key => ["__proto__", "constructor", "prototype"].includes(key));
/** Catalog composition is shared with Home; each component must explicitly declare its props. */
export function catalogValidator(definitions: Record<string, CatalogDefinition> = workCatalog) {
	return (element: AgentElement, id: string, _spec: AgentSpec) => {
		const definition = definitions[element.type];
		if (!definition || Object.keys(element.props).some(key => !definition.props.includes(key))) throw new Error(`Unknown component or property on ${id}.`);
		if (definition.required?.some(key => !(key in element.props))) throw new Error(`Missing property on ${id}.`);
		if (element.children?.length && !definition.children) throw new Error(`${element.type} cannot contain children.`);
		for (const [key, value] of Object.entries(element.props)) {
			if (value && typeof value === "object" && !["spec", "rows", "columns", "items", ...definition.structured ?? []].includes(key) && !bound(value)) throw new Error(`Invalid binding on ${id}.${key}.`);
			if (bound(value)) continue;
			if (["url"].includes(key) && !safeUiUrl(value)) throw new Error("Expected a credential-free HTTP(S) URL.");
			if (["done", "total", "rate", "eta"].includes(key) && (typeof value !== "number" || value < 0)) throw new Error(`${key} must be nonnegative.`);
			if (["text", "label", "title", "detail", "alt", "language", "before", "after"].includes(key) && typeof value !== "string") throw new Error(`${key} must be text.`);
			if (key === "collapsed" && typeof value !== "boolean") throw new Error("collapsed must be boolean.");
		}
		if (["File", "Image"].includes(element.type) && (typeof element.props.item !== "number" || !Number.isInteger(element.props.item) || element.props.item < 0 || element.props.item > 11)) throw new Error("File/Image item must index an attached item (0–11).");
		if (element.type === "Chart") validateChart(element.props.spec);
		if (element.type === "Table" && !bound(element.props.rows) && (!Array.isArray(element.props.rows) || element.props.rows.length > 500 || element.props.rows.some(row => !Array.isArray(row) || row.length > 24 || row.some(cell => cell !== null && !["string", "number", "boolean"].includes(typeof cell))))) throw new Error("Table rows must contain at most 500 rows of 24 scalar cells.");
		if (element.type === "Table" && (!Array.isArray(element.props.columns) || element.props.columns.length > 24 || element.props.columns.some(column => typeof column !== "string"))) throw new Error("Table columns must be text.");
		if (element.type === "List" && !bound(element.props.items) && (!Array.isArray(element.props.items) || element.props.items.length > 200 || element.props.items.some(item => typeof item !== "string"))) throw new Error("List items must be text.");
	};
}
