import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const bridge = resolve(root, "pi-gepa/skills/gepa-optimize/scripts/pi-model.mjs");

test("uses the host SDK's nested AI package without extension peers", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pi-gepa-host-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, "source"), host = join(directory, "host");
  const sdk = join(host, "node_modules/@earendil-works/pi-coding-agent");
  const ai = join(sdk, "node_modules/@earendil-works/pi-ai");
  for (const path of [join(source, "node_modules"), join(sdk, "dist"), join(ai, "dist")]) mkdirSync(path, { recursive: true });
  symlinkSync(join(root, "node_modules/jiti"), join(source, "node_modules/jiti"), "junction");
  const entry = join(source, "pi-model.mjs");
  copyFileSync(bridge, entry);
  for (const [path, name] of [[sdk, "pi-coding-agent"], [ai, "pi-ai"]]) {
    writeFileSync(join(path, "package.json"), JSON.stringify({ name: `@earendil-works/${name}`, type: "module", exports: { ".": { import: "./dist/index.js" } } }));
  }
  writeFileSync(join(ai, "dist/index.js"), "export class InMemoryModelsStore { marker = 'host-ai'; }");
  writeFileSync(join(sdk, "dist/index.js"), `
    export const readStoredCredential = async () => undefined;
    export class ModelRuntime {
      static async create(options) {
        if (options.modelsStore.marker !== 'host-ai') throw Error('Wrong AI instance');
        return { getAvailable: async () => [{ provider: 'host', id: 'fixture' }] };
      }
    }
  `);
  const env = { ...process.env, PI_GEPA_MODULE_ROOT: host };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [entry], {
    env, encoding: "utf8", timeout: 30_000,
    input: JSON.stringify({ id: 9, op: "list" }) + "\n",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { id: 9, result: [{ provider: "host", model: "fixture" }] });
});

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
