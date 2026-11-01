import test from "node:test";
import assert from "node:assert/strict";
import { validateSpec, applySpecPatch } from "../../pi-ui/agent-ui.ts";
const scene = () => ({ root: "canvas", elements: { canvas: { type: "Canvas", props: {}, children: ["a", "b"] }, a: { type: "Blob", props: { x: 1 } }, b: { type: "Label", props: { text: "B" } } }, state: { samples: [1, 2], "a/b": 3 } });

test("shared JSON Patch updates stable IDs and child order without mutating inputs", () => {
	const before = scene(), patches = [{ op: "replace", path: "/elements/a/props/x", value: 10 }, { op: "move", from: "/elements/canvas/children/1", path: "/elements/canvas/children/0" }, { op: "add", path: "/state/samples/-", value: 3 }, { op: "replace", path: "/state/a~1b", value: 4 }];
	const next = applySpecPatch(before, patches);
	assert.deepEqual(next.elements.canvas.children, ["b", "a"]);
	assert.equal(next.elements.a.props.x, 10);
	assert.deepEqual(next.state, { samples: [1, 2, 3], "a/b": 4 });
	assert.deepEqual(before, scene());
});

test("patch failures, including final catalog validation, are atomic", () => {
	const before = scene();
	assert.throws(() => applySpecPatch(before, [{ op: "replace", path: "/elements/a/props/x", value: 20 }, { op: "test", path: "/state/a~1b", value: 99 }]), /test failed/);
	assert.throws(() => applySpecPatch(before, [{ op: "replace", path: "/elements/a/props/x", value: 20 }], element => { if (element.props.x > 5) throw new Error("geometry"); }), /geometry/);
	assert.deepEqual(before, scene());
});

test("removal is transactional across elements and references; copies do not alias", () => {
	const next = applySpecPatch(scene(), [{ op: "remove", path: "/elements/b" }, { op: "remove", path: "/elements/canvas/children/1" }, { op: "copy", from: "/elements/a/props", path: "/state/copied" }, { op: "replace", path: "/state/copied/x", value: 5 }]);
	assert.deepEqual(Object.keys(next.elements), ["canvas", "a"]);
	assert.equal(next.elements.a.props.x, 1);
	assert.deepEqual(next.state.copied, { x: 5 });
	assert.deepEqual(applySpecPatch(scene(), [{ op: "replace", path: "", value: scene() }]), scene());
	assert.throws(() => applySpecPatch(scene(), [{ op: "remove", path: "" }]), /JSON/);
});

for (const patch of [
	{ op: "replace", path: "/elements/missing/props", value: {} },
	{ op: "add", path: "/state/samples/01", value: 2 },
	{ op: "add", path: "/state/samples/99", value: 2 },
	{ op: "replace", path: "/state/a~2b", value: 2 },
	{ op: "add", path: "/__proto__/polluted", value: true },
	{ op: "copy", from: "/constructor", path: "/state/x" },
	{ op: "move", from: "/elements", path: "/elements/a/props/x" },
	{ op: "replace", path: "/elements/canvas/children/0", value: "canvas" },
	{ op: "remove", path: "/elements/canvas/children/0" },
	{ op: "replace", path: "/elements/canvas/children/0", value: "missing" },
]) test(`shared patch rejects unsafe or invalid operation ${JSON.stringify(patch)}`, () => {
	const before = scene();
	assert.throws(() => applySpecPatch(before, [patch]));
	assert.deepEqual(before, scene());
	assert.equal({}.polluted, undefined);
});

test("shared specs reject functions, infinite geometry, unknown structure and oversized trees", () => {
	assert.throws(() => validateSpec({ ...scene(), script: "run()" }), /Expected/);
	const infinite = scene(); infinite.elements.a.props.x = Infinity;
	assert.throws(() => validateSpec(infinite), /finite/);
	const cyclic = scene(); cyclic.state.self = cyclic.state;
	assert.throws(() => validateSpec(cyclic), /cycle/);
	const huge = scene(); huge.state.text = "a".repeat(200_001);
	assert.throws(() => validateSpec(huge), /characters/);
});
