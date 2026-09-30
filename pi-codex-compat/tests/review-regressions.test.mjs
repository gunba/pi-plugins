import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { AgentSession } from '@earendil-works/pi-coding-agent';
import compat from '../extensions/codex-compat.ts';
import { computeSessionStats } from '../../pi-session-usage/index.ts';
import { createExecRuntimeOwner, executeManagedExecCommand, executeWriteStdin, shutdownExecSessions } from '../extensions/shell-runtime.ts';

function tools() {
 const result = new Map();
 compat({ events: { on: () => () => {} }, getActiveTools: () => [], setActiveTools() {}, on() {}, registerCommand() {}, registerTool: tool => result.set(tool.name, tool) });
 return result;
}
async function workspace(t) {
 const cwd = await mkdtemp(join(tmpdir(), 'process-regression-'));
 t.after(() => rm(cwd, {recursive:true, force:true}));
 return cwd;
}

test('independent launches overlap and same-process polls serialize their cursor', {timeout:30000}, async t => {
 const cwd = await workspace(t);
 const owner = createExecRuntimeOwner();
 t.after(() => shutdownExecSessions(owner));
 assert.equal(tools().get('exec_command').executionMode,'parallel');
 assert.equal(tools().get('write_stdin').executionMode,'parallel');
 const command = code => `${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)}`;
 const launch = (name, other) => executeManagedExecCommand({cmd:command(`const fs=require('fs');fs.writeFileSync('${name}','');const timer=setInterval(()=>{if(fs.existsSync('${other}')){clearInterval(timer);console.log('both started')}},10)`),yield_time_ms:10000},undefined,{cwd},undefined,owner);
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
 assert.equal(results[1].status,'rejected');
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
