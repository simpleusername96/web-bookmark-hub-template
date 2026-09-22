'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const QueryState = require('../web/query-state.js');

test('recent preset uses an injected UTC clock and manual dates remove preset state', function () {
  const recent = QueryState.applyRecentPreset(QueryState.emptyFilters(), () => new Date('2026-09-01T21:00:00+09:00'));
  assert.equal(recent.savedFrom, '2026-08-18');
  assert.equal(recent.savedTo, '');
  assert.equal(recent.recentPreset, true);
  const manual = QueryState.applyForm(recent, { savedFrom: '2026-08-20', savedTo: '2026-08-31' });
  assert.equal(manual.recentPreset, false);
});

test('structural selections toggle and remain mutually exclusive without clearing facets', function () {
  const filtered = QueryState.applyForm(QueryState.emptyFilters(), { visibility: 'private', tag: 'art' });
  const parentFolder = QueryState.selectStructure(filtered, 'folder_descendants', 4, 'Research');
  assert.deepEqual({
    folder: parentFolder.folderId, descendants: parentFolder.folderIncludeDescendants,
    group: parentFolder.urlGroupId, visibility: parentFolder.visibility, tag: parentFolder.tag
  }, {
    folder: '4', descendants: true, group: '', visibility: 'private', tag: 'art'
  });
  assert.equal(QueryState.entryScopeQuery({ filters: parentFolder }).include_descendants, true);
  const folder = QueryState.selectStructure(parentFolder, 'folder', 4, 'Research');
  assert.equal(folder.folderIncludeDescendants, false);
  const group = QueryState.selectStructure(folder, 'url_group', 'example.test/path', 'Example path');
  assert.deepEqual({ folder: group.folderId, group: group.urlGroupId, visibility: group.visibility }, {
    folder: '', group: 'example.test/path', visibility: 'private'
  });
  assert.equal(QueryState.selectStructure(group, 'url_group', 'example.test/path').urlGroupId, '');
});

test('query mapping is explicit and clear all preserves non-filter app state by omission', function () {
  const filters = QueryState.applyForm(QueryState.emptyFilters(), {
    sourceDomain: 'example.test', visibility: 'private', folderId: '7', tag: 'reference', savedFrom: '2026-08-18'
  });
  const query = QueryState.entryQuery({ filters, search: 'needle', sort: 'title_asc', view: 'feed', page: 2, pageSize: 8 });
  assert.deepEqual({
    search: query.search, sort: query.sort, preview: query.preview, source: query.source_domain,
    visibility: query.visibility, folder: query.folder_id, tag: query.tag, savedFrom: query.saved_from,
    page: query.page, pageSize: query.page_size
  }, {
    search: 'needle', sort: 'title_asc', preview: 'with', source: 'example.test', visibility: 'private',
    folder: '7', tag: 'reference', savedFrom: '2026-08-18', page: 2, pageSize: 8
  });
  assert.deepEqual(QueryState.emptyFilters(), {
    preview: '', kind: '', sourceDomain: '', visibility: '', folderId: '', folderLabel: '',
    folderIncludeDescendants: false, tag: '', savedFrom: '', savedTo: '',
    urlGroupId: '', urlGroupLabel: '', recentPreset: false
  });
  assert.deepEqual(QueryState.defaultFilters(), {
    preview: '', kind: '', sourceDomain: '', visibility: 'normal', folderId: '', folderLabel: '',
    folderIncludeDescendants: false, tag: '', savedFrom: '', savedTo: '',
    urlGroupId: '', urlGroupLabel: '', recentPreset: false
  });
  const scope = QueryState.entryScopeQuery({ filters, search: 'needle', sort: 'title_asc', view: 'feed', page: 2, pageSize: 8 });
  assert.deepEqual(scope, {
    search: 'needle', preview: 'with', kind: undefined, source_domain: 'example.test', visibility: 'private',
    folder_id: '7', include_descendants: undefined, tag: 'reference',
    saved_from: '2026-08-18', saved_to: undefined, url_group_id: undefined
  });
  assert.equal('sort' in scope || 'page' in scope || 'page_size' in scope, false);
  assert.equal(QueryState.entryScopeQuery({ filters: QueryState.emptyFilters(), search: '' }).search, undefined);
});

test('content type chips use human labels instead of storage keys', function () {
  const filters = QueryState.applyForm(QueryState.emptyFilters(), { kind: 'image' });
  assert.deepEqual(QueryState.activeItems(filters, 'grid'), [{ key: 'kind', label: 'Content type: Image' }]);
});

test('location state defaults to Normal and round-trips the active retrieval without losing unrelated parameters', function () {
  const defaults = QueryState.readLocation(new URLSearchParams(), { view: 'list' });
  assert.equal(defaults.filters.visibility, 'normal');
  assert.equal(defaults.view, 'list');
  assert.equal(QueryState.readLocation(new URLSearchParams('visibility=unexpected')).filters.visibility, 'normal');

  const filters = QueryState.applyForm(QueryState.emptyFilters(), {
    preview: 'with', kind: 'research', sourceDomain: 'example.test', visibility: '', folderId: '4',
    folderLabel: 'Reading', folderIncludeDescendants: true, tag: 'reference',
    savedFrom: '2026-08-01', savedTo: '2026-08-31'
  });
  const url = QueryState.writeLocation('http://127.0.0.1:3042/?entry=9&connect=test', {
    search: 'needle', filters, sort: 'title_asc', view: 'grid', page: 3
  });
  assert.equal(url.searchParams.get('entry'), '9');
  assert.equal(url.searchParams.get('connect'), 'test');
  assert.equal(url.searchParams.get('visibility'), 'any');
  assert.equal(url.searchParams.get('folder_descendants'), '1');
  const restored = QueryState.readLocation(url.searchParams);
  assert.deepEqual(restored, {
    search: 'needle', filters, sort: 'title_asc', view: 'grid', page: 3
  });
  assert.equal(QueryState.readLocation(new URLSearchParams('sort=title')).sort, 'title_asc');
  ['newest', 'oldest', 'updated_desc', 'updated_asc', 'title_asc', 'title_desc', 'source_asc', 'source_desc'].forEach(function roundTrip(sort) {
    const sortUrl = QueryState.writeLocation('http://127.0.0.1:3042/', { filters, sort, view: 'grid', page: 1 });
    assert.equal(QueryState.readLocation(sortUrl.searchParams).sort, sort);
  });
});
