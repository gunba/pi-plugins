import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChangeTracker, gitProcesses } from "../extensions/changes.ts";
import { workbook } from "./fixtures.mjs";

const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "init.defaultBranch=main", ...args], { cwd, stdio: "pipe" }).toString();
function repository(folder) {
	mkdirSync(folder, { recursive: true });
	git(folder, "init", "-q");
	writeFileSync(join(folder, "a.txt"), "one\ntwo\nthree\n");
	writeFileSync(join(folder, "b.txt"), "remove me\n");
	writeFileSync(join(folder, ".gitignore"), "build/\n");
	git(folder, "add", "-A"); git(folder, "commit", "-q", "-m", "start");
	return folder;
}
function setup(t, options) {
	const base = mkdtempSync(join(tmpdir(), "changes-"));
	// The temporary folder is scratch space in real use; here it holds the folders under test.
	const tracker = new ChangeTracker(join(base, "agent", "changes"), join(base, "agent"), [], options);
	// Watches are closed first: Windows cannot delete a folder that is being watched.
	t.after(() => { tracker.close(); rmSync(base, { recursive: true, force: true, maxRetries: 5 }); });
	return { base, tracker };
}
// A stuck git process fails its test by name instead of stalling the whole run.
const limit = { timeout: 60_000 };
/** Desk's store for a folder: its object bytes, its own objects only (not the repository's). */
function stored(base) {
	const store = join(base, "agent", "changes"), [folder] = readdirSync(store);
	const count = Object.fromEntries(execFileSync("git", ["--git-dir", join(store, folder), "count-objects", "-v"]).toString().trim().split("\n").map(line => line.split(": ")));
	const blobs = execFileSync("git", ["--git-dir", join(store, folder), "cat-file", "--batch-all-objects", "--batch-check=%(objecttype) %(objectsize)"])
		.toString().trim().split("\n").filter(line => line.startsWith("blob")).map(line => Number(line.split(" ")[1]));
	return { kilobytes: Number(count.size) + Number(count["size-pack"]), largestBlob: Math.max(0, ...blobs) };
}
const byPath = changes => Object.fromEntries((changes?.files ?? []).map(file => [file.path.split(/[\\/]/).pop(), file]));

test("changes a command makes by any means are reported as diffs, and the repository is left alone", limit, async t => {
	// Agents edit files with scripts and shell tools, not only the edit tool; those changes were invisible.
	const { base, tracker } = setup(t), repo = repository(join(base, "project"));
	const index = readFileSync(join(repo, ".git", "index"));
	await tracker.start("1", "python3 - <<'EOF'\n...\nEOF", repo, "s");
	writeFileSync(join(repo, "a.txt"), "one\nTWO\nthree\n");
	writeFileSync(join(repo, "c.txt"), "new file\n");
	unlinkSync(join(repo, "b.txt"));
	mkdirSync(join(repo, "build")); writeFileSync(join(repo, "build", "out.js"), "ignored\n");
	const files = byPath(await tracker.finish("1"));
	assert.deepEqual(Object.keys(files).sort(), ["a.txt", "b.txt", "c.txt"], "ignored build output is left out");
	assert.equal(files["a.txt"].action, "updated");
	assert.match(files["a.txt"].diff, /-\s*2 two/); assert.match(files["a.txt"].diff, /\+\s*2 TWO/);
	assert.equal(files["c.txt"].action, "added");
	assert.equal(files["b.txt"].action, "deleted");
	assert.ok(readFileSync(join(repo, ".git", "index")).equals(index), "the repository's index is untouched");
	assert.equal(git(repo, "status", "--porcelain").trim().split("\n").length, 3);

	// Changes made while no call was running are reported with the next call, marked as made meanwhile.
	writeFileSync(join(repo, "c.txt"), "new file\nchanged by a background process\n");
	// Calls are seconds apart while the model works; change notices take a moment to arrive.
	await new Promise(done => setTimeout(done, 200));
	await tracker.start("2", "ls", repo, "s");
	writeFileSync(join(repo, "a.txt"), "one\nTWO\nthree\nfour\n");
	const next = byPath(await tracker.finish("2"));
	assert.equal(next["c.txt"].meanwhile, true);
	assert.equal(next["a.txt"].meanwhile, undefined);
});

