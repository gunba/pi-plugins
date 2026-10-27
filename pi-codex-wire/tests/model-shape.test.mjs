import assert from 'node:assert/strict';
import test from 'node:test';
import { convertResponsesMessages } from '@earendil-works/pi-ai/api/openai-responses-shared';
import { shapeModelBody as shape, normalizeLiteEvent, responseNormalizer } from '../extensions/model-shape.ts';
const shapeModelBody = (body, metadata, threadId = 'test-thread') => shape(body, metadata, threadId);

const metadata = (extra = {}) => ({ slug: 'test', default_reasoning_level: 'medium', supports_reasoning_summary_parameter: true, support_verbosity: true, default_verbosity: 'medium', service_tiers: [{ id: 'default', is_default: true }, { id: 'priority' }], ...extra });
const tool = (name = 'bash') => ({ type: 'function', name, description: 'Run', parameters: { type: 'object', properties: {} }, strict: null });
const body = (extra = {}) => ({ model: 'test', instructions: 'Pi system', input: [], tools: [tool()], parallel_tool_calls: true, ...extra });

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

for (const lite of [false, true]) test(`replayed tool item IDs match their wire type (Lite=${lite})`, () => {
  const input = [
    { type: 'custom_tool_call', id: 'fc_legacy', call_id: 'call_1', name: 'apply_patch', input: 'patch' },
    { type: 'custom_tool_call_output', call_id: 'call_1', output: 'done' },
    { type: 'custom_tool_call', id: 'ctc_original', call_id: 'call_2', name: 'apply_patch', input: 'patch' },
    { type: 'function_call', id: 'ctc_old', call_id: 'call_3', name: 'read', arguments: '{}' },
    { type: 'function_call', id: 'fc_original', call_id: 'call_4', name: 'read', arguments: '{}' },
    { type: 'reasoning', id: 'rs_original', encrypted_content: 'opaque' },
  ];
  const original = freeze(body({ input }));
  const result = shapeModelBody(original, metadata({ use_responses_lite: lite })).input;
  const calls = result.filter(item => item.call_id);
  assert.equal('id' in calls[0], false);
  assert.equal(calls[0].call_id, calls[1].call_id);
  assert.equal(calls[2].id, 'ctc_original');
  assert.equal('id' in calls[3], false);
  assert.equal(calls[4].id, 'fc_original');
  assert.equal(result.find(item => item.type === 'reasoning').id, 'rs_original');
  assert.equal(original.input[0].id, 'fc_legacy');
});

test('real Pi serializer replays saved apply_patch calls with valid custom IDs and paired results', () => {
  const model = { id: 'test', provider: 'openai-codex', api: 'openai-codex-responses', reasoning: true, input: ['text'] };
  for (const id of ['call_saved|fc_original', 'call_saved|ctc_original']) {
    const messages = JSON.parse(JSON.stringify([
      { role: 'assistant', provider: model.provider, api: model.api, model: model.id, timestamp: 1,
        stopReason: 'toolUse', content: [{ type: 'toolCall', id, name: 'apply_patch', arguments: { input: 'patch' } }] },
      { role: 'toolResult', toolCallId: id, toolName: 'apply_patch', timestamp: 2,
        content: [{ type: 'text', text: 'done' }], isError: false },
    ]));
    const serialized = convertResponsesMessages(model, { messages }, new Set(['openai-codex']),
      { grammarToolInputProperties: new Map([['apply_patch', 'input']]), includeSystemPrompt: false });
    const result = shapeModelBody(body({ input: serialized }), metadata({ use_responses_lite: true })).input;
    const call = result.find(item => item.type === 'custom_tool_call');
    assert.ok(call);
    assert.ok(call.id === undefined || call.id.startsWith('ctc_'));
    assert.equal(call.input, 'patch');
    assert.equal(result.find(item => item.type === 'custom_tool_call_output').call_id, call.call_id);
    assert.equal(messages[0].content[0].id, id);
  }
});

