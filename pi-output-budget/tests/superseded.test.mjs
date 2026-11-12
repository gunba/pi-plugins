import assert from "node:assert/strict";
import test from "node:test";
import { withoutSuperseded } from "../extensions/superseded.ts";

test("a reasoning-level change is no reason to rewrite old tool results where the cache survives it", () => {
	// 12 November: the level changed in the middle of a run on Claude Haiku 5.5, eight earlier `echo` results were
	// replaced by stubs, and the next request read 12,550 cached tokens of a 14,300-token conversation.
	const call = (id, command) => ({ role: "assistant", provider: "anthropic", model: "claude-opus-5-5",
		content: [{ type: "toolCall", id, name: "bash", arguments: { command } }] });
	const result = (id, text) => ({ role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text }] });
	const messages = [call("a", "echo 1"), result("a", "1"), call("b", "echo 1"), result("b", "1")];
	const branch = [...messages.map(message => ({ type: "message", message })), { type: "thinking_level_change", thinkingLevel: "high" }];
	const recorded = [];

	const keepsCache = { provider: "anthropic", id: "claude-opus-5-5", compat: { supportsMidConvoEffort: true } };
	assert.equal(withoutSuperseded(messages, branch, keepsCache, "/tmp", stubs => recorded.push(stubs)), undefined, "the request goes out unchanged");
	assert.deepEqual(recorded, []);

	const losesCache = { provider: "anthropic", id: "claude-opus-5-5" };
	const sent = withoutSuperseded(messages, branch, losesCache, "/tmp", stubs => recorded.push(stubs));
	assert.equal(sent[1].content[0].text, "[Result removed: `echo 1` is superseded; the same command ran again later (call b).]");
	assert.deepEqual(recorded.map(stubs => Object.keys(stubs)), [["a"]]);
});
