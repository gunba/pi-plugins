import assert from 'node:assert/strict';
import test from 'node:test';
import extension, { HISTORY_NOTE } from '../extensions/compaction-context.ts';

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

 // When the first message that stays is the reply to the replayed request, the model is asked for everything it sees.
 await hooks.session_before_compact({ ...event, branchEntries: [...branch, { id: 'a2', type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Tests added' }] } }],
  preparation: { ...event.preparation, firstKeptEntryId: 'a2' } }, ctx);
 assert.match(replayed.messages.at(-1).content[0].text, /Summarize the whole conversation above/);
 assert.doesNotMatch(replayed.messages.at(-1).content[0].text, /Tests added/);

 // Pi's own summary request, which follows no turn, passes unchanged.
 assert.equal(hooks.before_provider_request({ payload: { system: 'You are a context summarization assistant.' } }, ctx), undefined);

 // A tool call instead of a summary, an overflow, a model switch or an expired cache leaves it to Pi's own summary.
 ctx.modelRegistry.complete = async () => ({ stopReason: 'toolUse', content: [{ type: 'toolCall', name: 'read' }] });
 assert.equal(await hooks.session_before_compact(event, ctx), undefined);
 assert.equal(await hooks.session_before_compact({ ...event, reason: 'overflow' }, ctx), undefined);
 assert.equal(await hooks.session_before_compact(event, { ...ctx, model: { ...ctx.model, id: 'claude-sonnet-5' } }), undefined);
 branch[1].message.timestamp = Date.now() - 600_000;
 assert.equal(await hooks.session_before_compact(event, ctx), undefined);
});

test('after a compaction the conversation is told its earlier history is searchable, once, when it can search', () => {
 // Summaries lose details the full history has; nothing told a compacted conversation it could still look them up.
 for (const tools of [['read', 'conversation_search'], ['read']]) {
  const hooks = {}, sent = [];
  extension({ on: (name, fn) => hooks[name] = fn, registerCommand() {}, getAllTools: () => tools.map(name => ({ name })),
   sendMessage: (message, options) => sent.push({ message, options }) });
  hooks.session_compact({ reason: 'threshold', fromExtension: true }, { sessionManager: { getSessionId: () => '01a11efb-961f-7166-8384-2911659fc2a9' } });
  if (!tools.includes('conversation_search')) { assert.deepEqual(sent, []); continue; }
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message.customType, HISTORY_NOTE);
  assert.equal(sent[0].message.display, false);
  assert.deepEqual(sent[0].options, { triggerTurn: false }, 'the note never wakes the conversation');
  assert.match(sent[0].message.content, /conversation_search with session "01a11efb-961f-7166-8384-2911659fc2a9"/);
 }
});
