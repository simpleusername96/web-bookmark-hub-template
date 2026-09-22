'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { nextHeaderState } = require('../web/responsive-workflows.js');
const { renderResults } = require('../web/results-view.js');

test('reading header ignores small movement and uses different down/up thresholds', function () {
  let state = nextHeaderState(null, 300, true);
  for (const y of [304, 309, 315]) {
    state = nextHeaderState(state, y, false);
    assert.equal(state.hidden, false);
  }
  state = nextHeaderState(state, 316, false);
  assert.equal(state.hidden, true);
  state = nextHeaderState(state, 311, false);
  assert.equal(state.hidden, true);
  state = nextHeaderState(state, 308, false);
  assert.equal(state.hidden, false);
});

test('reversing direction resets accumulation instead of making the header flicker', function () {
  let state = nextHeaderState(null, 400, true);
  state = nextHeaderState(state, 414, false);
  state = nextHeaderState(state, 409, false);
  state = nextHeaderState(state, 418, false);
  assert.equal(state.hidden, false);
  state = nextHeaderState(state, 425, false);
  assert.equal(state.hidden, true);
  assert.deepEqual(nextHeaderState(state, 425, false), state);
});

test('top, focus, overlays, and viewport reset reveal the header without carrying stale distance', function () {
  const hidden = nextHeaderState(nextHeaderState(null, 300, true), 600, false);
  assert.equal(hidden.hidden, true);
  for (const [y, locked] of [[160, false], [-20, false], [600, true]]) {
    const shown = nextHeaderState(hidden, y, locked);
    assert.equal(shown.hidden, false);
    assert.equal(shown.distance, 0);
    assert.equal(shown.direction, 0);
    assert.ok(shown.y >= 0);
  }
});

test('empty results preserve supplied recovery callbacks and do not append a second empty state', function () {
  let calls = 0;
  const action = { label: 'Clear search', onClick() { calls += 1; } };
  const emptyCalls = [];
  const container = { children: [], classList: { contains() { return false; } }, removeAttribute() {} };
  const deps = {
    t(key) { return key; },
    renderEmpty(...args) { emptyCalls.push(args); }
  };
  renderResults({ container, items: [], view: 'grid', emptyState: { message: 'No matches', actions: [action] } }, deps);
  assert.equal(emptyCalls.length, 1);
  assert.equal(emptyCalls[0][0], container);
  assert.equal(emptyCalls[0][1], 'No matches');
  emptyCalls[0][2][0].onClick();
  assert.equal(calls, 1);
  container.classList.contains = value => value === 'results-feed';
  renderResults({ container, items: [], view: 'feed', append: true }, deps);
  assert.equal(emptyCalls.length, 1);
});
