import assert from 'node:assert/strict';
import test from 'node:test';
import extension, {versionLine} from '../extensions/system-context.ts';

test('version probes are asynchronous, bounded and tolerate unavailable commands', async () => {
 assert.equal(await versionLine(process.execPath, ['--version']), process.version);
 assert.equal(await versionLine(process.execPath, ['-e', 'setInterval(()=>{}, 1000)']), undefined);
 assert.equal(await versionLine(process.execPath, ['-e', 'console.log("x".repeat(100000))']), undefined);
 assert.equal(await versionLine('/nonexistent-pi-probe'), undefined);
});
test('environment uses native prompt sections instead of overriding the full prompt', async () => {
 let hook;
 extension({on: (_name, fn) => hook = fn});
 const ctx = {isProjectTrusted: () => false};
 const first = {systemPrompt: 'Original', systemPromptOptions: {cwd: '/tmp/one\ncontrol\u0007', appendSystemPrompt: 'Existing rule'}};
 assert.equal(await hook(first, ctx), undefined, 'no forced full-prompt override');
 assert.equal(first.systemPrompt, 'Original');
 assert.ok(first.systemPromptOptions.appendSystemPrompt.startsWith('Existing rule\n\n### Local env'));
 assert.match(first.systemPromptOptions.appendSystemPrompt, /cwd: \/tmp\/one control/);
 assert.equal(first.systemPromptOptions.appendSystemPrompt.includes('\u0007'), false);
 const second = {systemPrompt: 'New', systemPromptOptions: {cwd: '/tmp/two'}};
 await hook(second, ctx);
 assert.match(second.systemPromptOptions.appendSystemPrompt, /cwd: \/tmp\/two/);
 assert.doesNotMatch(second.systemPromptOptions.appendSystemPrompt, /Original|Existing rule/);
 assert.equal(second.systemPromptOptions.appendSystemPrompt.match(/### Local env/g).length, 1);
});
