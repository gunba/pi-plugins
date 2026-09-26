import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti/static';
import { fileURLToPath } from 'node:url';
import { normalizeContext, responseReplay, convertResponsesMessages, createGrammarToolInputProperties, getDeclaredTools } from '../extensions/serializer.ts';
import { continuationReason } from '../extensions/transport.ts';

test('serializer resolves package subpaths independently of Pi root aliases', async () => {
  const jiti = createJiti(import.meta.url, {
    moduleCache: false,
    alias: { '@earendil-works/pi-ai': '/missing-host-root/compat.js' },
  });
  const serializer = await jiti.import(fileURLToPath(new URL('../extensions/serializer.ts', import.meta.url)));
  assert.equal(typeof serializer.convertResponsesMessages, 'function');
  assert.equal(typeof serializer.createGrammarToolInputProperties, 'function');
  const model = { id: 'gpt-5.6-sol', api: 'openai-codex-responses', provider: 'openai-codex', input: ['text'] };
  const input = serializer.convertResponsesMessages(model, serializer.normalizeContext({
    messages: [{ role: 'user', content: 'Fixture', timestamp: 1 }],
  }), new Set(['openai-codex']), { includeSystemPrompt: false });
  assert.equal(input[0].content[0].text, 'Fixture');
});

test('transcript grammar-tool additions preserve incremental response replay', () => {
  const tool = { name: 'apply_patch', description: 'Patch', parameters: {
    type: 'object', properties: { input: { type: 'string' } }, required: ['input'], additionalProperties: false,
  }, constrainedSampling: { type: 'grammar', variants: { openai_lark: 'start: "x"' } } };
  const model = { api: 'openai-codex-responses', provider: 'openai-codex', id: 'fixture', input: ['text'],
    compat: { supportsOpenAIGrammarTools: true } };
  const context = normalizeContext({ systemPrompt: 'Fixture', messages: [
    { role: 'user', content: 'Patch', timestamp: 1 },
    { role: 'system', content: '', toolsAdded: [tool], timestamp: 2 },
  ] });
  assert.equal(context.tools, undefined);
  const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
    content: [{ type: 'toolCall', id: 'call_fixture', name: tool.name, arguments: { input: 'x' } }],
    stopReason: 'toolUse', timestamp: 3 };
  const convert = transcript => convertResponsesMessages(model, transcript, new Set(['openai-codex']), {
    includeSystemPrompt: false,
    grammarToolInputProperties: createGrammarToolInputProperties(getDeclaredTools(transcript.messages), true),
  });
  const replay = responseReplay(model, context, message);
  assert.equal(replay[0].type, 'custom_tool_call');
  const previous = { responseId: 'response_fixture', body: { model: model.id, input: convert(context) },
    output: replay, expectedReplayOutput: replay };
  const next = normalizeContext({ messages: [...context.messages, message,
    { role: 'toolResult', toolCallId: 'call_fixture', toolName: tool.name, content: [{ type: 'text', text: 'Applied' }], isError: false, timestamp: 4 },
    { role: 'system', content: '', toolsRemoved: [{ name: tool.name }], timestamp: 5 },
  ] });
  assert.equal(convert(next).find(item => item.type === 'custom_tool_call_output').call_id, replay[0].call_id);
  assert.equal(continuationReason({ model: model.id, input: convert(next) }, previous), 'continuation');
});
