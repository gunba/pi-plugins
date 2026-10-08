import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url);
const { toolInventory } = await jiti.import('../src/host/tool-inventory.ts');
const { toolAvailability } = await jiti.import('../src/client/tool-availability.ts');

test('tool inventory distinguishes registration, selection, exposure and default provenance', () => {
  const session = {
    getActiveToolNames: () => ['read'],
    getCallableToolNames: () => ['read', 'skill_refine'],
    agent: { state: { tools: [{ name: 'read' }] } },
    settingsManager: {
      getGlobalSettings: () => ({ defaultTools: ['+codemode', '+tool_search'] }),
      getProjectSettings: () => ({ defaultTools: ['-codemode'] }),
      getDefaultTools: () => ['read', 'bash', 'edit', 'write', 'tool_search'],
    },
    getAllTools: () => [
      { name: 'read', description: 'read', exposure: 'direct' },
      { name: 'codemode', description: 'scripts', exposure: 'model-only', sourceInfo: { path: 'builtin:codemode' } },
      { name: 'skill_refine', description: 'refine', exposure: 'codemode', sourceInfo: { path: '/plugins/refiner.ts' } },
    ],
    getToolDefinition: name => name === 'codemode' ? { defaultActive: false } : {},
  };
  const snapshot = toolInventory(session, { codemode: false });
  assert.deepEqual(snapshot.toolDefaults.computer, ['+codemode', '+tool_search']);
  assert.deepEqual(snapshot.toolDefaults.project, ['-codemode']);
  assert.deepEqual(snapshot.tools.map(toolAvailability), ['Shown to model', 'Not selected', 'Callable from tools']);
  assert.equal(snapshot.tools[1].source, 'builtin:codemode');
  assert.equal(snapshot.tools[1].defaultActive, false);
  assert.equal(snapshot.tools[1].conversationChoice, false);
  assert.equal(snapshot.tools[2].active, false);
  assert.equal(snapshot.tools[2].callable, true);
  assert.equal(toolAvailability({ active: false }), 'Not selected', 'old workers must not imply callable availability');
  assert.equal(toolAvailability({ active: true }), 'Selected');
  assert.equal(toolAvailability({ active: true, declared: false, callable: true }), 'Callable from tools', 'codemode-only may hide an active tool');
});
