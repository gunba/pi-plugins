import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';

// A helper recreates its parent's tools and fails to start without each one, so a helper's process must register
// the handbook tool too, though it keeps no handbook.
test('a helper has the handbook tool, for reading other agents\' handbooks only', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-handbook-child-'));
  const previous = process.env.PI_SUBAGENT_TASK_PATH;
  process.env.PI_SUBAGENT_TASK_PATH = join(directory, 'task.json');
  t.after(() => {
    if (previous === undefined) delete process.env.PI_SUBAGENT_TASK_PATH; else process.env.PI_SUBAGENT_TASK_PATH = previous;
    rmSync(directory, { recursive: true, force: true });
  });
  const loader = new DefaultResourceLoader({
    cwd: directory, agentDir: directory, settingsManager: SettingsManager.inMemory(),
    additionalExtensionPaths: [fileURLToPath(new URL('../extensions/handbook.ts', import.meta.url))],
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await loader.reload();
  const { errors, extensions } = loader.getExtensions();
  assert.deepEqual(errors, []);
  const tool = extensions[0].tools.get('handbook');
  assert.ok(tool);
  assert.equal(extensions[0].commands.has('handbook'), false);
  await assert.rejects(tool.definition.execute('call', { action: 'add', kind: 'learning', text: 'x' }, undefined),
    /A helper has no handbook of its own: only read with agent works here\./);
});