test("files a pull brings are counted, while a commit made in the same command keeps its diff", limit, async t => {
	const { base, tracker } = setup(t), upstream = repository(join(base, "upstream"));
	const clone = join(base, "clone");
	git(base, "clone", "-q", upstream, clone);
	writeFileSync(join(upstream, "a.txt"), "one\ntwo\nthree\nfrom upstream\n");
	git(upstream, "commit", "-q", "-am", "upstream change");
	await tracker.start("1", `cd ${clone} && git pull && edit && git commit`, base, "s");
	git(clone, "pull", "-q", "--no-rebase");
	writeFileSync(join(clone, "b.txt"), "remove me\nlocal edit\n");
	git(clone, "commit", "-q", "-am", "local change");
	const changes = await tracker.finish("1");
	assert.equal(changes.fromGit?.count, 1);
	assert.deepEqual(Object.keys(byPath(changes)), ["b.txt"]);
});

test("with change notices, a call that changes nothing starts no git process, and one that does is still seen", limit, async t => {
	// Starting git costs tens of milliseconds on Windows, so most calls must not need it.
	const { base, tracker } = setup(t, { watch: true }), repo = repository(join(base, "project"));
	await tracker.start("1", "ls", repo, "s");
	await tracker.finish("1");
	const launched = gitProcesses();
	await tracker.start("2", "ls", repo, "s");
	assert.equal(await tracker.finish("2"), undefined);
	assert.equal(gitProcesses() - launched, 0);
	await tracker.start("3", "python3 edit.py", repo, "s");
	writeFileSync(join(repo, "a.txt"), "one\ntwo\nthree\nfour\n");
	assert.match(byPath(await tracker.finish("3"))["a.txt"].diff, /\+\s*4 four/);
});

test("an Office file is kept as its content and a binary file as a fingerprint, and both changes are still reported", limit, async t => {
	// Desk once kept every saved version of a changed file whole.
	const { base, tracker } = setup(t), repo = repository(join(base, "project"));
	const sheet = (amount, formula) => workbook([{ name: "Totals", cells: `<c r="A1" t="s"><v>0</v></c><c r="B2"><v>${amount}</v></c><c r="B3"><f>${formula}</f><v>1</v></c>` }], ["Client"]);
	writeFileSync(join(repo, "Budget.xlsx"), sheet(1200, "B2*2"));
	writeFileSync(join(repo, "logo.png"), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), randomBytes(60_000)]));
	await tracker.start("1", "python3 update.py", repo, "s");
	writeFileSync(join(repo, "Budget.xlsx"), sheet(1350, "B2*3"));
	writeFileSync(join(repo, "logo.png"), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), randomBytes(60_000)]));
	const changes = await tracker.finish("1");
	const [budget] = changes.documents;
	assert.equal(budget.before.sheets[0].cells.get("B2").value, "1200");
	assert.equal(budget.after.sheets[0].cells.get("B2").value, "1350");
	assert.equal(budget.after.sheets[0].cells.get("B3").formula, "B2*3");
	assert.match(byPath(changes)["logo.png"].note, /^Binary file updated \(60,004 bytes\)/);
	assert.ok(stored(base).largestBlob < 2000, "neither file is stored whole");
});

test("only the newest version of each file is kept: superseded versions are collected", limit, async t => {
	const { base, tracker } = setup(t, { grace: "now" }), repo = repository(join(base, "project"));
	const data = () => randomBytes(150_000).toString("hex");
	writeFileSync(join(repo, "export.csv"), data());
	for (let call = 1; call <= 5; call++) {
		await tracker.start(String(call), "python3 export.py", repo, "s");
		writeFileSync(join(repo, "export.csv"), data());
		await tracker.finish(String(call));
	}
	await tracker.collect();
	// One version of 300 KB of hex is about 150 KB compressed; six would be 900 KB.
	assert.ok(stored(base).kilobytes < 250, `${stored(base).kilobytes} KB kept`);
	await tracker.start("6", "python3 export.py", repo, "s");
	writeFileSync(join(repo, "export.csv"), "short");
	const last = byPath(await tracker.finish("6"))["export.csv"];
	assert.deepEqual([last.added, last.removed], [1, 1], "the kept version still diffs");
});

test("a file a command names outside any followed folder is compared directly", limit, async t => {
	const { base, tracker } = setup(t), repo = repository(join(base, "project"));
	const outside = join(base, "settings", "app.desktop");
	mkdirSync(join(base, "settings")); writeFileSync(outside, "Exec=old\n");
	await tracker.start("1", `sed -i 's/old/new/' ${outside}`, repo, "s");
	writeFileSync(outside, "Exec=new\n");
	const files = byPath(await tracker.finish("1"));
	assert.match(files["app.desktop"].diff, /\+\s*1 Exec=new/);
});
