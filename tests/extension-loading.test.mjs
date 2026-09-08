import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';

test('the host SDK loads every bundled extension and Codex Wire', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-plugins-loading-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = new URL('../', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
  const paths = [...manifest.pi.extensions, './pi-codex-wire/extensions/index.ts']
    .map(path => fileURLToPath(new URL(path, root)));
  const loader = new DefaultResourceLoader({
    cwd: directory, agentDir: directory, settingsManager: SettingsManager.inMemory(),
    additionalExtensionPaths: paths,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await loader.reload();
  const result = loader.getExtensions();
  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions.length, paths.length);
  assert.ok(result.extensions.some(extension => extension.commands.has('codex-wire')));
  assert.ok(result.extensions.some(extension => extension.tools.has('subagent')));
});
