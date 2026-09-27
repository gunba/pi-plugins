import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectionChecks } from "../src/host/doctor.ts";
import { readHostRecord } from "../src/host/host-control.ts";
import { inspectAppAssets } from "../src/host/app-assets.ts";
import { RELEASE } from "../src/shared/release.ts";

test("doctor reports a responding host's unavailable remote connection as an error", () => {
	for (const state of ["offline", "connecting"]) {
		const checks = connectionChecks({ state: "running", host: { release: RELEASE, relay: { state, origin: "https://example.invalid", appOrigin: "https://app.example" } } });
		assert.equal(checks.find(check => check.id === "relay").status, "error");
		assert.match(checks.find(check => check.id === "relay").message, /local access remains/);
	}
	assert.equal(connectionChecks({ state: "running", host: { release: RELEASE, relay: { state: "online", origin: "https://example.invalid", appOrigin: "https://app.example" } } }).some(check => check.status === "error"), false);
	assert.equal(connectionChecks({ state: "stopped" })[0].status, "warning");
});

test("malformed host records do not expose JSON excerpts in diagnostics", () => {
	const directory = mkdtempSync(join(tmpdir(), "desk-record-"));
	try {
		for (const text of ['PRIVATE_RECORD_SENTINEL: malformed', 'null']) {
			writeFileSync(join(directory, "host.json"), text);
			assert.throws(() => readHostRecord(directory), error => {
				assert.doesNotMatch(error.message, /PRIVATE_RE|Unexpected token|reading 'version'/);
				assert.match(error.message, /With the host stopped/); return true;
			});
		}
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

test("deployment checks reject absent shells and missing referenced app assets", () => {
	const directory = mkdtempSync(join(tmpdir(), "desk-assets-"));
	try {
		assert.throws(() => inspectAppAssets(directory), /index.html/);
		mkdirSync(join(directory, "assets"));
		for (const [file, value] of Object.entries({
			"index.html": '<link href="/assets/app.css"><script src="/assets/app.js"></script>',
			"assets/app.js": "export {};", "assets/app.css": "body{}", "sw.js": "// service worker",
			"manifest.webmanifest": '{"icons":[{"src":"/icon.svg"}]}', "icon.svg": "<svg/>",
		})) writeFileSync(join(directory, file), value);
		assert.equal(inspectAppAssets(directory).files, 6);
		rmSync(join(directory, "assets/app.js"));
		assert.throws(() => inspectAppAssets(directory), /app.js/);
	} finally { rmSync(directory, { recursive: true, force: true }); }
});
