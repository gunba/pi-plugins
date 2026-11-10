import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import extension, { CONTINUE, HISTORY_NOTE } from '../extensions/compaction-context.ts';
import { OMITTED_RESULT, extractSummary } from '../extensions/summary.ts';
import { PLAN_READ } from '../../pi-plan/extensions/plan.ts';
import { WATCH_ENTRY } from '../../pi-watch/index.ts';
import { compactionFailure } from '../../pi-context-window/compaction-state.ts';

const usage = { input: 30, output: 900, cacheRead: 9000, cacheWrite: 0, totalTokens: 9930, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } };
const reply = text => ({ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text }], usage });
const message = (id, message) => ({ id, type: 'message', message: { timestamp: Date.now(), ...message } });
const call = (id, name, args) => ({ type: 'toolCall', id, name, arguments: args });
const result = (id, text, nested = []) => ({ role: 'toolResult', toolCallId: id, toolName: 'codemode', content: [{ type: 'text', text }], isError: false,
 ...(nested.length ? { nestedCalls: { calls: nested.map(([name, path]) => ({ name, arguments: { path } })) } } : {}) });

function harness({ tools = ['codemode', 'conversation_search'], plan } = {}) {
 const hooks = {}, sent = [];
 extension({ on: (name, fn) => hooks[name] = fn, registerCommand() {}, getAllTools: () => tools.map(name => ({ name, description: name, parameters: { type: 'object' } })),
  getActiveTools: () => tools, getThinkingLevel: () => 'high', sendMessage: (message, options) => sent.push({ message, options }),
  events: { on() {}, emit: (name, probe) => { if (name === PLAN_READ) probe.plan = plan ?? null; } } });
 return { hooks, sent };
}

function context(branch, answer, cwd) {
 const requests = [];
 const ctx = {
  cwd, model: { provider: 'anthropic', id: 'claude-opus-5-5', api: 'anthropic-messages', contextWindow: 500_000, promptCache: { short: 300 } },
  sessionManager: { getSessionId: () => 's1', getLeafId: () => branch.at(-1).id, getBranch: () => branch },
  modelRegistry: { streamSimple: (model, context, options) => ({ result: async () => {
   const request = { model, context, options };
   if (options.onPayload) request.payload = await options.onPayload({ system: [], messages: [{ role: 'assistant', content: [{ type: 'text', text: 'converted suffix' }] }] });
   requests.push(request);
   return answer;
  } }) },
  getSystemPrompt: () => 'Conversation rules', ui: { notify: (text, kind) => requests.push({ notify: text, kind }) },
 };
 return { ctx, requests };
}

/** Session entries in order, each the child of the one before, as Pi's projection walks them. */
const chain = entries => entries.map((entry, index) => ({ ...entry, parentId: entries[index - 1]?.id ?? null, timestamp: new Date().toISOString() }));

const event = (branch, extra = {}) => ({ reason: 'threshold', signal: new AbortController().signal, branchEntries: branch, customInstructions: undefined,
 preparation: { firstKeptEntryId: 'u2', tokensBefore: 434_000, settings: { reserveTokens: 65_536, keepRecentTokens: 20_000 },
  fileOps: { read: new Set(['old.ts']), written: new Set(), edited: new Set() } }, ...extra });

