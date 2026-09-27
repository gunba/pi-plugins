import assert from "node:assert/strict";
import test from "node:test";
import { SurfaceHistory } from "../src/client/surface-history.ts";
const tick = () => new Promise(resolve => setImmediate(resolve));
function navigation() {
	const entries = [null]; let index = 0, controller;
	const history = {
		get state() { return entries[index]; }, get length() { return entries.length; },
		pushState(value) { entries.splice(index + 1, entries.length, value); index++; },
		replaceState(value) { entries[index] = value; },
		back() { queueMicrotask(() => { if (index) { index--; controller.pop(); } }); },
	};
	controller = new SurfaceHistory(history);
	return { history, get controller() { return controller; }, reload() { controller = new SurfaceHistory(history); return controller.prepare(); } };
}
test("Back dismisses only the top surface and does not accumulate empty navigation entries", async () => {
	const nav = navigation(), closed = [];
	await nav.controller.prepare();
	const sidebar = { close: () => closed.push("navigation") }, dialog = { close: () => closed.push("dialog") };
	nav.controller.add(sidebar); nav.controller.add(dialog); await tick();
	nav.history.back(); await tick();
	assert.deepEqual(closed, ["dialog"]);
	assert.equal(nav.controller.top, sidebar);
	nav.history.back(); await tick();
	assert.deepEqual(closed, ["dialog", "navigation"]);
	assert.equal(nav.controller.top, undefined);
	for (let count = 0; count < 10; count++) {
		nav.controller.add(dialog); await tick(); nav.controller.dismiss(dialog); await tick();
	}
	assert.equal(nav.history.length, 2);
});
test("replacement questions and internal panel navigation keep one usable Back entry", async () => {
	const nav = navigation(); await nav.controller.prepare();
	const remove = nav.controller.add({ close() {} }); await tick();
	remove();
	let parent = false;
	const panel = { close() {}, back: () => { parent = true; panel.back = undefined; } };
	nav.controller.add(panel); await tick();
	nav.history.back(); await tick();
	assert.equal(parent, true); assert.equal(nav.controller.top, panel);
	await nav.reload();
	assert.equal(nav.history.state["pi-desk:surface"], undefined);
});
