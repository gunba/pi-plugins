import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closestRegion, editHint, missingPath, missingPathHint, occurrenceLines } from "../extensions/repair.ts";

function repository(t) {
	const root = mkdtempSync(join(tmpdir(), "repair-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "pi-party"), { recursive: true }); mkdirSync(join(root, "pi-desk", "src"), { recursive: true });
	writeFileSync(join(root, "pi-party", "store.ts"), "export class Store {}\n");
	writeFileSync(join(root, "pi-desk", "src", "app.ts"), Array.from({ length: 30 }, (_, i) => `line ${i + 1} of the app`).join("\n") + "\n");
	execFileSync("git", ["init", "-q", root]); execFileSync("git", ["-C", root, "add", "."]);
	return root;
}

test("a path from the wrong folder gets the place it exists, and a wrong folder gets files of that name", async t => {
	const root = repository(t);
	// 170 read/grep/ls failures since 26 Sep were mostly a relative path resolved from the wrong folder.
	assert.equal(await missingPathHint("pi-party/store.ts", join(root, "pi-desk"), []), `Not found at ${join(root, "pi-desk", "pi-party", "store.ts")}; it exists at ${join(root, "pi-party", "store.ts")}.`);
	assert.equal(await missingPathHint(join(root, "pi-output-budget", "extensions", "store.ts"), root, []),
		`Not found at ${join(root, "pi-output-budget", "extensions", "store.ts")}. Files named store.ts in ${root}: ${join("pi-party", "store.ts")}.`);
	assert.equal(await missingPathHint("nothing-like-it.ts", root, []), undefined);
	assert.equal(missingPath("ENOENT: no such file or directory, access '/x/y.ts'", {}), "/x/y.ts");
	assert.equal(missingPath("Path not found: /x/z", {}), "/x/z");
});

test("an edit that did not match gets the closest region with line numbers; a repeated one gets each line", t => {
	const root = repository(t), app = join(root, "pi-desk", "src", "app.ts");
	const region = closestRegion("a\nb\nline 12 of the app\nline 13 of the app\nline 14 of the APP\n", "line 12 of the app\nline 13 of the app\nline 14 of the app");
	assert.match(region, /^Closest match, lines 3–5 \(first difference at line 5\):/);
	assert.match(region, /\n    5 line 14 of the APP/);
	assert.deepEqual(occurrenceLines("x\ny\nx\n", "x"), [1, 3]);
	const hint = editHint(`Could not find edits[1] in ${app}. The oldText must match exactly including all whitespace and newlines.`,
		{ path: app, edits: [{ oldText: "unrelated" }, { oldText: "line 7 of the app\nline 8 of the app!" }] }, root);
	assert.match(hint, /lines 7–8 \(first difference at line 8\)/);
	const dup = join(root, "dup.ts");
	writeFileSync(dup, "import a;\nreturn x;\nfoo();\nreturn x;\n");
	assert.equal(editHint(`Found 2 occurrences of edits[0] in ${dup}. Each oldText must be unique. Please provide more context to make it unique.`,
		{ path: dup, edits: [{ oldText: "return x;" }] }, root), "It occurs at lines 2, 4. Include nearby lines to pick one.");
});
