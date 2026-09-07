import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readDefaultMode, readMode, saveDefaultMode } from "../extensions/settings.ts";

test("saved defaults roundtrip, remain opt-in and reject invalid values without overwriting", t => {
  const root = mkdtempSync(join(tmpdir(), "pi-wire-settings-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "codex-wire");
  assert.equal(readDefaultMode(directory), "off");
  for (const mode of ["codex", "stock", "pi", "off"]) {
    saveDefaultMode(directory, mode);
    assert.equal(readDefaultMode(directory), mode);
    assert.deepEqual(readdirSync(directory), ["default-mode"]);
  }
  assert.throws(() => saveDefaultMode(directory, "invalid"), /must be/);
  assert.equal(readDefaultMode(directory), "off");
  assert.throws(() => readMode({ toString: () => "codex" }), /must be/);
  writeFileSync(join(directory, "default-mode"), "broken");
  assert.throws(() => readDefaultMode(directory), /must be/);
});
