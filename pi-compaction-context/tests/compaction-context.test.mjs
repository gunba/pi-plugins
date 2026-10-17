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

test('compaction is the next turn of the same conversation: the last payload is replayed with one summary request', async () => {
 const hooks = {};
 extension({ on: (name, fn) => hooks[name] = fn, registerCommand() {} });
 const branch = [
  { id: 'u1', type: 'message', message: { role: 'user', content: 'Build the importer' } },
  { id: 'a1', type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Done with step one' }], provider: 'anthropic', timestamp: Date.now(), usage: { cacheRead: 10, cacheWrite: 5 } } },
  { id: 'u2', type: 'message', message: { role: 'user', content: 'Now add tests for the parser' } },
 ];
 let replayed, options;
 const ctx = {
  model: { provider: 'anthropic', id: 'claude-opus-5', api: 'anthropic-messages', promptCache: { short: 300 } },
  sessionManager: { getSessionId: () => 's1', getLeafId: () => 'u2', getBranch: () => branch },
  modelRegistry: { complete: async (_model, _context, given) => { options = given; replayed = given.onPayload();
   return { stopReason: 'stop', content: [{ type: 'thinking', thinking: '…' }, { type: 'text', text: '## Goal\nImporter' }], usage: { input: 30, cacheRead: 9000 } }; } },
  getSystemPrompt: () => '', ui: { notify() {} },
 };
 const sent = { model: 'claude-opus-5', system: [{ type: 'text', text: 'Rules' }], tools: [{ name: 'read' }], messages: [{ role: 'user', content: [{ type: 'text', text: 'Build the importer' }] }], betas: ['x'] };
 hooks.context_with_system({ messages: [] }, ctx);
 assert.equal(hooks.before_provider_request({ payload: sent }, ctx), undefined, 'turn requests are recorded, not changed');
 const event = { reason: 'threshold', signal: new AbortController().signal, branchEntries: branch, customInstructions: undefined,
  preparation: { firstKeptEntryId: 'u2', tokensBefore: 120000, previousSummary: undefined, fileOps: { read: new Set(['a.ts', 'b.ts']), written: new Set(['b.ts']), edited: new Set() } } };
 const result = await hooks.session_before_compact(event, ctx);
 assert.deepEqual(replayed.messages.slice(0, -1), sent.messages);
 assert.deepEqual({ ...replayed, messages: undefined }, { ...sent, messages: undefined }, 'system, tools, betas and settings unchanged');
 assert.match(replayed.messages.at(-1).content[0].text, /user message beginning «Now add tests for the parser»/);
 assert.match(replayed.messages.at(-1).content[0].text, /Do not call any tools/);
 assert.equal(options.sessionId, 's1');
 assert.equal(result.compaction.summary, '## Goal\nImporter\n\n<read-files>\na.ts\n</read-files>\n\n<modified-files>\nb.ts\n</modified-files>');
 assert.equal(result.compaction.firstKeptEntryId, 'u2');
 assert.equal(result.compaction.usage.cacheRead, 9000);

 // A tool call instead of a summary, an overflow, a model switch or an expired cache leaves it to Pi's own summary.
 ctx.modelRegistry.complete = async () => ({ stopReason: 'toolUse', content: [{ type: 'toolCall', name: 'read' }] });
 assert.equal(await hooks.session_before_compact(event, ctx), undefined);
 assert.equal(await hooks.session_before_compact({ ...event, reason: 'overflow' }, ctx), undefined);
 assert.equal(await hooks.session_before_compact(event, { ...ctx, model: { ...ctx.model, id: 'claude-sonnet-5' } }), undefined);
 branch[1].message.timestamp = Date.now() - 600_000;
 assert.equal(await hooks.session_before_compact(event, ctx), undefined);
});
