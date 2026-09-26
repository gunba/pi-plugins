import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {visibleWidth, getKeybindings} from '@earendil-works/pi-tui';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.resolve('@earendil-works/pi-coding-agent'));
const {createJiti} = require('jiti');
const extension = await createJiti(import.meta.url).import('../extensions/pi-config.ts', {default: true});
const theme = {fg: (_c, s) => s, bg: (_c, s) => s, bold: s => s};
test('navigator omits unused profiles and fits narrow terminals', async () => {
 const root = mkdtempSync(join(tmpdir(), 'pi-config-test-'));
 const commands = {};
 try {
  mkdirSync(join(root, '.pi/agents'), {recursive: true});
  writeFileSync(join(root, '.pi/agents/stale-profile.md'), '# Stale profile');
  extension({registerCommand: (name, command) => commands[name] = command, getCommands: () => [], getAllTools: () => []});
  let rendered = false;
  await commands['pi-config'].handler('', {cwd: root, mode: 'tui', hasUI: true, ui: {
   notify(message, level) {assert.notEqual(level, 'error', message);},
   async custom(factory) {
    const component = factory({terminal: {rows: 40}, requestRender() {}}, theme, getKeybindings(), () => {});
    for (let width = 1; width <= 110; width++) for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width, `width ${width}: ${line}`);
    const text = component.render(200).join('\n');
    assert.equal(text.includes('☉ Agents'), false);
    rendered = true;
    return null;
   }
  }});
  assert.ok(rendered);
  assert.equal(commands.pcfg.handler, commands['pi-config'].handler);
 } finally {rmSync(root, {recursive: true, force: true});}
});

test('reload exits the navigator and never touches its retired context', async t => {
 const root = mkdtempSync(join(tmpdir(), 'pi-config-reload-'));
 t.after(() => rmSync(root, {recursive: true, force: true}));
 const path = join(root, 'context.md');
 writeFileSync(path, 'Before\n');
 const commands = {};
 extension({registerCommand: (name, command) => commands[name] = command, getCommands: () => [], getAllTools: () => []});
 for (const failure of [undefined, new Error('reload failed after retirement')]) {
  let retired = false, opened = 0, reloaded = false;
  const live = () => assert.equal(retired, false, 'old context used after reload');
  const ctx = {cwd: root, mode: 'tui', hasUI: true, ui: {
   notify() {live();},
   async custom() {live(); opened++; return {action: 'edit', entry: {title: 'Context', path, tool: 'pi', kind: 'context', format: 'markdown'}};},
   async editor(_title, text) {live(); return text + 'Edited\n';},
   async confirm() {live(); return true;},
  }, async reload() {reloaded = retired = true; if (failure) throw failure;}};
  if (failure) await assert.rejects(commands['pi-config'].handler('', ctx), error => error === failure);
  else await commands['pi-config'].handler('', ctx);
  assert.equal(reloaded, true);
  assert.equal(opened, 1);
 }
});

test('an edit cannot overwrite a change made while its dialog was open', async t => {
 const root = mkdtempSync(join(tmpdir(), 'pi-config-conflict-'));
 t.after(() => rmSync(root, {recursive: true, force: true}));
 const path = join(root, 'context.md');
 writeFileSync(path, 'Original\n');
 const commands = {}, errors = [];
 extension({registerCommand: (name, command) => commands[name] = command, getCommands: () => [], getAllTools: () => []});
 await commands['pi-config'].handler('', {cwd: root, mode: 'tui', hasUI: true, ui: {
  notify(message, level) {if (level === 'error') errors.push(message);},
  async custom() {return {action: 'edit', entry: {title: 'Context', path, tool: 'pi', kind: 'context', format: 'markdown'}};},
  async editor() {writeFileSync(path, 'Concurrent edit\n'); return 'Stale edit\n';},
  async confirm() {assert.fail('a failed save must not offer reload');},
 }});
 assert.equal(readFileSync(path, 'utf8'), 'Concurrent edit\n');
 assert.match(errors[0], /changed while it was being edited/);
});
