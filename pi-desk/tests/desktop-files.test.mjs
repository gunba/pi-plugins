import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { desktopFileCommand } from "../src/host/desktop-files.ts";
import { LocalFiles } from "../src/host/local-files.ts";
import { workerCommandFrom } from "../src/host/commands.ts";

test("file clicks launch the referenced file or folder only after checking its current version", async () => {
	const home = mkdtempSync(join(tmpdir(), "desk-file-action-")), path = join(home, "Report & totals (2).xlsx"), launches = [];
	try {
		writeFileSync(path, "fixture");
		const files = new LocalFiles(async (...args) => { launches.push(args); });
		const reference = files.observe(path, home);
		assert.ok(reference);
		const info = await files.command({ kind: "file", id: reference.id, operation: "info" });
		for (const operation of ["open", "reveal"]) {
			const command = workerCommandFrom({ kind: "file", id: reference.id, operation, version: info.version, origin: { message: "fixture" } });
			assert.deepEqual(await files.command(command), { launched: true });
		}
		assert.deepEqual(launches, [[realpathSync(path), "open"], [realpathSync(path), "reveal"]]);
		writeFileSync(path, "changed fixture");
		await assert.rejects(files.command({ kind: "file", id: reference.id, operation: "open", version: info.version }), /File changed/);
		await assert.rejects(files.command({ kind: "file", id: "unregistered", operation: "open", version: info.version }), /no longer available/);
		assert.equal(launches.length, 2);
		writeFileSync(path, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0]));
		const executableInfo = await files.command({ kind: "file", id: reference.id, operation: "info" });
		await assert.rejects(files.command({ kind: "file", id: reference.id, operation: "open", version: executableInfo.version }), /executable/);
		assert.equal(launches.length, 2);
	} finally { rmSync(home, { recursive: true, force: true }); }
});

test("desktop launch arguments preserve literal paths and do not launch executable file types", () => {
	assert.deepEqual(desktopFileCommand("/tmp/Report & totals.xlsx", "open", "linux"), { command: "xdg-open", args: ["/tmp/Report & totals.xlsx"] });
	assert.deepEqual(desktopFileCommand("/tmp/Report & totals.xlsx", "reveal", "linux"), { command: "xdg-open", args: ["/tmp"] });
	const path = "C:\\Work & notes\\Report.xlsx";
	assert.deepEqual(desktopFileCommand(path, "open", "win32", "C:\\Windows"), { command: "C:\\Windows\\System32\\rundll32.exe", args: ["url.dll,FileProtocolHandler", "file:///C:/Work%20&%20notes/Report.xlsx"] });
	assert.deepEqual(desktopFileCommand(path, "reveal", "win32", "C:\\Windows"), { command: "C:\\Windows\\explorer.exe", args: ["/select,", path] });
	for (const file of ["payload.EXE", "shortcut.lnk", "script.ps1", "run.desktop"]) assert.throws(() => desktopFileCommand(file, "open", "win32"), /does not launch executable/);
	assert.throws(() => desktopFileCommand("script.js", "open", "win32"), /does not launch executable/);
});
