import assert from "node:assert/strict";
import test from "node:test";

import {
	formatApplyPatchCall,
	formatExecCommandCall,
	formatWriteStdinCall,
	liveOutputPreview,
	summarizeApplyPatchResult,
	summarizeExecResult,
} from "../extensions/tool-rendering.ts";

test("tool calls render as compact useful one-liners", () => {
	assert.equal(
		formatExecCommandCall({
			cmd: "npm run typecheck\n&& npm test",
			workdir: "C:/dev/pi-plugins",
			yield_time_ms: 500,
		}),
		"$ npm run typecheck && npm test in C:/dev/pi-plugins · yield 500ms",
	);
	assert.equal(
		formatWriteStdinCall({ session_id: 7, chars: "" }),
		"write_stdin #7 · poll",
	);
	assert.equal(
		formatWriteStdinCall({ session_id: 7, chars: "\u0003" }),
		'write_stdin #7 · send "^C"',
	);
	assert.equal(
		formatApplyPatchCall({
			input: [
				"*** Begin Patch",
				"*** Update File: src/a.ts",
				"*** Add File: src/b.ts",
				"*** Update File: src/a.ts",
				"*** End Patch",
			].join("\n"),
			workdir: "repo",
		}),
		"apply_patch 2 files in repo",
	);
});

test("collapsed result summaries stay terse and expose important state", () => {
	assert.equal(
		summarizeApplyPatchResult({ changes: [{ action: "updated" }] }),
		"Patched 1 file",
	);
	assert.equal(
		summarizeExecResult({ running: true, session_id: 12 }),
		"Session #12 running",
	);
	assert.equal(
		summarizeExecResult({
			exit_code: 0,
			truncated: true,
			full_output_path: "x.log",
		}),
		"Completed · output saved",
	);
	assert.equal(
		summarizeExecResult({ exit_code: 0, truncated: true }),
		"Completed · output truncated",
	);
	assert.equal(summarizeExecResult({ signal: "SIGINT" }), "Exited with SIGINT");
});

test("partial output previews retain only the live tail", () => {
	assert.equal(
		liveOutputPreview(
			"Chunk ID: abc123\nWall time: 0.2500 seconds\nProcess running with session ID 1\nOriginal token count: 5\nOutput:\none\ntwo\nthree\nfour\nfive",
		),
		"two\nthree\nfour\nfive",
	);
});
