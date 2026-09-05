import assert from 'node:assert/strict';
import test from 'node:test';
import extension, {versionLine} from '../extensions/system-context.ts';

test('version probes are asynchronous, bounded and tolerate unavailable commands', async () => {
 assert.equal(await versionLine(process.execPath, ['--version']), process.version);
 assert.equal(await versionLine(process.execPath, ['-e', 'setInterval(()=>{}, 1000)']), undefined);
 assert.equal(await versionLine(process.execPath, ['-e', 'console.log("x".repeat(100000))']), undefined);
 assert.equal(await versionLine('/nonexistent-pi-probe'), undefined);
});
test('registered hook preserves prompt and uses current sanitized cwd', async () => {
 let hook;
 extension({on: (_name, fn) => hook = fn});
 const ctx = {isProjectTrusted: () => false};
 const first = await hook({systemPrompt: 'Original', systemPromptOptions: {cwd: '/tmp/one\ncontrol\u0007'}}, ctx);
 assert.ok(first.systemPrompt.startsWith('Original\n\n### Local env'));
 assert.match(first.systemPrompt, /cwd: \/tmp\/one control/);
 assert.equal(first.systemPrompt.includes('\u0007'), false);
 const second = await hook({systemPrompt: 'New', systemPromptOptions: {cwd: '/tmp/two'}}, ctx);
 assert.match(second.systemPrompt, /cwd: \/tmp\/two/);
 assert.equal(second.systemPrompt.includes('Original'), false);
});
