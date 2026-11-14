import assert from "node:assert/strict";
import test from "node:test";
import { parseReply, replyText } from "../src/tidy.ts";

test("a reply cut off at the output limit is reported as cut off, not as broken JSON", () => {
	// Gunba WoW Addons, 12 to 14 November: every pass ended at 16,000 tokens, most of them thinking, with its JSON
	// unfinished, and failed with "Expected ',' or ']' after array element in JSON at position 6146".
	const cut = { stopReason: "length", usage: { output: 16000 },
		content: [{ type: "thinking", thinking: "Which of these still hold?" }, { type: "text", text: '{"admit":["l20","l21"],"retire":[{"id":"l22"},{"id":"l2' }] };
	assert.throws(() => replyText(cut), { message: "The model's reply was cut off at its limit of 16,000 tokens." });

	const whole = { stopReason: "stop", usage: { output: 5611 },
		content: [{ type: "thinking", thinking: "Which of these still hold?" }, { type: "text", text: '{"admit":["l20","l21"]}' }] };
	assert.deepEqual(parseReply(replyText(whole)), { admit: ["l20", "l21"] });
});