test('response IDs survive added/done pairs, interleaving, and a new response', () => {
  const normalize = responseNormalizer(false);
  const added = (index, item) => normalize(freeze({ type: 'response.output_item.added', output_index: index, item })).item;
  const done = (index, item) => normalize(freeze({ type: 'response.output_item.done', output_index: index, item })).item;
  const message = added(0, { type: 'message', id: '' });
  const call = added(1, { type: 'custom_tool_call', id: null, call_id: 'call_custom' });
  assert.match(message.id, /^msg_[0-9a-f-]{14}7[0-9a-f-]{21}$/);
  assert.match(call.id, /^ctc_[0-9a-f-]{14}7[0-9a-f-]{21}$/);
  assert.equal(done(0, { type: 'message' }).id, message.id);
  assert.equal(done(1, { type: 'custom_tool_call', call_id: 'call_custom' }).id, call.id);
  assert.equal(added(2, { type: 'function_call', id: 'fc_server' }).id, 'fc_server');
  assert.equal(done(2, { type: 'function_call' }).id, 'fc_server');
  assert.equal(done(3, { type: 'message', id: 'msg_server' }).id, 'msg_server');
  assert.match(done(4, { type: 'reasoning' }).id, /^rs_[0-9a-f-]{14}7[0-9a-f-]{21}$/);
  assert.deepEqual(done(5, { type: 'future_item' }), { type: 'future_item' });
  const delta = { type: 'response.output_text.delta', output_index: 0, delta: 'parity' };
  assert.equal(normalize(delta), delta);
  normalize({ type: 'response.created', response: { id: 'new_response' } });
  assert.notEqual(added(0, { type: 'message' }).id, message.id);
});

test('response ID normalization preserves Lite namespace checks and raw completion snapshots', () => {
  const normalize = responseNormalizer(true);
  const event = freeze({ type: 'response.output_item.added', output_index: 0,
    item: { type: 'function_call', namespace: 'functions', call_id: 'call_1' } });
  const item = normalize(event).item;
  assert.equal(item.namespace, undefined);
  assert.equal(item.call_id, 'call_1');
  assert.match(item.id, /^fc_/);
  assert.equal(event.item.id, undefined);
  assert.throws(() => normalize({ ...event, item: { ...event.item, namespace: 'other' } }), /non-functions/);
  assert.deepEqual(normalize({ type: 'response.completed', response: { output: [event.item] } }), {
    type: 'response.completed', response: { output: [{ type: 'function_call', call_id: 'call_1' }] },
  });
});

test('native defaults, encrypted reasoning include, strict false, no mutation', () => {
  const input = freeze(body({ temperature: 0.7 }));
  const model = freeze(metadata());
  const result = shapeModelBody(input, model);
  assert.deepEqual(result.reasoning, { effort: 'medium', summary: 'auto' });
  assert.deepEqual(result.text, { verbosity: 'medium' });
  assert.deepEqual(result.include, ['reasoning.encrypted_content']);
  assert.equal(result.tools[0].strict, false);
  assert.equal(input.tools[0].strict, null);
  assert.equal('temperature' in result, false);
  assert.notEqual(result.input, input.input);
});

test('explicit controls win, ultra uses supported max, unsupported summary/verbosity removed', () => {
  let result = shapeModelBody(body({ reasoning: { effort: 'ultra', summary: 'detailed', context: 'current_turn' }, text: { verbosity: 'low' } }), metadata({ supported_reasoning_levels: [{ effort: 'max' }] }));
  assert.deepEqual(result.reasoning, { effort: 'max', summary: 'detailed' });
  assert.deepEqual(result.text, { verbosity: 'low' });
  result = shapeModelBody(body({ reasoning: { summary: 'none' }, text: { verbosity: 'low', format: { type: 'json_schema', schema: {} } } }), metadata({ supports_reasoning_summary_parameter: false, support_verbosity: false }));
  assert.deepEqual(result.reasoning, { effort: 'medium' });
  assert.deepEqual(result.text, { format: { type: 'json_schema', schema: {} } });
  result = shapeModelBody(body(), metadata({ support_verbosity: false, supports_reasoning_summary_parameter: false, default_reasoning_level: null }));
  assert.deepEqual(result.reasoning, {});
  assert.equal('text' in result, false);
});

test('tier uses only explicit supported id, never catalog default', () => {
  for (const tier of [undefined, null, 'default', 'fast', 'flex']) {
    assert.equal('service_tier' in shapeModelBody(body({ service_tier: tier }), metadata()), false);
  }
  assert.equal(shapeModelBody(body({ service_tier: 'priority' }), metadata()).service_tier, 'priority');
  assert.equal('service_tier' in shapeModelBody(body(), metadata({ service_tiers: [{ id: 'priority', is_default: true }] })), false);
});

test('native effort mappings follow Ultra selection and persistent wire naming', () => {
  const shape = (effort, extra = {}) => shapeModelBody(body({ reasoning: { effort } }), metadata(extra)).reasoning.effort;
  const supported_reasoning_levels = [{ effort: 'medium' }, { effort: 'high' }, { effort: 'ultra' }];
  assert.equal(shape('ultra', { supported_reasoning_levels }), 'high');
  assert.equal(shape('ultra', { supported_reasoning_levels, multi_agent_reasoning_effort: 'medium' }), 'medium');
  assert.equal(shape('ultra', { supported_reasoning_levels, multi_agent_reasoning_effort: 'ultra' }), 'high');
  assert.equal(shape('ultra', { supported_reasoning_levels, multi_agent_reasoning_effort: 'not-supported' }), 'high');
  assert.equal(shape('ultra'), 'medium');
  assert.equal(shape('persistent'), 'disabled');
  assert.equal(shape('future-model-effort'), 'future-model-effort');
});

