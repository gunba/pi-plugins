import assert from "node:assert/strict";
import test from "node:test";
import { blockingPrompt, createHarness, FakeDriverFactory, waitUntil } from "./helpers.mjs";

test("children inherit current parent tools, including additions and explicit revocations", async () => {
	let active = ["read", "web_search", "arbitrary/custom_tool"];
	const factory = new FakeDriverFactory(blockingPrompt);
	const h = createHarness({ factory, getActiveToolNames: () => [...active] });
	try {
		await h.runtime.start({
			description: "tool inheritance", prompt: "work", context: "fresh", runInBackground: true,
			parent: h.parent({ toolNames: ["read"] }),
		});
		await waitUntil(() => factory.opens.length === 1, "child activation");
		const authority = factory.opens[0].input.authority;
		assert.deepEqual(h.runtime.toolNamesFor(authority), [...active].sort());
		active = ["web_search"];
		assert.deepEqual(h.runtime.toolNamesFor(authority), ["web_search"]);
		active = ["newly_enabled_tool", "web_search"];
		assert.deepEqual(h.runtime.toolNamesFor(authority), [...active].sort());
		await h.runtime.shutdown();
		assert.throws(() => h.runtime.toolNamesFor(authority));
	} finally { await h.cleanup(); }
});
