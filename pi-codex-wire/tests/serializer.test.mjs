import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti/static';
import { fileURLToPath } from 'node:url';

test('serializer resolves package subpaths independently of Pi root aliases', async () => {
  const jiti = createJiti(import.meta.url, {
    moduleCache: false,
    alias: { '@earendil-works/pi-ai': '/missing-host-root/compat.js' },
  });
  const serializer = await jiti.import(fileURLToPath(new URL('../extensions/serializer.ts', import.meta.url)));
  assert.equal(typeof serializer.convertResponsesMessages, 'function');
  assert.equal(typeof serializer.createGrammarToolInputProperties, 'function');
  const model = { id: 'gpt-5.6-sol', api: 'openai-codex-responses', provider: 'openai-codex', input: ['text'] };
  const input = serializer.convertResponsesMessages(model, {
    messages: [{ role: 'user', content: 'Fixture', timestamp: 1 }],
  }, new Set(['openai-codex']), { includeSystemPrompt: false });
  assert.equal(input[0].content[0].text, 'Fixture');
});