test('native parallel calls follow the prompt and Lite mode rather than removed catalog field', () => {
  assert.equal(shapeModelBody(body(), metadata({ supports_parallel_tool_calls: false })).parallel_tool_calls, true);
  assert.equal(shapeModelBody(body({ parallel_tool_calls: false }), metadata()).parallel_tool_calls, false);
  assert.equal(shapeModelBody(body(), metadata({ use_responses_lite: true })).parallel_tool_calls, false);
});

test('native Lite prefix IDs hash visible payloads within the thread and survive resume', () => {
  const m = metadata({ use_responses_lite: true });
  const result = shapeModelBody(body(), m);
  // Independently calculated with Python uuid.uuid5 and insertion-ordered compact JSON.
  assert.equal(result.input[0].id, 'at_356c3f46-84d2-56e1-a2a7-37febec73153');
  assert.equal(result.input[1].id, 'msg_7f21a37e-a281-5127-98df-0a8cbb5f585c');
  const reorderedTool = Object.fromEntries(Object.entries(tool()).reverse());
  // Tools are written in the native field order whatever order Pi gives them in.
  assert.equal(shapeModelBody(body({ tools: [reorderedTool] }), m).input[0].id, result.input[0].id);
  assert.equal(shapeModelBody(body(), m).input[0].id, result.input[0].id);
  assert.equal(shapeModelBody(body(), m).input[1].id, result.input[1].id);
  assert.notEqual(shapeModelBody(body(), m, 'other-thread').input[0].id, result.input[0].id);
  assert.notEqual(shapeModelBody(body({ instructions: 'changed' }), m).input[1].id, result.input[1].id);
  assert.notEqual(shapeModelBody(body({ tools: [tool('read')] }), m).input[0].id, result.input[0].id);
});

test('native image detail normalizes messages and tool results without changing stored history', () => {
  const image = { type: 'input_image', image_url: 'data:image/png;base64,eA==', detail: 'original' };
  const input = freeze(body({ input: [
    { role: 'user', content: [image] },
    { type: 'function_call_output', call_id: 'f', output: [image] },
    { type: 'custom_tool_call_output', call_id: 'c', output: [image] },
  ] }));
  for (const lite of [false, true]) {
    for (const supported of [false, true]) {
      const result = shapeModelBody(input, metadata({
        use_responses_lite: lite, supports_image_detail_original: supported,
      }));
      const items = result.input.filter(item => item.role === 'user' || item.call_id);
      const expected = lite ? undefined : supported ? 'original' : 'high';
      assert.deepEqual(items.map(item => (item.content ?? item.output)[0].detail), [expected, expected, expected]);
      assert.equal(input.input[0].content[0].detail, 'original');
    }
  }
});

