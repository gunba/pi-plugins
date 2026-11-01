import test from "node:test";
import assert from "node:assert/strict";
import { updatePart, restoredParts } from "../../pi-show/extensions/parts.ts";
import { SHOWN_ENTRY } from "../../pi-show/extensions/types.ts";
import { visibleWorkItems } from "../src/client/work-items.ts";
import { catalogValidator, validateChart } from "../../pi-ui/agent-catalog.ts";
import { validateSpec } from "../../pi-ui/agent-ui.ts";
import { Transcript } from "../src/host/transcript.ts";
import { TranscriptFeed } from "../src/host/transcript-feed.ts";

const spec = () => ({ root: "m", elements: { m: { type: "Metric", props: { label: "Count", value: 1 } } } });
const message = (id, order, shown) => ({ id, order, timestamp: order, role: "tool", blocks: [{ type: "shown", shown, files: [] }] });

test("show snapshots patch by ID, preserve attachments and clear sources explicitly", () => {
	const parts = new Map(), first = updatePart(parts, "job", { title: "Job", spec: spec(), source: { file: "progress", pattern: "{done}/{total}" } }, [{ url: "https://example.com" }]);
	parts.set("job", first);
	const next = updatePart(parts, "job", { patch: [{ op: "replace", path: "/elements/m/props/value", value: 2 }], source: null, collapsed: true });
	assert.equal(next.spec.elements.m.props.value, 2);
	assert.deepEqual(next.items, first.items);
	assert.equal(next.source, undefined);
	assert.equal(next.collapsed, true);
	assert.equal(first.spec.elements.m.props.value, 1);
	const entries = [first, next, { ...next, remove: true }].map(data => ({ type: "custom", customType: SHOWN_ENTRY, data }));
	assert.deepEqual([...restoredParts(entries.slice(0, 2)).values()], [next]);
	assert.equal(restoredParts(entries).size, 0);
	assert.throws(() => updatePart(parts, "job", { before: "missing" }), /does not exist/);
});

test("parts reorder, pin, collapse and disappear independently of selected activity", () => {
	const a = { id: "a", title: "A", items: [], spec: spec() }, b = { id: "b", title: "B", items: [], spec: spec() };
	const quiet = { id: "quiet", order: 0, timestamp: 0, role: "tool", blocks: [{ type: "diff", path: "quiet", text: "+1 hidden" }, { type: "image", asset: "hidden" }] };
	const selected = { id: "selected", order: 1, timestamp: 1, role: "tool", work: { description: "Useful change" }, blocks: [{ type: "diff", path: "important", text: "+1 shown" }] };
	const history = [quiet, selected, message("a", 2, a), message("b", 3, b), message("b-update", 4, { ...b, before: "a", pinned: true, collapsed: true })];
	assert.deepEqual(visibleWorkItems(history).map(item => item.id), ["selected:0", "part:b", "part:a"]);
	assert.equal(visibleWorkItems(history)[0].title, "Useful change");
	assert.equal(visibleWorkItems(history)[1].block.shown.collapsed, true);
	assert.deepEqual(visibleWorkItems([...history, message("delete", 5, { ...a, remove: true })]).map(item => item.id), ["selected:0", "part:b"]);
	assert.deepEqual(visibleWorkItems([...history].reverse()).map(item => item.id), ["selected:0", "part:b", "part:a"]);
});

test("catalog validation rejects unknown props and unsafe chart capabilities", () => {
	assert.throws(() => validateSpec({ root: "x", elements: { x: { type: "Text", props: { text: "Hi", style: "position:fixed" } } } }, catalogValidator()), /Unknown/);
	assert.throws(() => validateSpec({ root: "x", elements: { x: { type: "Link", props: { url: "javascript:alert(1)" } } } }, catalogValidator()), /HTTP/);
	assert.throws(() => validateSpec({ root: "x", elements: { x: { type: "Image", props: { item: -1, alt: "bad" } } } }, catalogValidator()), /index/);
	assert.throws(() => validateChart({ data: { url: "https://example.com/private" }, mark: "bar" }), /url/);
	assert.throws(() => validateChart({ data: { values: [] }, mark: "image" }), /image/);
	assert.throws(() => validateChart({ transform: [{ calculate: "fetch('/private')", as: "v" }], mark: "bar" }), /transform/);
	assert.throws(() => validateChart({ mark: { type: "text", href: "https://example.com" } }), /href/);
	assert.throws(() => validateChart({ data: { values: Array(1001).fill({ x: 1 }) }, mark: "bar" }), /1,000/);
});

test("custom catalogs explicitly allow structured references without admitting arbitrary props", () => {
	const validate = catalogValidator({ Blob: { props: ["ref"], structured: ["ref"] } });
	const blob = { root: "blob", elements: { blob: { type: "Blob", props: { ref: { kind: "quest", id: "q" } } } } };
	assert.equal(validateSpec(blob, validate), blob);
	assert.throws(() => validateSpec({ ...blob, elements: { blob: { ...blob.elements.blob, props: { ...blob.elements.blob.props, unsafe: {} } } } }, validate), /Unknown/);
});

test("current parts survive transcript pagination and selected bash keeps output with its files", () => {
	const branch = [{ type: "custom", id: "part", timestamp: new Date(1).toISOString(), customType: SHOWN_ENTRY, data: { id: "job", title: "Job", items: [], spec: spec() } }];
	for (let i = 0; i < 300; i++) branch.push({ type: "message", id: `m${i}`, timestamp: new Date(i + 2).toISOString(), message: { role: "user", content: "later", timestamp: i + 2 } });
	const feed = new TranscriptFeed(new Transcript(), () => branch, () => "generation", () => {}, () => process.cwd());
	try { assert.equal(feed.history().messages.some(message => message.id === "entry:part"), true); } finally { feed.close(); }
	const activity = new Transcript().entry({ type: "custom", id: "bash", timestamp: new Date().toISOString(), customType: "pi-show:activity", data: {
		toolName: "bash", description: "Build and save results", content: [{ type: "text", text: "All passed" }], details: { files: [{ path: "results.txt", diff: "+1 Result", added: 1 }] },
	} });
	assert.equal(visibleWorkItems([activity]).length, 1);
	assert.equal(activity.blocks[0].shown.items[0].path, "results.txt");
	assert.equal(activity.blocks[0].shown.spec.elements.output.props.text, "All passed");
});
