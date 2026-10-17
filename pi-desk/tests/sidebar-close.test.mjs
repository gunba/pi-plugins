import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("the sidebar's close button appears when a conversation row is hovered or focused", () => {
	// Removing another sidebar button once took this rule with it, leaving no way to close conversations on desktop.
	const css = readFileSync(new URL("../src/client/style.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
	const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ selector, body: body.replace(/\s+/g, "") }));
	const reveals = state => rules.some(rule => rule.selector.split(",").some(part => part.includes(`.session-row:${state}`) && part.includes(".session-close"))
		&& rule.body.includes("opacity:1") && rule.body.includes("pointer-events:auto"));
	assert.ok(reveals("hover"), "hovering a row shows its close button");
	assert.ok(reveals("focus-within"), "keyboard focus on a row shows its close button");
});