test('lite moves tools and instructions to input and retains native reasoning/include', () => {
  const input = freeze(body({
    input: [
      { role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,eA==', detail: 'high' }] },
      { type: 'function_call', name: 'bash', arguments: '{}', call_id: 'c' },
      { type: 'function_call_output', call_id: 'c', output: [{ type: 'input_image', image_url: 'x', detail: 'original' }, { type: 'input_text', text: 'result' }] },
    ],
  }));
  const result = shapeModelBody(input, metadata({ use_responses_lite: true }));
  assert.equal('instructions' in result, false);
  assert.equal('tools' in result, false);
  assert.equal(result.parallel_tool_calls, false);
  assert.deepEqual(result.include, ['reasoning.encrypted_content']);
  assert.deepEqual(result.reasoning, { effort: 'medium', summary: 'auto', context: 'all_turns' });
  assert.deepEqual(result.input[0], { type: 'additional_tools', id: result.input[0].id, role: 'developer', tools: [{ type: 'namespace', name: 'functions', description: '', tools: [{ ...tool(), strict: false }] }] });
  assert.deepEqual(result.input[1], { type: 'message', id: result.input[1].id, role: 'developer', content: [{ type: 'input_text', text: 'Pi system' }],
    internal_chat_message_metadata_passthrough: { content_item_kinds: ['model.base_instructions'], content_item_metadata: [{ provenance: { type: 'harness', hook: false } }] } });
  assert.equal(result.input[2].content[0].detail, undefined);
  assert.deepEqual(result.input[3], { ...input.input[1], namespace: 'functions' });
  assert.equal(result.input[4].output[0].detail, undefined);
  assert.equal(result.input[4].call_id, 'c');
  assert.equal(input.input[0].content[0].detail, 'high');
});

test('Codex 0.164 shape: instructions are a developer message for every model, and Pi\'s head tool item is the tool set', () => {
  // Pi 1.4 declares the tools in an additional_tools item at the head of the input, and later ones as it loads tools.
  const later = { type: 'additional_tools', role: 'developer', tools: [tool('grep')] };
  const input = [{ type: 'additional_tools', role: 'developer', tools: [tool()] }, { role: 'user', content: 'hi' }, later];
  const standard = shapeModelBody(body({ tools: [], input }), metadata());
  assert.equal('instructions' in standard, false);
  assert.deepEqual(standard.tools, [{ type: 'function', name: 'bash', description: 'Run', strict: false, parameters: { type: 'object', properties: {} } }]);
  assert.deepEqual(Object.keys(standard.tools[0]), ['type', 'name', 'description', 'strict', 'parameters']);
  assert.deepEqual(standard.input[0], { type: 'message', id: 'msg_7f21a37e-a281-5127-98df-0a8cbb5f585c', role: 'developer',
    content: [{ type: 'input_text', text: 'Pi system' }], internal_chat_message_metadata_passthrough: { content_item_kinds: ['model.base_instructions'] } });
  assert.deepEqual(standard.input.slice(1), [input[1], later]);
  const lite = shapeModelBody(body({ tools: [], input }), metadata({ use_responses_lite: true }));
  assert.deepEqual(lite.input.map(item => item.type ?? item.role), ['additional_tools', 'message', 'user', 'additional_tools']);
  assert.equal(lite.input[0].id, 'at_356c3f46-84d2-56e1-a2a7-37febec73153', 'the same tool prefix as tools given at the top level');
  assert.match(lite.input[3].id, /^at_/);
  assert.equal(lite.input[3].tools[0].tools[0].name, 'grep');
  // No tools and no instructions: no prefix at all.
  assert.deepEqual(shapeModelBody(body({ tools: [], instructions: '', input: [input[1]] }), metadata({ use_responses_lite: true })).input, [input[1]]);
});

test('lite merges functions namespace, keeps custom names and output strings unchanged', () => {
  const custom = { type: 'custom', name: 'edit', description: '', format: { type: 'grammar', syntax: 'lark', definition: 'start: /.+/' } };
  const result = shapeModelBody(body({ instructions: '', tools: [tool(), { type: 'namespace', name: 'functions', description: 'Pi tools', tools: [custom] }], input: [{ type: 'custom_tool_call', name: 'edit', input: 'patch', call_id: 'a' }, { type: 'custom_tool_call_output', call_id: 'a', output: 'unchanged' }] }), metadata({ use_responses_lite: true }));
  assert.equal(result.input[0].tools.length, 1);
  assert.equal(result.input[0].tools[0].description, 'Pi tools');
  assert.equal(result.input[0].tools[0].tools[1].name, 'edit');
  assert.equal(result.input[1].name, 'edit');
  assert.equal(result.input[1].namespace, 'functions');
  assert.equal(result.input[2].output, 'unchanged');
});

test('lite event normalization preserves Pi names and continuation IDs without mutation', () => {
  const item = { type: 'function_call', namespace: 'functions', name: 'bash', id: 'fc_1', call_id: 'c', arguments: '{}' };
  const event = freeze({ type: 'response.output_item.done', item, response: { output: [item] } });
  const result = normalizeLiteEvent(event);
  assert.equal(result.item.namespace, undefined);
  assert.equal(result.item.name, 'bash');
  assert.equal(result.item.call_id, 'c');
  assert.equal(result.response.output[0].namespace, undefined);
  assert.equal(item.namespace, 'functions');
});

test('reject mismatched catalog, invalid controls, ambiguous or unmappable tools', () => {
  assert.throws(() => shapeModelBody(body(), {}), /exactly match/);
  assert.throws(() => shapeModelBody(body(), metadata({ slug: 'other' })), /exactly match/);
  assert.throws(() => shapeModelBody(body(), metadata({ use_responses_lite: 'true' })), /boolean/);
  assert.throws(() => shapeModelBody(body({ reasoning: { effort: '' } }), metadata()), /non-empty string/);
  assert.throws(() => shapeModelBody(body({ tools: [tool(), tool()] }), metadata()), /Duplicate/);
  assert.throws(() => shapeModelBody(body({ tools: [{ type: 'web_search' }] }), metadata()), /Unsupported Pi tool/);
  assert.throws(() => shapeModelBody(body({ tools: [{ type: 'namespace', name: 'other', tools: [] }] }), metadata()), /Only the functions/);
  assert.throws(() => normalizeLiteEvent({ item: { type: 'function_call', name: 'bash', namespace: 'other' } }), /Cannot map/);
});
