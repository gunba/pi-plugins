import assert from 'node:assert/strict';
import test from 'node:test';
import extension, { buildInjection, patchSummaryPayload } from '../extensions/compaction-context.ts';

function harness() {
 const hooks = {}, commands = {};
 extension({ on: (name, fn) => hooks[name] = fn, registerCommand: (name, fn) => commands[name] = fn });
 const ctx = { getSystemPrompt: () => '', ui: { notify() {} } };
 hooks.before_agent_start({ systemPromptOptions: { contextFiles: [{path: 'AGENTS.md', content: 'Project rule'}] } }, ctx);
 return { hooks, commands, ctx };
}
test('ordinary requests do not inspect payload or rebuild context', () => {
 const { hooks, ctx } = harness();
 const payload = new Proxy({}, { get() { throw Error('payload scanned'); } });
 assert.equal(hooks.before_provider_request({payload}, ctx), undefined);
});
test('lifecycle gates summary injection and clears on failure, cancellation and normal context', () => {
 for (const end of ['session_compact', 'session_compact_failed', 'context', 'session_tree']) {
  const {hooks, ctx} = harness();
  const controller = new AbortController();
  hooks.session_before_compact({signal: controller.signal}, ctx);
  const payload = {instructions: 'Summary instructions', input: [{content: 'Keep unchanged'}]};
  const patched = hooks.before_provider_request({payload}, ctx);
  assert.match(patched.instructions, /Project rule/);
  assert.equal(patched.input, payload.input);
  assert.equal(payload.instructions, 'Summary instructions');
  hooks[end]();
  assert.equal(hooks.before_provider_request({payload}, ctx), undefined);
  hooks.session_before_compact({signal: controller.signal}, ctx);
  controller.abort();
  assert.equal(hooks.before_provider_request({payload}, ctx), undefined);
 }
});
test('summary requests that already carry active instructions do not repeat them', () => {
 const { hooks, ctx } = harness();
 hooks.session_before_compact({ signal: new AbortController().signal }, ctx);
 const native = { instructions: 'Full system prompt\nProject rule', input: [{ content: 'History' }] };
 assert.equal(hooks.before_provider_request({ payload: native }, ctx), native);
 const standalone = { instructions: 'Summarize', input: [{ content: 'Project rule' }] };
 assert.match(hooks.before_provider_request({ payload: standalone }, ctx).instructions, /pi_compaction_context/,
  'quoted conversation rules do not replace summary instructions');
 const injection = buildInjection({ customPrompt: 'Custom rule', appendSystemPrompt: 'Extra rule' });
 const context = { customPrompt: 'Custom rule', appendSystemPrompt: 'Extra rule' };
 const incomplete = { system: 'Custom rule' };
 assert.match(patchSummaryPayload(incomplete, injection, context).system, /Extra rule/);
 const complete = { system: [{ type: 'text', text: 'Custom rule\nExtra rule' }] };
 assert.equal(patchSummaryPayload(complete, injection, context), complete);
});
test('branch summaries, toggles and provider system fields', async () => {
 const {hooks, commands, ctx} = harness();
 const signal = new AbortController().signal;
 hooks.session_before_tree({signal, preparation: {userWantsSummary: false}}, ctx);
 assert.equal(hooks.before_provider_request({payload: {system: 'summary'}}, ctx), undefined);
 await commands['compaction-context'].handler('off', ctx);
 hooks.session_before_compact({signal}, ctx);
 assert.equal(hooks.before_provider_request({payload: {system: 'summary'}}, ctx), undefined);
 for (const payload of [{config: {systemInstruction: 'summary'}}, {system: [{type: 'text', text: 'summary'}]}, {messages: [{role: 'system', content: 'summary'}]}, {systemInstruction: {parts: [{text: 'summary'}]}}]) {
  const injection = buildInjection({customPrompt: 'Rule'});
  const patched = patchSummaryPayload(payload, injection);
  assert.match(JSON.stringify(patched), /Rule/);
  assert.deepEqual(patchSummaryPayload(patched, injection), patched);
 }
 assert.equal(patchSummaryPayload({tools: [{text: 'You are a context summarization assistant.'}]}, 'Rule'), undefined);
 assert.ok(buildInjection({customPrompt: 'x'.repeat(100_000)}).length < 33_000);
});
