'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const SortModel = require('../web/sort-model.js');

test('four sort criteria map to eight symmetric canonical orders', function () {
  assert.deepEqual(SortModel.CRITERIA.map(function map(item) { return item.value; }), ['saved', 'updated', 'title', 'source']);
  assert.deepEqual(SortModel.CRITERIA.flatMap(function flatten(item) { return [item.ascending, item.descending]; }), [
    'oldest', 'newest', 'updated_asc', 'updated_desc', 'title_asc', 'title_desc', 'source_asc', 'source_desc'
  ]);
});

test('sort descriptions and defaults use human direction labels', function () {
  assert.deepEqual(SortModel.describe('newest'), {
    sort: 'newest', criterion: 'saved', criterionLabel: 'Saved', direction: 'descending', directionLabel: 'Newest', triggerLabel: 'Saved ↓'
  });
  assert.equal(SortModel.defaultSortFor('updated'), 'updated_desc');
  assert.equal(SortModel.defaultSortFor('title'), 'title_asc');
  assert.equal(SortModel.opposite('source_asc'), 'source_desc');
  assert.equal(SortModel.canonical('title'), 'title_asc');
  assert.equal(SortModel.canonical('unsupported'), 'newest');
});
