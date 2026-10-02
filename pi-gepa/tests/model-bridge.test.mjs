import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const bridge = resolve(root, "pi-gepa/skills/gepa-optimize/scripts/pi-model.mjs");

for (const explicitRoot of [false, true]) {
  test(`resolves native ESM-only SDK exports (${explicitRoot ? "explicit host root" : "package resolution"})`, () => {
    const env = { ...process.env };
    // The bridge is a standalone JSONL program, not a test-runner worker.
    delete env.NODE_TEST_CONTEXT;
    delete env.PI_GEPA_MODULE_ROOT;
    if (explicitRoot) env.PI_GEPA_MODULE_ROOT = root;
    const result = spawnSync(process.execPath, [bridge], {
      cwd: root, env, encoding: "utf8", timeout: 60_000,
      input: JSON.stringify({ id: 7, op: "check", model: { provider: "gepa-test-missing", id: "missing" } }) + "\n",
    });
    assert.equal(result.status, 0, JSON.stringify({
      error: result.error && { code: result.error.code, message: result.error.message },
      signal: result.signal, stderr: result.stderr,
    }));
    const response = JSON.parse(result.stdout);
    assert.equal(response.id, 7);
    assert.match(response.error, /Unknown native model/);
    assert.doesNotMatch(result.stderr, /ERR_PACKAGE_PATH_NOT_EXPORTED/);
  });
}
