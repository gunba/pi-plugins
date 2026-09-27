import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// --ignore-scripts left keytar unbuilt and made account sign-in fail on import.
test("protected-cache native dependency loads", async () => {
	await import("@azure/msal-node-extensions");
});

test("Windows protected cache survives reopening without storing plaintext", {
	skip: process.platform !== "win32",
}, async () => {
	const { PersistenceCreator, DataProtectionScope } = await import("@azure/msal-node-extensions");
	const directory = await mkdtemp(join(tmpdir(), "pi-desk-cache-"));
	const options = {
		cachePath: join(directory, "cache"), dataProtectionScope: DataProtectionScope.CurrentUser,
		serviceName: "Pi Desk test", accountName: randomUUID(), usePlaintextFileOnLinux: false,
		loggerOptions: { piiLoggingEnabled: false, loggerCallback: () => {} },
	};
	try {
		const value = randomUUID() + randomUUID();
		const first = await PersistenceCreator.createPersistence(options);
		await first.save(value);
		assert.equal((await readFile(options.cachePath)).includes(Buffer.from(value)), false);
		const second = await PersistenceCreator.createPersistence(options);
		assert.equal(await second.load(), value);
		await second.delete();
		await assert.rejects(readFile(options.cachePath), { code: "ENOENT" });
	} finally { await rm(directory, { recursive: true, force: true }); }
});
