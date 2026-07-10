import assert from "node:assert/strict";
import test from "node:test";

import {
	formatApplyPatchCall,
	formatShellCommandCall,
	formatWriteStdinCall,
	liveOutputPreview,
	summarizeApplyPatchResult,
	summarizeShellResult,
} from "../extensions/tool-rendering.ts";

test("tool calls render as compact useful one-liners", () => {
	assert.equal(
		formatShellCommandCall({
			command: "npm run typecheck\n&& npm test",
			workdir: "C:/dev/pi-plugins",
			yield_time_ms: 500,
		}),
		"$ npm run typecheck && npm test in C:/dev/pi-plugins · yield 500ms",
	);
	assert.equal(formatWriteStdinCall({ session_id: 7, chars: "" }), "write_stdin #7 · poll");
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
				"*** End Patch",
			].join("\n"),
			workdir: "repo",
		}),
		"apply_patch 2 files in repo",
	);
});

test("collapsed result summaries stay terse and expose important state", () => {
	assert.equal(summarizeApplyPatchResult({ changes: [{ action: "updated" }] }), "Patched 1 file");
	assert.equal(
		summarizeShellResult({ running: true, session_id: 12 }),
		"Session #12 running",
	);
	assert.equal(
		summarizeShellResult({ exit_code: 0, truncated: true, full_output_path: "x.log" }),
		"Completed · output saved",
	);
	assert.equal(summarizeShellResult({ timed_out: true }), "Timed out");
});

test("partial output previews retain only the live tail", () => {
	assert.equal(
		liveOutputPreview("one\ntwo\nthree\nfour\nfive\nProcess running with session ID 1."),
		"two\nthree\nfour\nfive",
	);
});
