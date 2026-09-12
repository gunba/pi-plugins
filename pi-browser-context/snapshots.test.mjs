import assert from "node:assert/strict";
import test from "node:test";
import { snapshotFrom, compactDiff, SnapshotCache, browserMethod } from "./snapshots.ts";

const observation = tree => `### Open tabs\n- 1: (current) [Fixture](about:blank)\n### Page\n- Page URL: about:blank\n### Snapshot\n\`\`\`yaml\n${tree}\n\`\`\`\n### Events\n- Example event\n`;

test("recognizes explicit trees, preserves surrounding evidence and separates scopes", () => {
	const text = observation('- button "Save" [ref=e4]');
	const value = snapshotFrom(text);
	assert.equal(value.tree, '- button "Save" [ref=e4]');
	assert.equal(text.slice(0, value.start).endsWith("### Snapshot\n"), true);
	assert.equal(text.slice(value.end), "### Events\n- Example event\n");
	assert.notEqual(value.key, snapshotFrom(text, "#dialog").key);
	assert.equal(snapshotFrom("### Snapshot\n- [Snapshot](example.yml)"), undefined);
	assert.equal(snapshotFrom(text.replace("- Page URL:", "- Address:")), undefined);
});

test("diffs retain exact changed references, removals, and Unicode", () => {
	const before = '- button "Save" [ref=e1]\n- status [ref=e2]: Ready\n- link "Old" [ref=e3]';
	const after = '- button "Save" [ref=e1]\n- status [ref=e2]: Saved ✓';
	const diff = compactDiff(before, after);
	assert.match(diff, /-.*Ready/);
	assert.match(diff, /-.*Old/);
	assert.match(diff, /\+.*Saved ✓/);
	assert.doesNotMatch(diff, /button "Save"/);
	assert.equal(compactDiff(after, after), "No accessibility changes.");
});

test("a stable large page needs only the changed lines", () => {
	const before = Array.from({ length: 1000 }, (_, i) => `- listitem [ref=e${i + 10}]: Fixture row ${i}`).join("\n");
	const after = before.replace("Fixture row 500", "Updated row 500");
	assert.ok(compactDiff(before, after).length < after.length / 100);
});

test("cache is bounded, generation-resettable and rejects late observations", () => {
	const cache = new SnapshotCache();
	cache.set("one", { tree: "current", sequence: 2, artifact: "b" });
	cache.set("one", { tree: "stale", sequence: 1, artifact: "a" });
	assert.equal(cache.get("one").tree, "current");
	for (let i = 0; i < 10; i++) cache.set(String(i), { tree: "x", sequence: i, artifact: "x" });
	assert.equal(cache.get("one"), undefined);
	cache.clear();
	assert.equal(cache.get("9"), undefined);
	cache.set("oversized", { tree: "x".repeat(512001), sequence: 1, artifact: "x" });
	assert.equal(cache.get("oversized"), undefined);
});

test("browser routing excludes other tools and other MCP servers", () => {
	assert.equal(browserMethod("playwright_browser_snapshot", {}), "browser_snapshot");
	assert.equal(browserMethod("mcp", { tool: "playwright_browser_snapshot" }), "browser_snapshot");
	assert.equal(browserMethod("mcp", { server: "playwright", tool: "browser_snapshot" }), "browser_snapshot");
	assert.equal(browserMethod("mcp", { server: "other", tool: "playwright_browser_snapshot" }), undefined);
	assert.equal(browserMethod("mcp", { tool: "browser_snapshot" }), undefined);
	assert.equal(browserMethod("read", {}), undefined);
});
