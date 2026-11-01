import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ServiceUsage } from "../index.ts";
import { trackServiceModels } from "../models.ts";

// Ledgers close before their folder is removed: Windows cannot remove an open database.
function ledger(t) {
	const directory = mkdtempSync(join(tmpdir(), "pi-service-usage-")), opened = [];
	t.after(() => { for (const usage of opened) usage.close(); rmSync(directory, { recursive: true, force: true }); });
	return { directory, open: () => { const usage = new ServiceUsage(directory); opened.push(usage); return usage; } };
}

test("TypeSafe classifier calls are priced although Pi's catalog lists Jev at no cost", async t => {
	const usage = ledger(t).open();
	// As Pi does: the cost comes from the model's price table and the tokens the service reports.
	const runtime = {
		classify: async model => ({ stopReason: "stop", usage: { input: 2_000_000, cost: { total: 2 * model.cost.input + 0 * model.cost.output } } }),
		generateImages: async () => ({}),
	};
	const drain = trackServiceModels(runtime, usage, () => {});
	const jev = { provider: "typesafe", id: "jev-latest", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
	await runtime.classify(jev, {}, {});
	await drain();
	const [total] = usage.snapshot().totals;
	assert.equal(total.service, "typesafe");
	assert.equal(total.calls, 1);
	assert.equal(total.unknown, 0);
	assert.ok(Math.abs(total.cost - 0.084) < 1e-12, `cost ${total.cost}`);
});

test("TypeSafe calls recorded at $0 before they were priced count as unpriced", t => {
	const { directory, open } = ledger(t);
	const old = new DatabaseSync(join(directory, "service-usage.sqlite"));
	old.exec(`CREATE TABLE usage (day INTEGER NOT NULL, service TEXT NOT NULL, operation TEXT NOT NULL, firstAt INTEGER NOT NULL,
		calls INTEGER NOT NULL, cost REAL NOT NULL, estimated INTEGER NOT NULL, unknown INTEGER NOT NULL, seconds REAL NOT NULL,
		PRIMARY KEY(day,service,operation));
		INSERT INTO usage VALUES (1,'typesafe','classify',1,40,0,40,0,0), (1,'exa','search',1,3,0.021,3,0,0);`);
	old.close();
	const usage = open();
	const totals = Object.fromEntries(usage.snapshot().totals.map(total => [total.service, total]));
	assert.deepEqual([totals.typesafe.calls, totals.typesafe.unknown, totals.typesafe.estimated], [40, 40, 0]);
	assert.deepEqual([totals.exa.unknown, totals.exa.estimated], [0, 3]);
	usage.record({ service: "typesafe", operation: "classify", cost: 0.001, estimated: true });
	usage.close();
	const reopened = open();
	const typesafe = reopened.snapshot().totals.find(total => total.service === "typesafe");
	assert.deepEqual([typesafe.calls, typesafe.unknown], [41, 40], "a priced call is not marked unpriced on the next open");
});
