export type AgentElement = { type: string; props: Record<string, unknown>; children?: string[] };
export type AgentSpec = { root: string; elements: Record<string, AgentElement>; state?: Record<string, unknown> };
export type AgentPatch = { op: "add" | "remove" | "replace" | "move" | "copy" | "test"; path: string; value?: unknown; from?: string };
export type ElementValidator = (element: AgentElement, id: string, spec: AgentSpec) => void;
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
const own = (value: object, key: string) => Object.hasOwn(value, key);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Bound untrusted JSON before cloning, validation or rendering; prototype-bearing objects are not JSON. */
export function validateJson(value: unknown): void {
	let nodes = 0, characters = 0;
	const active = new Set<object>();
	const visit = (value: unknown, depth: number) => {
		if (++nodes > 30_000 || depth > 32) throw new Error("UI data exceeds its size or depth limit.");
		if (typeof value === "string") characters += value.length;
		else if (typeof value === "number") { if (!Number.isFinite(value)) throw new Error("UI numbers must be finite."); }
		else if (value !== null && typeof value === "object") {
			if (active.has(value)) throw new Error("UI data contains a cycle.");
			if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error("UI data must be plain JSON.");
			active.add(value);
			for (const [key, child] of Object.entries(value)) {
				if (forbidden.has(key)) throw new Error("Unsafe UI property.");
				characters += key.length; visit(child, depth + 1);
			}
			active.delete(value);
		} else if (value !== null && typeof value !== "boolean") throw new Error("UI data must be JSON.");
		if (characters > 200_000) throw new Error("UI data exceeds 200,000 characters.");
	};
	visit(value, 0);
}

/** Validate the supported json-render tree. Catalog validators supply component-specific constraints. */
export function validateSpec(value: unknown, validateElement?: ElementValidator): AgentSpec {
	validateJson(value);
	if (!object(value) || Object.keys(value).some(key => !["root", "elements", "state"].includes(key))
		|| typeof value.root !== "string" || !object(value.elements) || value.state !== undefined && !object(value.state)) throw new Error("Expected a json-render spec with root, elements and optional state.");
	const entries = Object.entries(value.elements);
	if (!entries.length || entries.length > 256) throw new Error("A UI needs between 1 and 256 elements.");
	for (const [id, element] of entries) {
		if (!/^[\w.-]{1,100}$/.test(id) || forbidden.has(id) || !object(element)
			|| Object.keys(element).some(key => !["type", "props", "children"].includes(key))
			|| typeof element.type !== "string" || !/^[A-Z][A-Za-z0-9]{0,63}$/.test(element.type) || !object(element.props)
			|| element.children !== undefined && (!Array.isArray(element.children) || element.children.some(id => typeof id !== "string"))) throw new Error(`Invalid UI element: ${id}`);
	}
	const spec = value as AgentSpec, visited = new Set<string>(), active = new Set<string>();
	const walk = (id: string, depth: number) => {
		if (!own(spec.elements, id)) throw new Error(`Missing UI element: ${id}`);
		if (active.has(id)) throw new Error(`Cyclic UI child: ${id}`);
		if (visited.has(id)) throw new Error(`UI element has multiple parents: ${id}`);
		if (depth > 24) throw new Error("UI tree is too deep.");
		visited.add(id); active.add(id);
		for (const child of spec.elements[id]!.children ?? []) walk(child, depth + 1);
		active.delete(id);
	};
	walk(spec.root, 0);
	if (visited.size !== entries.length) throw new Error("UI contains unreachable elements.");
	for (const [id, element] of Object.entries(spec.elements)) validateElement?.(element, id, spec);
	return spec;
}

function pointer(path: unknown): string[] {
	if (typeof path !== "string" || path.length > 1000 || path !== "" && !path.startsWith("/") || /~(?:[^01]|$)/.test(path as string)) throw new Error("Invalid JSON Pointer.");
	const parts = path === "" ? [] : path.slice(1).split("/").map(key => key.replace(/~1/g, "/").replace(/~0/g, "~"));
	if (parts.some(key => forbidden.has(key))) throw new Error("Unsafe JSON Pointer.");
	return parts;
}
function keyFor(parent: Record<string, unknown> | unknown[], key: string, insert = false): string | number {
	if (!Array.isArray(parent)) return key;
	if (insert && key === "-") return parent.length;
	if (!/^(0|[1-9]\d*)$/.test(key)) throw new Error("Invalid array index.");
	const index = Number(key);
	if (index >= parent.length + (insert ? 1 : 0)) throw new Error("Array index is out of bounds.");
	return index;
}
function locate(root: unknown, parts: string[]): unknown {
	let value = root;
	for (const part of parts) {
		if (!value || typeof value !== "object") throw new Error("Patch path does not exist.");
		const key = keyFor(value as Record<string, unknown>, part);
		if (!own(value, String(key))) throw new Error("Patch path does not exist.");
		value = (value as Record<string, unknown>)[key];
	}
	return value;
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function equal(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
	const keys = Object.keys(a);
	return keys.length === Object.keys(b).length && keys.every(key => own(b, key) && equal((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

/** RFC 6902 transaction: neither the original spec nor patch values are mutated, including on failure. */
export function applySpecPatch(spec: AgentSpec, patches: readonly AgentPatch[], validateElement?: ElementValidator): AgentSpec {
	validateSpec(spec);
	validateJson(patches);
	if (!Array.isArray(patches) || patches.length > 128) throw new Error("A UI update accepts at most 128 patches.");
	let next: unknown = clone(spec);
	const change = (parts: string[], value: unknown, operation: "add" | "remove" | "replace") => {
		if (!parts.length) { next = operation === "remove" ? undefined : clone(value); return; }
		const parent = locate(next, parts.slice(0, -1));
		if (!parent || typeof parent !== "object") throw new Error("Patch parent is not a container.");
		const key = keyFor(parent as Record<string, unknown>, parts.at(-1)!, operation === "add");
		if (operation !== "add" && !own(parent, String(key))) throw new Error("Patch path does not exist.");
		if (Array.isArray(parent)) {
			if (operation === "add") parent.splice(Number(key), 0, clone(value));
			else if (operation === "remove") parent.splice(Number(key), 1);
			else parent[Number(key)] = clone(value);
		} else if (operation === "remove") delete (parent as Record<string, unknown>)[key];
		else (parent as Record<string, unknown>)[key] = clone(value);
	};
	for (const patch of patches) {
		if (!patch || typeof patch !== "object" || typeof patch.op !== "string" || !["add", "remove", "replace", "move", "copy", "test"].includes(patch.op)) throw new Error("Invalid patch operation.");
		const path = pointer(patch.path);
		if (["add", "replace", "test"].includes(patch.op) && !own(patch, "value")) throw new Error("Patch value is required.");
		if (patch.op === "test") { if (!equal(locate(next, path), patch.value)) throw new Error("UI patch test failed."); }
		else if (patch.op === "move" || patch.op === "copy") {
			const from = pointer(patch.from), value = clone(locate(next, from));
			if (patch.op === "move") {
				if (path.length > from.length && from.every((key, i) => path[i] === key)) throw new Error("Cannot move a value inside itself.");
				change(from, undefined, "remove");
			}
			change(path, value, "add");
		} else change(path, patch.value, patch.op);
		validateJson(next);
	}
	return validateSpec(next, validateElement);
}
