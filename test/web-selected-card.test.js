'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// A touch selection control must remain available and keep focus after selection.
test('selection preserves touch checkbox availability and focus through selection and deselection', () => {
  const owner = path.join(__dirname, '../web/view.js');
  const target = { hidden: false };
  const checkbox = { checked: false, closest: () => target };
  const document = { activeElement: checkbox };
  const attributes = {};
  let focused = 0;
  const node = {
    dataset: { entryId: '42' },
    querySelector: () => checkbox,
    focus() { focused += 1; document.activeElement = node; },
    setAttribute(key, value) { attributes[key] = value; },
    removeAttribute(key) { delete attributes[key]; }
  };
  let managing = true;
  const container = { querySelectorAll: () => [node], classList: { contains: () => managing } };
  const context = { module: { exports: {} }, require: createRequire(owner), window: { document } };
  vm.runInNewContext(fs.readFileSync(owner, 'utf8'), context);
  const view = context.module.exports;
  view.syncRenderedSelection(container, [42]);
  assert.equal(target.hidden, false);
  assert.equal(checkbox.checked, true);
  assert.equal(attributes['aria-selected'], 'true');
  assert.equal(focused, 0);
  assert.equal(document.activeElement, checkbox);
  view.syncRenderedSelection(container, []);
  assert.equal(target.hidden, false);
  assert.equal(checkbox.checked, false);
  assert.equal(attributes['aria-selected'], 'false');
  managing = false;
  view.syncRenderedSelection(container, []);
  assert.equal(attributes['aria-selected'], undefined);
  // List checkbox remains an available control even while selected.
  checkbox.closest = () => null;
  managing = true;
  view.syncRenderedSelection(container, [42]);
  assert.equal(checkbox.checked, true);
  assert.equal(focused, 0);
});
