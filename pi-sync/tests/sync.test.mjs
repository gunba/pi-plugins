import assert from 'node:assert/strict';
import test from 'node:test';
import extension from '../extensions/pi-sync.ts';
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

test("managed configuration sync excludes confidential output artifacts", async t => {
 const root = mkdtempSync(join(tmpdir(), "pi-sync-artifacts-"));
 const old = process.env.PI_CODING_AGENT_DIR;
 process.env.PI_CODING_AGENT_DIR = join(root, "agent");
 t.after(() => {
  if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old;
  rmSync(root, {recursive:true, force:true});
 });
 const commands = {};
 extension({registerCommand:(name, command)=>commands[name]=command, exec(){throw Error("No git/network needed");}});
 await commands["pi-sync"].handler("ignore", {hasUI:true, ui:{notify(){}}});
 assert.match(readFileSync(join(root, ".gitignore"), "utf8"), /^agent\/tool-output\/$/m);
 assert.match(readFileSync(join(root, ".gitignore"), "utf8"), /^agent\/party\/$/m);
});
