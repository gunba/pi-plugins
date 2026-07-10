import assert from "node:assert/strict";
import test from "node:test";

import {
	prepareApplyPatchArguments,
	prepareShellCommandArguments,
	prepareViewImageArguments,
} from "../extensions/tool-arguments.ts";

test("Codex tool argument aliases normalize to the local schemas", () => {
	assert.deepEqual(
		prepareApplyPatchArguments({ patch: "*** Begin Patch\n*** End Patch", cwd: "repo" }),
		{ input: "*** Begin Patch\n*** End Patch", workdir: "repo" },
	);
	assert.deepEqual(
		prepareShellCommandArguments({ cmd: "git status", working_directory: "repo" }),
		{ cmd: "git status", command: "git status", working_directory: "repo", workdir: "repo" },
	);
	assert.deepEqual(prepareViewImageArguments({ image_path: "figure.png" }), {
		path: "figure.png",
	});
});
