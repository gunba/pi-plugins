import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import webSearchExtension from "../extensions/web-search.ts";
import { renderSearchResult, searchDisplayText } from "../extensions/render.ts";

const theme = { fg(_color, text) { return text; } };
const marker = value => `\uE200cite\uE202${value}\uE201`;

test("renders the source and numbered links seen in the reported web-search result", () => {
	const raw = `${marker("turn54view0")} [wordlim: 200]\nL0: ${marker("0†Skip to main content")}\nL6: ${marker("2†Download Microsoft Edge†go.microsoft.com")}`;
	assert.equal(searchDisplayText(raw), "[turn54view0] [wordlim: 200]\nL0: [0] Skip to main content\nL6: [2] Download Microsoft Edge (go.microsoft.com)");
});

test("retains multiple references, unknown widget data, partial markers and ordinary Unicode", () => {
	assert.equal(searchDisplayText(marker("turn0search0\uE202turn0search1")), "[turn0search0] [turn0search1]");
	assert.equal(searchDisplayText('\uE200visualize\uE202{"path":"chart.html"}\uE201'), '[visualize: {"path":"chart.html"}]');
	assert.equal(searchDisplayText("\uE200cite\uE202turn1"), "[cite: turn1");
	assert.equal(searchDisplayText("漢字 é 🇦🇺 [ordinary](https://example.com)"), "漢字 é 🇦🇺 [ordinary](https://example.com)");
});

test("web content cannot inject terminal commands or hyperlinks through the renderer", () => {
	assert.equal(searchDisplayText("\x1b[2Jvisible\x1b]8;;https://example.test\x07link\x1b]8;;\x07\x00"), "visiblelink");
});

test("collapsed and expanded rendering preserve source evidence and clamp narrow rows", () => {
	const raw = Array.from({ length: 20 }, (_, i) => `${marker(`turn${i}view0`)} Example 漢字`).join("\n");
	const result = Object.freeze({
		content: Object.freeze([Object.freeze({ type: "text", text: raw })]),
		details: Object.freeze({ results: Object.freeze([{ ref_id: "turn0view0" }]) }),
	});
	const before = JSON.stringify(result);
	for (const width of [1, 5, 18, 80]) {
		const collapsed = renderSearchResult(result, { expanded: false, isPartial: false }, theme).render(width);
		const expanded = renderSearchResult(result, { expanded: true, isPartial: false }, theme).render(width);
		assert.equal(collapsed.length, 11);
		if (width >= 18) assert.match(collapsed.at(-1), /more lines/);
		assert.ok(collapsed.every(line => visibleWidth(line) <= width));
		assert.ok(expanded.length >= 20);
		assert.ok(expanded.every(line => visibleWidth(line) <= width));
		assert.doesNotMatch(expanded.join("\n"), /[\uE200-\uE202]/);
	}
	assert.equal(JSON.stringify(result), before);
	assert.equal(result.content[0].text, raw);
});

test("registered renderer works through Pi's native tool result and independent mouse expansion", async () => {
	const { ToolExecutionComponent } = await import(new URL(
		"./modes/interactive/components/tool-execution.js",
		import.meta.resolve("@earendil-works/pi-coding-agent"),
	));
	initTheme("dark", false);
	let definition;
	webSearchExtension({
		on() {}, getActiveTools() { return ["web_search"]; }, setActiveTools() {},
		registerTool(tool) { definition = tool; },
	});
	const raw = Array.from({ length: 24 }, (_, i) => `${marker(`turn${i}view0`)} Line ${i}`).join("\n");
	const result = { content: [{ type: "text", text: raw }], details: { results: [] }, isError: false };
	const before = JSON.stringify(result);
	const component = new ToolExecutionComponent("web_search", "fixture-call", {}, undefined, definition,
		{ terminal: { columns: 100, rows: 40 }, requestRender() {} }, process.cwd());
	component.updateResult(result);
	const collapsed = component.render(100);
	assert.doesNotMatch(collapsed.join("\n"), /[\uE200-\uE202]|Line 23/);
	const y = collapsed.findIndex(line => line.includes("[turn0view0]"));
	assert.ok(y >= 0);
	assert.equal(component.handleMouse({
		type: "click", button: "left", x: 4, y, screenX: 4, screenY: y,
		width: 100, height: collapsed.length, shift: false, alt: false, ctrl: false,
	}).handled, true);
	assert.match(component.render(100).join("\n"), /\[turn23view0\] Line 23/);
	component.setExpanded(false);
	assert.doesNotMatch(component.render(100).join("\n"), /Line 23/);
	assert.equal(JSON.stringify(result), before);
});
