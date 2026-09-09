import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { savedClient, saveClient, readClient, readUserAgent, saveUserAgent } from "../extensions/settings.ts";

test("client selection persists and saved User-Agents are isolated by client", t => {
  const directory = mkdtempSync(join(tmpdir(), "wire-client-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  assert.equal(savedClient(directory), "cli");
  saveClient(directory, "desktop");
  assert.equal(savedClient(directory), "desktop");
  assert.throws(() => readClient("off"), /cli or desktop/);
  saveUserAgent(directory, "cli-profile");
  assert.equal(readUserAgent(directory, "desktop"), undefined);
  saveUserAgent(directory, "desktop-profile", "desktop");
  assert.equal(readUserAgent(directory), "cli-profile");
  assert.equal(readUserAgent(directory, "desktop"), "desktop-profile");
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
