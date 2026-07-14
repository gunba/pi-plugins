import assert from "node:assert/strict";
import test from "node:test";

import {
	prepareApplyPatchArguments,
	prepareViewImageArguments,
} from "../extensions/tool-arguments.ts";

test("non-exec Codex tool argument aliases normalize to the local schemas", () => {
	assert.deepEqual(
		prepareApplyPatchArguments({
			patch: "*** Begin Patch\n*** End Patch",
			cwd: "repo",
		}),
		{ input: "*** Begin Patch\n*** End Patch", workdir: "repo" },
	);
	assert.deepEqual(prepareViewImageArguments({ image_path: "figure.png" }), {
		path: "figure.png",
	});
});

test("argument preparation preserves unknown fields for strict schema rejection", () => {
	assert.deepEqual(
		prepareApplyPatchArguments({
			patch: "*** Begin Patch\n*** End Patch",
			cwd: "repo",
			unexpected: true,
		}),
		{
			input: "*** Begin Patch\n*** End Patch",
			workdir: "repo",
			unexpected: true,
		},
	);
	assert.deepEqual(
		prepareViewImageArguments({ image_path: "figure.png", unexpected: true }),
		{ path: "figure.png", unexpected: true },
	);
});

test("apply_patch command aliases require exactly one patch argument", () => {
	assert.deepEqual(
		prepareApplyPatchArguments({
			command: ["apply_patch", "patch", "extra"],
		}),
		{ command: ["apply_patch", "patch", "extra"] },
	);
});
