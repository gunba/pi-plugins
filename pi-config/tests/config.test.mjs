import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
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
