import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url);
const { default: install } = await jiti.import('../index.ts');
function harness(answer = async () => false) {
  const handlers = new Map(), settings = {};
  const pi = { on: (name, handler) => handlers.set(name, handler), events: { on: () => {} }, getSettings: () => settings };
  install(pi);
  let questions = 0;
  const controller = new AbortController();
  const ctx = { cwd: '/work/project', hasUI: true, signal: controller.signal,
    sessionManager: { getSessionId: () => 'one' },
    ui: { confirm: async (...args) => { questions++; return answer(...args); } } };
  return { handlers, settings, ctx, controller, questions: () => questions,
    call: event => handlers.get('tool_call')(event, ctx) };
}
const removal = () => ({ toolName: 'exec_command', toolCallId: 'one', input: { cmd: 'git reset --hard', shell: '/bin/bash' } });

test('hard denials do not request an override; harmless metadata invokes no dialog or command', async () => {
  const h = harness(async () => { throw Error('no dialog expected'); });
  assert.equal((await h.call({ ...removal(), input: { cmd: 'rm -rf /', shell: '/bin/bash' } })).block, true);
  assert.equal(await h.call({ ...removal(), input: { cmd: 'python -c "print(1)"', shell: '/bin/bash' } }), undefined);
  assert.equal(h.questions(), 0);
});

test('each nested call requires its own approval; decisions are not remembered', async () => {
  let answer = true;
  const h = harness(async () => answer);
  assert.equal(await h.call({ ...removal(), parentToolCallId: 'codemode-one' }), undefined);
  answer = false;
  assert.equal((await h.call({ ...removal(), parentToolCallId: 'codemode-two' })).block, true);
  assert.equal(h.questions(), 2);
});

test('headless, cancelled and retired confirmations do not grant execution', async () => {
  const headless = harness(); headless.ctx.hasUI = false;
  assert.equal((await headless.call(removal())).block, true);
  assert.equal(headless.questions(), 0);
  for (const retire of ['session_start', 'session_tree', 'session_shutdown', 'signal']) {
    let release;
    const h = harness(() => new Promise(resolve => { release = resolve; }));
    const pending = h.call(removal());
    if (retire === 'signal') h.controller.abort(); else h.handlers.get(retire)();
    release(true);
    assert.equal((await pending).block, true, retire);
  }
});

test('changing arguments, command configuration or identity invalidates approval', async () => {
  for (const mutate of [(h,e) => { e.input.cmd += '; echo changed'; }, h => { h.settings.shellPath = '/other/shell'; }, h => { h.ctx.sessionManager.getSessionId = () => 'two'; }]) {
    let release;
    const h = harness(() => new Promise(resolve => { release = resolve; })), event = removal();
    const pending = h.call(event); mutate(h, event); release(true);
    assert.equal((await pending).block, true);
  }
});

test('only native bash prefixes are included; ordinary cleanup and file edits do not prompt', async () => {
  const h = harness(async () => false); h.settings.shellCommandPrefix = 'rm -rf /';
  assert.equal((await h.call({ toolName: 'bash', input: { command: 'echo hi' } })).block, true);
  assert.equal(await h.call({ toolName: 'exec_command', input: { cmd: 'echo hi' } }), undefined);
  assert.equal(await h.call({ toolName: 'write', input: { path: '/etc/profile', content: 'example' } }), undefined);
  assert.equal(await h.call({ toolName: 'edit', input: { path: '.git/config', edits: [] } }), undefined);
  assert.equal(await h.call({ ...removal(), input: { cmd: 'rm -rf /tmp/owned-task/runtime', shell: '/bin/bash' } }), undefined);
  assert.equal(h.questions(), 0);
});
