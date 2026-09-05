import assert from 'node:assert/strict';
import test from 'node:test';
import extension from '../extensions/pi-sync.ts';
test('help and invalid actions never execute git and aliases share handling', async () => {
 const commands = {}, messages = [];
 extension({registerCommand: (name, command) => commands[name] = command, exec() {throw Error('Unexpected git invocation');}});
 const ctx = {hasUI: true, ui: {notify: (message, type) => messages.push({message, type})}};
 assert.equal(commands.pisync.handler, commands['pi-sync'].handler);
 await commands['pi-sync'].handler('help', ctx);
 assert.match(messages[0].message, /pi-sync/);
 assert.notEqual(messages[0].type, 'error');
 await commands['pi-sync'].handler('not-an-action', ctx);
 assert.equal(messages[1].type, 'error');
 assert.match(messages[1].message, /Unknown pi-sync action/);
});
