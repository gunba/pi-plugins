import assert from 'node:assert/strict';
import test from 'node:test';
import {visibleWidth, getKeybindings} from '@earendil-works/pi-tui';
import extension from '../index.ts';
const theme = {fg: (_color, text) => text, bg: (_color, text) => text, bold: text => text};
function tool() {
 let tool;
 extension({registerTool: value => tool = value, events: {emit() {}}});
 return tool;
}
test('aborted calls do not prompt', async () => {
 const signal = AbortSignal.abort();
 const result = await tool().execute('id', {question: 'Proceed?'}, signal, undefined, {});
 assert.equal(result.details.cancelled, true);
});
test('RPC freeform prompt strips terminal controls and returns user response', async () => {
 const result = await tool().execute('id', {question: '\x1b[2JProceed?\x07'}, undefined, undefined, {
  hasUI: true, mode: 'rpc', ui: {async input(question) {assert.equal(question, 'Proceed?'); return 'yes';}}
 });
 assert.deepEqual(result.details.response, {kind: 'freeform', text: 'yes'});
});
test('actual custom question component stays inside narrow viewports', async () => {
 await tool().execute('id', {question: 'Choose a 界 option', options: ['First', 'Second'], displayMode: 'inline'}, undefined, undefined, {
  hasUI: true, mode: 'tui', ui: {async custom(factory) {
   const component = factory({terminal: {rows: 40}, requestRender() {}}, theme, getKeybindings(), () => {});
   for (let width = 1; width <= 100; width++) {
    for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width, `width ${width}: ${line}`);
   }
   return null;
  }}
 });
});
