import assert from 'node:assert/strict';
import test from 'node:test';
import {getEventListeners} from 'node:events';
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

test('answered custom dialogs release abort listeners and timeouts', async t => {
 t.mock.timers.enable({apis: ['setTimeout']});
 const controller = new AbortController();
 let callbacks = 0;
 await tool().execute('id', {question: 'Choose', options: ['A'], timeout: 100, displayMode: 'inline'}, controller.signal, undefined, {
  hasUI: true, mode: 'tui', ui: {async custom(factory) {
   factory({terminal: {rows: 40}, requestRender() {}}, theme, getKeybindings(), () => callbacks++);
   assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
   return {kind: 'selection', selections: ['A']};
  }}
 });
 assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
 t.mock.timers.tick(200);
 controller.abort();
 assert.equal(callbacks, 0, 'completed UI must not receive timeout or abort callbacks');
});

test('abort closes an active custom dialog once and releases its timer', async t => {
 t.mock.timers.enable({apis: ['setTimeout']});
 const controller = new AbortController();
 let callbacks = 0;
 const result = await tool().execute('id', {question: 'Choose', options: ['A'], timeout: 100, displayMode: 'inline'}, controller.signal, undefined, {
  hasUI: true, mode: 'tui', ui: {custom: factory => new Promise(resolve => {
   factory({terminal: {rows: 40}, requestRender() {}}, theme, getKeybindings(), value => { callbacks++; resolve(value); });
   controller.abort();
  })}
 });
 assert.equal(result.details.cancelled, true);
 assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
 t.mock.timers.tick(200);
 assert.equal(callbacks, 1);
});

test('freeform and RPC comment dialogs receive the abort signal', async () => {
 const controller = new AbortController();
 const signal = controller.signal;
 const ui = {
  async select(_question, _options, opts) {assert.equal(opts.signal, signal); return 'A';},
  async input(_question, _placeholder, opts) {assert.equal(opts.signal, signal); controller.abort(); return undefined;},
 };
 const result = await tool().execute('id', {question: 'Choose', options: ['A'], allowComment: true}, signal, undefined, {hasUI: true, mode: 'rpc', ui});
 assert.equal(result.details.cancelled, true);
 const freeformSignal = new AbortController().signal;
 await tool().execute('id', {question: 'Explain'}, freeformSignal, undefined, {
  hasUI: true, mode: 'rpc', ui: {async input(_question, _placeholder, opts) {assert.equal(opts.signal, freeformSignal); return 'answer';}}
 });
});
