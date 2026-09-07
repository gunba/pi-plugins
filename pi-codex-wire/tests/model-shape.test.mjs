import assert from 'node:assert/strict';
import test from 'node:test';
import { shapeModelBody, normalizeLiteEvent } from '../extensions/model-shape.ts';

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

test('explicit controls win, ultra maps max, unsupported summary/verbosity removed', () => {
  let result = shapeModelBody(body({ reasoning: { effort: 'ultra', summary: 'detailed', context: 'current_turn' }, text: { verbosity: 'low' } }), metadata());
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
  assert.deepEqual(result.input[0], { type: 'additional_tools', role: 'developer', tools: [{ type: 'namespace', name: 'functions', description: '', tools: [{ ...tool(), strict: false }] }] });
  assert.deepEqual(result.input[1], { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Pi system' }] });
  assert.equal(result.input[2].content[0].detail, undefined);
  assert.deepEqual(result.input[3], { ...input.input[1], namespace: 'functions' });
  assert.equal(result.input[4].output[0].detail, undefined);
  assert.equal(result.input[4].call_id, 'c');
  assert.equal(input.input[0].content[0].detail, 'high');
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
  assert.throws(() => shapeModelBody(body({ reasoning: { effort: 'guess' } }), metadata()), /Unsupported/);
  assert.throws(() => shapeModelBody(body({ tools: [tool(), tool()] }), metadata()), /Duplicate/);
  assert.throws(() => shapeModelBody(body({ tools: [{ type: 'web_search' }] }), metadata()), /Unsupported Pi tool/);
  assert.throws(() => shapeModelBody(body({ tools: [{ type: 'namespace', name: 'other', tools: [] }] }), metadata()), /Only the functions/);
  assert.throws(() => normalizeLiteEvent({ item: { type: 'function_call', name: 'bash', namespace: 'other' } }), /Cannot map/);
});
