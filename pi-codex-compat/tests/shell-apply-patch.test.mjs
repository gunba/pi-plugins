import assert from "node:assert/strict";
import test from "node:test";

import { extractShellApplyPatch } from "../extensions/shell-apply-patch.ts";

const PATCH = [
	"*** Begin Patch",
	"*** Add File: value.txt",
	"+value",
	"*** End Patch",
].join("\n");

test("structural recognizer accepts the complete upstream heredoc forms", () => {
	assert.deepEqual(
		extractShellApplyPatch(`apply_patch <<'PATCH'\n${PATCH}\nPATCH`),
		{ input: PATCH, workdir: undefined },
	);
	assert.deepEqual(extractShellApplyPatch(`applypatch<<EOF\n${PATCH}\nEOF\n`), {
		input: PATCH,
		workdir: undefined,
	});
	assert.deepEqual(
		extractShellApplyPatch(
			`cd "folder with spaces"&&apply_patch <<"END-MARK"\n${PATCH}\nEND-MARK`,
		),
		{ input: PATCH, workdir: "folder with spaces" },
	);
	assert.deepEqual(
		extractShellApplyPatch(
			"cd folder\\ with\\ spaces && apply_patch <<-PATCH\n\t*** Begin Patch\n\t*** Add File: value.txt\n\t+value\n\t*** End Patch\n\tPATCH",
		),
		{ input: PATCH, workdir: "folder with spaces" },
	);
	assert.deepEqual(
		extractShellApplyPatch(
			`cd 'literal*name' && apply_patch <<EOF\n${PATCH}\nEOF`,
		),
		{ input: PATCH, workdir: "literal*name" },
	);
	assert.deepEqual(
		extractShellApplyPatch(`cd ' padded ' && apply_patch <<EOF\n${PATCH}\nEOF`),
		{ input: PATCH, workdir: " padded " },
	);
});

test("structural recognizer rejects extra commands, arguments, redirects, and cd operands", () => {
	const invalid = [
		`echo before; apply_patch <<'PATCH'\n${PATCH}\nPATCH`,
		`apply_patch extra <<'PATCH'\n${PATCH}\nPATCH`,
		`apply_patch <<'PATCH' && echo after\n${PATCH}\nPATCH`,
		`cd one two && apply_patch <<'PATCH'\n${PATCH}\nPATCH`,
		`cd one || apply_patch <<'PATCH'\n${PATCH}\nPATCH`,
		`cd one; apply_patch <<'PATCH'\n${PATCH}\nPATCH`,
		`cd ~ && apply_patch <<'PATCH'\n${PATCH}\nPATCH`,
		`cd sub* && apply_patch <<'PATCH'\n${PATCH}\nPATCH`,
		`cd sub? && apply_patch <<'PATCH'\n${PATCH}\nPATCH`,
		`cd - && apply_patch <<'PATCH'\n${PATCH}\nPATCH`,
		`cd -- && apply_patch <<'PATCH'\n${PATCH}\nPATCH`,
		`cd -P && apply_patch <<'PATCH'\n${PATCH}\nPATCH`,
		`cd sub\r && apply_patch <<'PATCH'\r\n${PATCH}\r\nPATCH`,
		`apply_patch > out <<'PATCH'\n${PATCH}\nPATCH`,
		`apply_patch <<'PATCH'\n${PATCH}\n PATCH`,
		`apply_patch <<'PATCH'\n${PATCH}\nPATCH   `,
		`apply_patch <<'PATCH'\n${PATCH}\nPATCH\t`,
		`apply_patch <<'PATCH'\n${PATCH}\nPATCH\necho after`,
	];
	for (const command of invalid) {
		assert.equal(extractShellApplyPatch(command), undefined, command);
	}
});

test("structural recognizer declines shell expansions and malformed quoting", () => {
	const invalid = [
		`cd "$WORKDIR" && apply_patch <<'PATCH'\n${PATCH}\nPATCH`,
		`cd \`pwd\` && apply_patch <<'PATCH'\n${PATCH}\nPATCH`,
		`cd 'unterminated && apply_patch <<'PATCH'\n${PATCH}\nPATCH`,
		`apply_patch <<''\n${PATCH}\n`,
		`apply_patch <<'PATCH\n${PATCH}\nPATCH`,
	];
	for (const command of invalid) {
		assert.equal(extractShellApplyPatch(command), undefined, command);
	}
});
