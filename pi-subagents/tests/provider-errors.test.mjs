import assert from "node:assert/strict";
import test from "node:test";

import { providerFailureHint } from "../extensions/provider-errors.ts";

test("image serialization failures receive a permanent-repair hint", () => {
	const hint = providerFailureHint({
		stopReason: "error",
		errorMessage:
			"Invalid 'input[0].output[1].image_url'. Expected a base64-encoded data URL with an image MIME type, but got unsupported MIME type 'undefined'.",
	});

	assert.match(hint, /pi-codex-compat/);
	assert.match(hint, /\/repair-session-images/);
	assert.match(hint, /retrying unchanged history will repeat/i);
});

test("other deterministic request-shape failures discourage blind retries", () => {
	const hint = providerFailureHint({
		stopReason: "error",
		errorMessage: "Invalid request: schema expected a text content block",
	});

	assert.match(hint, /serialized request shape/i);
	assert.match(hint, /repair the saved session/i);
});

test("transient and unrelated provider failures do not receive a repair hint", () => {
	assert.equal(
		providerFailureHint({ stopReason: "error", errorMessage: "429 rate limit exceeded" }),
		undefined,
	);
	assert.equal(providerFailureHint({ stopReason: "stop" }), undefined);
});
