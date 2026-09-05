import assert from 'node:assert/strict';
import fs, { mkdir, mkdtemp, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { withFileMutationQueue, AgentSession } from '@earendil-works/pi-coding-agent';
import { convertResponsesTools, convertResponsesMessages } from '../../node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js';
import compat from '../extensions/codex-compat.ts';
import { computeSessionStats } from '../extensions/usage.ts';
import { createExecRuntimeOwner, executeManagedExecCommand, executeWriteStdin, shutdownExecSessions } from '../extensions/shell-runtime.ts';

function tools() {
 const result = new Map();
 compat({ getActiveTools: () => [], setActiveTools() {}, on() {}, registerCommand() {}, registerTool: tool => result.set(tool.name, tool) });
 return result;
}
async function workspace(t) {
 const cwd = await mkdtemp(join(tmpdir(), 'compat-identity-'));
 t.after(() => rm(cwd, {recursive:true, force:true}));
 await writeFile(join(cwd, 'a'), 'old\n');
 await symlink('a', join(cwd, 'b'));
 return cwd;
}
const update = (path, before, after, move = '') => `*** Update File: ${path}\n${move ? `*** Move to: ${move}\n` : ''}@@\n-${before}\n+${after}\n`;
const patch = (...hunks) => `*** Begin Patch\n${hunks.join('')}*** End Patch`;
const execute = (tool, cwd, input, signal) => tool.execute('test', {input}, signal, undefined, {cwd});

test('aliases share staged content and same-target moves never delete the target', {timeout: 2000}, async t => {
 const cwd = await workspace(t);
 const tool = tools().get('apply_patch');
 const result = await execute(tool, cwd, patch(update('b','old','middle'), update('a','middle','new','b')));
 assert.equal(result.details.exitCode, 0);
 assert.equal(await readFile(join(cwd,'a'),'utf8'), 'new\n');
 assert.equal(await readFile(join(cwd,'b'),'utf8'), 'new\n');
 assert.equal(result.details.changes.length, 1);
});

test('deleting or moving a symbolic-link entry cannot delete its target', async t => {
 const cwd = await workspace(t);
 for (const input of [patch('*** Delete File: b\n'), patch(update('b','old','new','elsewhere'))]) {
  const result = await execute(tools().get('apply_patch'),cwd,input);
  assert.equal(result.details.exitCode,1);
  assert.match(JSON.stringify(result.content),/symbolic-link entry/);
  assert.equal(await readFile(join(cwd,'a'),'utf8'),'old\n');
  assert.equal((await fs.lstat(join(cwd,'b'))).isSymbolicLink(),true);
 }
});

test('new leaves under directory aliases share staged state; moves into aliases preserve the destination', {timeout:2000}, async t => {
 const cwd = await workspace(t);
 await mkdir(join(cwd,'dir'));
 await symlink(join(cwd,'dir'),join(cwd,'dir-alias'), process.platform === 'win32' ? 'junction' : 'dir');
 const tool = tools().get('apply_patch');
 const created = await execute(tool,cwd,patch('*** Add File: dir/new\n+first\n', update('dir-alias/new','first','second')));
 assert.equal(created.details.exitCode,0);
 assert.equal(await readFile(join(cwd,'dir/new'),'utf8'),'second\n');
 const moved = await execute(tool,cwd,patch(update('dir/new','second','moved','b')));
 assert.equal(moved.details.exitCode,0);
 assert.equal(await readFile(join(cwd,'a'),'utf8'),'moved\n');
 assert.equal(await readFile(join(cwd,'b'),'utf8'),'moved\n');
 await assert.rejects(readFile(join(cwd,'dir/new')), {code:'ENOENT'});
});

test('reversed multi-file alias order does not deadlock', {timeout: 2000}, async t => {
 const cwd = await workspace(t);
 await writeFile(join(cwd,'c'), 'old\n');
 await symlink('c', join(cwd,'d'));
 const tool = tools().get('apply_patch');
 const results = await Promise.all([
  execute(tool,cwd,patch(update('a','old','new'),update('d','old','new'))),
  execute(tool,cwd,patch(update('c','old','new'),update('b','old','new'))),
 ]);
 assert.equal(results.filter(r => r.details.exitCode === 0).length, 1);
 assert.equal(await readFile(join(cwd,'a'),'utf8'), 'new\n');
 assert.equal(await readFile(join(cwd,'c'),'utf8'), 'new\n');
});

for (const name of ['apply_patch','exec_command']) test(`${name} observes cancellation after queued alias locks`, {timeout:2000}, async t => {
 const cwd = await workspace(t);
 let release, ready;
 const acquired = new Promise(resolve => {ready=resolve;});
 const lock = withFileMutationQueue(join(cwd,'a'), () => {ready(); return new Promise(resolve => {release=resolve;});});
 await acquired;
 const controller = new AbortController();
 const input = patch(update('b','old','new'));
 const params = name === 'apply_patch' ? {input} : {cmd:`apply_patch <<'PATCH'\n${input}\nPATCH`};
 const pending = tools().get(name).execute('test',params,controller.signal,undefined,{cwd});
 await delay(20);
 controller.abort(); release(); await lock;
 assert.equal((await pending).details.exitCode, 1);
 assert.equal(await readFile(join(cwd,'a'),'utf8'),'old\n');
 const next = await execute(tools().get('apply_patch'),cwd,input);
 assert.equal(next.details.exitCode,0);
});

test('in-flight cancellation rolls back before releasing mutation ownership', {timeout:2000}, async t => {
 const cwd = await workspace(t);
 const originalWrite = fs.writeFile;
 let written, proceed, restoring, finishRollback;
 const didWrite = new Promise(resolve => {written=resolve;});
 const continueWrite = new Promise(resolve => {proceed=resolve;});
 const didRestore = new Promise(resolve => {restoring=resolve;});
 const continueRestore = new Promise(resolve => {finishRollback=resolve;});
 t.mock.method(fs,'writeFile', async (...args) => {
  await originalWrite(...args);
  if (args[0] === join(cwd,'a')) {
   if (args[1] === 'new\n') { written(); await continueWrite; }
   else { restoring(); await continueRestore; }
  }
 });
 syncBuiltinESMExports();
 t.after(() => {t.mock.restoreAll(); syncBuiltinESMExports();});
 const controller = new AbortController();
 const pending = execute(tools().get('apply_patch'),cwd,patch(update('a','old','new')),controller.signal);
 await didWrite;
 let acquired = false;
 const other = withFileMutationQueue(join(cwd,'a'), async () => {acquired=true;});
 controller.abort(); proceed();
 await didRestore;
 await delay(10);
 assert.equal(acquired,false);
 finishRollback();
 assert.equal((await pending).details.exitCode,1);
 await other;
 assert.equal(await readFile(join(cwd,'a'),'utf8'),'old\n');
});

test('native SDK selects grammar only with supported metadata and uses native custom outputs', () => {
 const tool = tools().get('apply_patch');
 const [enabled] = convertResponsesTools([tool], {supportsOpenAIGrammarTools:true});
 assert.equal(enabled.type,'custom');
 assert.equal(enabled.format.syntax,'lark');
 assert.match(enabled.format.definition,/start: begin_patch hunk\+ end_patch/);
 assert.equal(convertResponsesTools([tool], {supportsOpenAIGrammarTools:false})[0].type,'function');
 const model = {api:'openai-codex-responses',provider:'openai-codex',id:'gpt-5',input:['text'],compat:{supportsOpenAIGrammarTools:true}};
 const result = convertResponsesMessages(model,{messages:[{role:'toolResult',toolCallId:'tool123',toolName:'apply_patch',content:[{type:'text',text:'Success'}],isError:false,timestamp:0}]},new Set(['openai-codex']),{grammarToolInputProperties:new Map([['apply_patch','input']])});
 assert.equal(result[0].type,'custom_tool_call_output');
});

test('independent launches overlap and same-process polls serialize their cursor', {timeout:10000}, async t => {
 const cwd = await workspace(t);
 const owner = createExecRuntimeOwner();
 t.after(() => shutdownExecSessions(owner));
 assert.equal(tools().get('exec_command').executionMode,'parallel');
 assert.equal(tools().get('write_stdin').executionMode,'parallel');
 const command = code => `${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)}`;
 const launch = (name, other) => executeManagedExecCommand({cmd:command(`const fs=require('fs');fs.writeFileSync('${name}','');const timer=setInterval(()=>{if(fs.existsSync('${other}')){clearInterval(timer);console.log('both started')}},10)`),yield_time_ms:1000},undefined,{cwd},undefined,owner);
 const starts = await Promise.all([launch('one','two'),launch('two','one')]);
 assert.ok(starts.every(result => result.details.exit_code === 0));
 const lifetime = process.platform === 'win32' ? 2500 : 700;
 const running = await executeManagedExecCommand({cmd:command(`setTimeout(()=>console.log('unique-output'),${lifetime})`),yield_time_ms:250},undefined,{cwd},undefined,owner);
 const id = running.details.session_id;
 assert.ok(id);
 const updates = [];
 const first = executeWriteStdin({session_id:id},undefined,() => updates.push('first'),owner);
 const second = executeWriteStdin({session_id:id},undefined,() => updates.push('second'),owner);
 const results = await Promise.allSettled([first,second]);
 assert.equal(results[0].status,'fulfilled');
 assert.equal(results[1].status,'rejected'); // first consumes completion and releases the session
 assert.ok(updates.length > 0);
 assert.ok(updates.every(value => value === 'first'));
 assert.match(JSON.stringify(results[0].value.content),/unique-output/);
});

test('usage fold matches pinned native totals including billed tools and summaries', () => {
 const usage = {input:100,output:20,cacheRead:30,cacheWrite:40,totalTokens:190,cost:{input:.1,output:.2,cacheRead:.3,cacheWrite:.4,total:1}};
 const entries = [
  ...['assistant','toolResult'].map(role => ({type:'message',message:{role,content:[],usage}})),
  ...['compaction','branch_summary'].map(type => ({type,usage})),
 ];
 const native = AgentSession.prototype.getSessionStats.call({sessionManager:{getEntries:()=>entries},getContextUsage:()=>undefined});
 const actual = computeSessionStats(entries);
 assert.equal(actual.totalInput,native.tokens.input);
 assert.equal(actual.totalOutput,native.tokens.output);
 assert.equal(actual.totalCacheRead,native.tokens.cacheRead);
 assert.equal(actual.totalCacheWrite,native.tokens.cacheWrite);
 assert.equal(actual.totalCost,native.cost);
});

test('a cancelled queued poll returns without waiting for the cursor owner', {timeout:10000}, async t => {
 const cwd = await workspace(t);
 const owner = createExecRuntimeOwner();
 t.after(() => shutdownExecSessions(owner));
 const command = `${JSON.stringify(process.execPath)} -e "setInterval(()=>{},1000)"`;
 const running = await executeManagedExecCommand({cmd:command,yield_time_ms:250},undefined,{cwd},undefined,owner);
 const id = running.details.session_id;
 assert.ok(id);
 const firstSignal = new AbortController(), queuedSignal = new AbortController();
 let ready;
 const polling = new Promise(resolve => { ready = resolve; });
 const first = executeWriteStdin({session_id:id,yield_time_ms:30000},firstSignal.signal,ready,owner);
 await polling;
 const queued = executeWriteStdin({session_id:id},queuedSignal.signal,undefined,owner);
 const rejected = assert.rejects(queued, /abort/i);
 await delay(20);
 queuedSignal.abort();
 await rejected;
 firstSignal.abort();
 await first;
});
