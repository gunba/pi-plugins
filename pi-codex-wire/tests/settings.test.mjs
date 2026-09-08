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

test('saved native user-agent survives reload and rejects multiline values', async t => {
  const { readUserAgent, saveUserAgent } = await import('../extensions/settings.ts');
  const directory = mkdtempSync(join(tmpdir(), 'wire-profile-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  assert.equal(readUserAgent(directory), undefined);
  const profile = 'codex_cli_rs/0.153.4 (Fedora 43.0.0; x86_64) ghostty/1.2.3';
  saveUserAgent(directory, profile);
  assert.equal(readUserAgent(directory), profile);
  assert.throws(() => saveUserAgent(directory, profile + '\nheader: value'));
  assert.equal(readUserAgent(directory), profile);
});