test('compaction is a Claude Code summary of the whole conversation, written from its cached request, with its working state put back', async t => {
 const cwd = mkdtempSync(join(tmpdir(), 'pi-compaction-'));
 t.after(() => rmSync(cwd, { recursive: true, force: true }));
 mkdirSync(join(cwd, 'src')); mkdirSync(join(cwd, 'skills', 'parsers'), { recursive: true });
 writeFileSync(join(cwd, 'src', 'a.ts'), 'export const a = 1;\n');
 writeFileSync(join(cwd, 'src', 'b.ts'), 'const fence = "```";\n');
 writeFileSync(join(cwd, 'skills', 'parsers', 'SKILL.md'), '# Parsers\nWrite parsers by hand.\n');
 const branch = chain([
  message('u1', { role: 'user', content: 'Build the importer' }),
  message('a1', { role: 'assistant', content: [call('t1', 'codemode', { code: '…' })], provider: 'anthropic', usage, stopReason: 'toolUse' }),
  message('r1', result('t1', 'ok', [['read', 'skills/parsers/SKILL.md'], ['read', 'src/a.ts'], ['edit', 'src/b.ts']])),
  { id: 'w', type: 'custom', customType: WATCH_ENTRY, data: { op: 'start', watch: { id: 'w3', mode: 'output', command: 'npm test', wakeWhen: 'it finishes' } } },
  message('a2', { role: 'assistant', content: [{ type: 'text', text: 'Done with step one' }], provider: 'anthropic', usage, stopReason: 'stop' }),
  message('u2', { role: 'user', content: 'Now add tests for the parser' }),
  message('a3', { role: 'assistant', content: [call('t2', 'codemode', { code: '…' })], provider: 'anthropic', usage, stopReason: 'toolUse' }),
  message('r3', result('t2', 'ok', [['read', 'src/c.ts']])),
 ]);
 const plan = { phase: 'active', objective: 'Ship the importer', steps: [{ content: 'Write parser tests', status: 'in_progress' }], autoContinue: false };
 const { hooks, sent } = harness({ plan });
 const { ctx, requests } = context(branch, reply('<analysis>Thinking it over</analysis>\n\n<summary>\n1. Primary Request and Intent:\n   Build the importer\n</summary>'), cwd);
 const last = { model: 'claude-opus-5-5', system: [{ type: 'text', text: 'Rules' }], tools: [{ name: 'codemode' }], thinking: { type: 'adaptive' },
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Now add tests for the parser', cache_control: { type: 'ephemeral' } }] }] };
 ctx.sessionManager.getLeafId = () => 'u2';
 hooks.context_with_system({ messages: [] }, ctx);
 assert.equal(hooks.before_provider_request({ payload: last }, ctx), undefined, 'turn requests are recorded, not changed');

 const { compaction } = await hooks.session_before_compact(event(branch, { customInstructions: 'Keep the parser notes' }), ctx);
 const [request] = requests;
 // The cached request unchanged, then the reply and tool results after it and the summary request, converted by Pi.
 assert.deepEqual(request.payload, { ...last, messages: [...last.messages, { role: 'assistant', content: [{ type: 'text', text: 'converted suffix' }] }] });
 assert.deepEqual(request.context.messages.map(m => m.role), ['assistant', 'toolResult', 'user']);
 const instruction = request.context.messages.at(-1).content;
 assert.match(instruction, /^Respond with text only\. Do not call any tools/);
 assert.match(instruction, /6\. All user messages:/);
 assert.match(instruction, /Additional Instructions:\nKeep the parser notes\n\nReminder: do not call any tools/);
 assert.equal(request.options.cacheRetention, 'none', 'nothing new is cached');
 assert.equal(request.options.sessionId, 's1');
 assert.equal(request.options.reasoning, 'high');

 // Only the last reply and its tool results stay; the summary covers everything.
 assert.equal(compaction.firstKeptEntryId, 'a3');
 const text = compaction.summary;
 assert.equal(text.slice(0, text.indexOf('\n\n[Earlier history]')), '1. Primary Request and Intent:\n   Build the importer');
 assert.ok(text.includes(`\n\n${CONTINUE}\n\n## Files from before the summary\n`), 'the history note and the instruction to carry on follow the summary');
 const files = text.slice(text.indexOf('## Files'), text.indexOf('## Plan'));
 assert.ok(files.indexOf(join('src', 'b.ts')) < files.indexOf(join('src', 'a.ts')) && files.includes(join(cwd, 'src', 'a.ts')), 'newest first');
 assert.ok(files.includes('````ts\nconst fence = "```";\n````'));
 assert.doesNotMatch(files, /c\.ts|SKILL/, 'files in the kept messages are already in context; skills have their own section');
 assert.match(text, /## Plan\nPlan \(active\): Ship the importer\n\[>\] Write parser tests/);
 assert.match(text, /### Skill: parsers\nPath: .*SKILL\.md\n\n# Parsers\nWrite parsers by hand\./);
 assert.ok(text.endsWith('## Watches still running\nEach reports back on its own:\n- w3: `npm test`, waking you when it finishes'));
 assert.deepEqual(compaction.details.modifiedFiles, ['src/b.ts']);
 assert.deepEqual(compaction.details.readFiles, ['old.ts', 'skills/parsers/SKILL.md', 'src/a.ts']);
 assert.equal(compaction.details.request, 'cache');
 assert.equal(compaction.usage.cacheRead, 9000);

 // The summary says where the history is, so no separate note follows it.
 hooks.session_compact({ reason: 'threshold', fromExtension: true, compactionEntry: { details: compaction.details } }, ctx);
 assert.deepEqual(sent, []);
});

test('skills come back only when read since the previous compaction, counting the messages it kept', async t => {
 // A conversation running for weeks put back every skill it had ever read, 25,000 tokens of them, after each compaction.
 const cwd = mkdtempSync(join(tmpdir(), 'pi-compaction-'));
 t.after(() => rmSync(cwd, { recursive: true, force: true }));
 for (const name of ['old', 'kept', 'new']) {
  mkdirSync(join(cwd, 'skills', name), { recursive: true });
  writeFileSync(join(cwd, 'skills', name, 'SKILL.md'), `# ${name}\n`);
 }
 const branch = chain([
  message('u1', { role: 'user', content: 'Start' }),
  message('a1', { role: 'assistant', content: [call('t1', 'codemode', { code: '…' })], provider: 'anthropic', usage, stopReason: 'toolUse' }),
  message('r1', result('t1', 'ok', [['read', 'skills/old/SKILL.md']])),
  message('a2', { role: 'assistant', content: [call('t2', 'codemode', { code: '…' })], provider: 'anthropic', usage, stopReason: 'toolUse' }),
  message('r2', result('t2', 'ok', [['read', 'skills/kept/SKILL.md']])),
  { id: 'c1', type: 'compaction', summary: 'Earlier work', firstKeptEntryId: 'a2', tokensBefore: 400_000 },
  message('u2', { role: 'user', content: 'Go on' }),
  message('a3', { role: 'assistant', content: [call('t3', 'codemode', { code: '…' })], provider: 'anthropic', usage, stopReason: 'toolUse' }),
  message('r3', result('t3', 'ok', [['read', 'skills/new/SKILL.md']])),
  message('a4', { role: 'assistant', content: [{ type: 'text', text: 'Done' }], provider: 'anthropic', usage, stopReason: 'stop' }),
 ]);
 const { hooks } = harness();
 const { ctx } = context(branch, reply('<summary>Summary</summary>'), cwd);
 const { compaction } = await hooks.session_before_compact(event(branch), ctx);
 assert.deepEqual(compaction.details.restored.skills, [join(cwd, 'skills', 'new', 'SKILL.md'), join(cwd, 'skills', 'kept', 'SKILL.md')]);
 assert.doesNotMatch(compaction.summary, /### Skill: old/);
});

test('without a usable cached request the whole conversation is sent again, cut to fit after an overflow', async () => {
 const big = 'x'.repeat(4_000);
 const branch = chain([
  message('u1', { role: 'user', content: 'Import the files' }),
  ...[1, 2, 3, 4].flatMap(n => [
   message('a' + n, { role: 'assistant', content: [call('t' + n, 'codemode', { code: '…' })], provider: 'anthropic', usage, stopReason: 'toolUse' }),
   message('r' + n, result('t' + n, big))]),
 ]);
 const { hooks } = harness({ tools: ['codemode'] });
 const { ctx, requests } = context(branch, reply('<summary>Imported</summary>'), '/');
 ctx.model = { ...ctx.model, contextWindow: 70_000 };
 const { compaction } = await hooks.session_before_compact(event(branch, { reason: 'overflow' }), ctx);
 const [request] = requests;
 assert.equal(request.payload, undefined, 'a new request, not the cached one');
 assert.equal(request.context.systemPrompt, 'Conversation rules');
 assert.deepEqual(request.context.tools.map(tool => tool.name), ['codemode']);
 assert.equal(request.options.cacheRetention, 'none');
 const results = request.context.messages.filter(m => m.role === 'toolResult').map(m => m.content[0].text);
 assert.equal(results.at(-1), big, 'the newest result is kept');
 assert.equal(results[0], OMITTED_RESULT, 'the oldest results are left out first');
 assert.equal(compaction.firstKeptEntryId, 'a4');
 assert.ok(compaction.summary.startsWith('Imported\n\n' + CONTINUE), 'no history note without conversation_search');
 assert.deepEqual({ request: compaction.details.request, reason: compaction.details.reason }, { request: 'full', reason: 'the context overflowed' });
});

test('a summary asked for near the context budget may be as long as the model allows', async () => {
 // SavvyWise Bench: with 486,000 of a 500,000 budget used, summaries were cut off at about 10,000 tokens, and the turn
 // whose request they reused had been allowed 4,900.
 const branch = chain([
  message('u1', { role: 'user', content: 'Go' }),
  message('a1', { role: 'assistant', content: [call('t1', 'codemode', { code: '…' })], provider: 'anthropic', usage, stopReason: 'toolUse' }),
  message('r1', result('t1', 'ok')),
 ]);
 const { hooks } = harness();
 const { ctx } = context(branch, undefined, '/');
 const requests = [];
 ctx.modelRegistry.streamSimple = (model, context, options) => ({ result: async () => {
  requests.push({ model, payload: await options.onPayload({ max_tokens: 128_000, messages: [] }) });
  return reply('<summary>Summary</summary>');
 } });
 ctx.sessionManager.getLeafId = () => 'u1';
 hooks.context_with_system({ messages: [] }, ctx);
 hooks.before_provider_request({ payload: { model: 'claude-opus-5-5', max_tokens: 4_900, messages: [{ role: 'user', content: 'Go' }] } }, ctx);
 const { compaction } = await hooks.session_before_compact(event(branch), ctx);
 assert.equal(compaction.details.request, 'cache');
 assert.equal(requests[0].model.contextWindow, 1_000_000, 'Pi fits the output to the window Opus accepts, not to the budget');
 assert.equal(requests[0].payload.max_tokens, 128_000, "the summary's own cap, not the reused turn's");
});

test('a reply that is not a complete summary cancels the compaction and holds it, instead of saving it or falling back', async () => {
 const branch = chain([message('u1', { role: 'user', content: 'Go' }), message('a1', { role: 'assistant', content: [{ type: 'text', text: 'Done' }], provider: 'anthropic', usage, stopReason: 'stop' })]);
 for (const [answer, why] of [[{ ...reply('<summary>Half'), stopReason: 'length' }, /cut off at the model's output limit/],
  [{ role: 'assistant', stopReason: 'toolUse', content: [call('t', 'read', { path: 'a' })], usage }, /called a tool instead/]]) {
  const { hooks } = harness();
  const { ctx, requests } = context(branch, answer, '/');
  const started = Date.now();
  assert.deepEqual(await hooks.session_before_compact(event(branch), ctx), { cancel: true });
  assert.match(requests.at(-1).notify, why);
  assert.match(compactionFailure('s1', started), why);
 }
 assert.equal(extractSummary('<analysis>a</analysis>\nNo tags, still a summary'), 'No tags, still a summary');
});

test('after a Codex checkpoint the conversation is told its earlier history is searchable, once, when it can search', () => {
 // Summaries lose details the full history has; nothing told a compacted conversation it could still look them up.
 for (const tools of [['read', 'conversation_search'], ['read']]) {
  const { hooks, sent } = harness({ tools });
  hooks.session_compact({ reason: 'threshold', fromExtension: true, compactionEntry: { details: {} } }, { sessionManager: { getSessionId: () => '01a11efb-961f-7166-8384-2911659fc2a9' } });
  if (!tools.includes('conversation_search')) { assert.deepEqual(sent, []); continue; }
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message.customType, HISTORY_NOTE);
  assert.equal(sent[0].message.display, false);
  assert.deepEqual(sent[0].options, { triggerTurn: false }, 'the note never wakes the conversation');
  assert.match(sent[0].message.content, /conversation_search with session "01a11efb-961f-7166-8384-2911659fc2a9"/);
 }
});
