import assert from "node:assert/strict";
import test from "node:test";
import { prepareViewImageArguments } from "../extensions/tool-arguments.ts";

test("image paths normalize while preserving unknown fields for strict schema rejection", () => {
	assert.deepEqual(prepareViewImageArguments({ image_path: "figure.png" }), { path: "figure.png" });
	assert.deepEqual(prepareViewImageArguments({ image_path: "figure.png", unexpected: true }),
		{ path: "figure.png", unexpected: true });
	assert.throws(() => prepareViewImageArguments({ path: 42 }), /path must be a string/);
});
