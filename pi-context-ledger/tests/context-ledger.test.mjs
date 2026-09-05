import assert from 'node:assert/strict';
import test from 'node:test';
import {visibleWidth} from '@earendil-works/pi-tui';
import extension from '../extensions/context-ledger.ts';
import {initTheme} from '@earendil-works/pi-coding-agent';
initTheme('dark', false);
test('entry renderer fits wide labels into every viewport and persists no model message', () => {
 let renderer;
 extension({registerEntryRenderer: (_name, fn) => renderer = fn, on() {}, registerCommand() {}});
 const data = {total: 100, contextWindow: 1000, windowPercent: 10, groups: [{label: 'Tools', tokens: 100, items: [{label: '界'.repeat(100), tokens: 100}]}]};
 const theme = {fg: (_c, s) => s, bold: s => s};
 for (const expanded of [false, true]) {
  const component = renderer({data}, {expanded}, theme);
  for (let width = 1; width <= 120; width++) for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width, `width ${width}: ${line}`);
  component.invalidate();
 }
 assert.equal(renderer({data: null}, {}, theme), undefined);
});
