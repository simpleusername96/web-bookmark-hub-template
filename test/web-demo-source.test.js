'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var entries = require('../web/demo-data.js');
var createDemoSource = require('../web/demo-source.js');

test('fixtures use only synthetic example.test URLs and source domains', function () {
  assert.equal(entries.length, 24);
  entries.forEach(function (entry) {
    assert.match(entry.url_original, /^https:\/\/[a-z0-9.-]+\.example\.test\//);
    assert.match(entry.source_domain, /(^|\.)example\.test$/);
  });
});

test('listEntries combines search and explicit tag filter without mutating the store', async function () {
  var source = createDemoSource(entries);
  var result = await source.listEntries({ search: 'private', tag: 'privacy', sort: 'title', page: 1, page_size: 10 });
  assert.equal(result.total, 2);
  assert.deepEqual(result.items.map(function (item) { return item.id; }), ['demo-008', 'demo-015']);
  result.items[0].title = 'changed by caller';
  assert.equal((await source.getEntry('demo-008')).title, 'AI boundaries for private links');
});

test('topSourceDomains preserves raw source-domain grouping and deterministic counts', async function () {
  var source = createDemoSource(entries);
  var result = await source.topSourceDomains({ limit: 10, threshold: 4 });
  assert.equal(result.length, 2);
  assert.deepEqual(result.map(function (item) { return item.entry_count; }), [4, 4]);
  assert.deepEqual(result.map(function (item) { return item.source_domain; }), [
    'pinterest.example.test', 'youtube.example.test'
  ]);
});

test('topSourceDomains returns raw keys that source facets can query without display-label loss', async function () {
  var source = createDemoSource(entries);
  var result = await source.topSourceDomains({ limit: 5, threshold: 3 });
  assert.deepEqual(result, [
    { source_domain: 'pinterest.example.test', entry_count: 4 },
    { source_domain: 'youtube.example.test', entry_count: 4 },
    { source_domain: 'arxiv.example.test', entry_count: 3 },
    { source_domain: 'github.example.test', entry_count: 3 },
    { source_domain: 'x.example.test', entry_count: 3 }
  ]);
  var filtered = await source.listEntries({ source_domain: 'github.example.test', page_size: 10 });
  assert.equal(filtered.total, 3);
  assert.deepEqual(filtered.items.map(function (item) { return item.id; }), ['demo-007', 'demo-014', 'demo-021']);
});

test('listEntries paginates deterministically after sorting', async function () {
  var source = createDemoSource(entries);
  var first = await source.listEntries({ sort: 'newest', page: 1, page_size: 3 });
  var second = await source.listEntries({ sort: 'newest', page: 2, page_size: 3 });
  assert.deepEqual(first.items.map(function (item) { return item.id; }), ['demo-001', 'demo-002', 'demo-003']);
  assert.deepEqual(second.items.map(function (item) { return item.id; }), ['demo-004', 'demo-005', 'demo-006']);
  assert.deepEqual(Object.keys(first).sort(), ['items', 'page', 'page_size', 'total', 'total_pages']);
  var withNullableTitle = entries.map(function (entry) { return Object.assign({}, entry); });
  withNullableTitle[0].title = null;
  await assert.doesNotReject(function () {
    return createDemoSource(withNullableTitle).listEntries({ sort: 'title' });
  });
});

test('private and recent filters have fixed, independent behavior', async function () {
  var source = createDemoSource(entries);
  var privateResult = await source.listEntries({ visibility: 'private', page_size: 10 });
  var recentResult = await source.listEntries({ saved_from: '2026-08-14', page_size: 30 });
  assert.deepEqual(privateResult.items.map(function (item) { return item.id; }), ['demo-008', 'demo-015']);
  assert.equal(recentResult.total, 15);
  assert.equal(recentResult.items.at(-1).id, 'demo-015');
});

test('addEntry validates URL schemes and applies private AI-safe defaults', async function () {
  var source = createDemoSource(entries);
  await assert.rejects(function () { return source.addEntry({ url: 'file:///not-allowed' }); }, /http or https/);
  await assert.rejects(function () { return source.addEntry({ url: 'https://user:pass@outside.invalid/a' }); }, /credentials/);
  var outcome = await source.addEntry({ url: 'https://outside.invalid/a#fragment', title: 'New record', tags: ['new tag'] });
  var created = outcome.entry;
  assert.equal(outcome.outcome_code, 'created');
  assert.equal(created.url_canonical, 'https://outside.invalid/a');
  assert.equal(created.visibility, 'private');
  assert.equal(created.agent_access, 'blocked');
  assert.equal(created.ai_processing, 'disabled');
  assert.equal(created.source_domain, 'outside.invalid');
  assert.deepEqual(created.tags, [{ id: 'tag-new-tag', name: 'new tag', normalized_name: 'new tag', added_at: '2026-08-28T12:00:00.000Z' }]);
  var repeated = await source.addEntry({ url: 'https://outside.invalid/a#different', title: 'Must not replace' });
  assert.equal(repeated.outcome_code, 'already_saved');
  assert.equal(repeated.entry.id, created.id);
  assert.equal(repeated.entry.title, 'New record');
  var normal = await source.addEntry({ url: 'https://normal.example.test/item', visibility: 'normal' });
  assert.equal(normal.entry.visibility, 'normal');
});

test('tag normalization preserves Unicode names and registry-shaped timestamps', async function () {
  var source = createDemoSource(entries);
  var created = (await source.addEntry({ url: 'https://tags.example.test/item', tags: ['  연구   자료  ', '연구 자료'] })).entry;
  assert.equal(created.tags.length, 1);
  assert.equal(created.tags[0].name, '연구 자료');
  assert.equal(created.tags[0].normalized_name, '연구 자료');
  assert.equal(created.tags[0].added_at, created.saved_at);
  var filtered = await source.listEntries({ tag: '연구 자료' });
  assert.equal(filtered.total, 1);
  var topTags = await source.topTags({ limit: 20 });
  assert.equal(topTags.find(function (tag) { return tag.normalized_name === '연구 자료'; }).entry_count, 1);
  assert.deepEqual((await source.suggestTags({ query: '연구', exclude: [], limit: 8 })).map(function (tag) { return tag.normalized_name; }), ['연구 자료']);
  var empty = await source.listEntries({ search: 'does-not-exist', page: 4, page_size: 8 });
  assert.equal(empty.page, 1);
  assert.equal(empty.total_pages, 0);
});

test('comments append in order and do not expose mutable internal state', async function () {
  var source = createDemoSource(entries);
  var first = await source.addComment('demo-001', 'First note');
  var second = await source.addComment('demo-001', 'Second note');
  assert.notEqual(first.id, second.id);
  var comments = await source.listComments('demo-001', { page: 1, page_size: 1 });
  assert.deepEqual(comments.items.map(function (comment) { return comment.body; }), ['First note']);
  assert.deepEqual({ page: comments.page, page_size: comments.page_size, total: comments.total, total_pages: comments.total_pages }, { page: 1, page_size: 1, total: 2, total_pages: 2 });
  comments.items[0].body = 'mutated';
  assert.equal((await source.listComments('demo-001')).items[0].body, 'First note');
  assert.equal((await source.getEntry('demo-001')).comment_count, 2);
});

test('preview filtering and expanded sorts match the production query contract', async function () {
  var fixtures = [
    Object.assign({}, entries[0], {
      id: 'preview-zulu',
      title: 'Zulu',
      source_domain: 'zulu.example.test',
      record_updated_at: '2026-08-01T00:00:00.000Z',
      cover_image: { storage_kind: 'remote', status: 'referenced', source_url: 'https://cdn.example.test/zulu.jpg' }
    }),
    Object.assign({}, entries[1], {
      id: 'preview-alpha',
      title: 'Alpha',
      source_domain: 'alpha.example.test',
      record_updated_at: '2026-08-03T00:00:00.000Z',
      cover_image: { storage_kind: 'local', status: 'ready', storage_path: 'synthetic/alpha.jpg' }
    }),
    Object.assign({}, entries[2], {
      id: 'preview-error',
      title: 'Middle',
      source_domain: 'middle.example.test',
      record_updated_at: '2026-08-02T00:00:00.000Z',
      content_focus: 'visual',
      cover_image: { storage_kind: 'local', status: 'error', storage_path: 'synthetic/error.jpg' }
    })
  ];
  var source = createDemoSource(fixtures);
  assert.deepEqual((await source.listEntries({ preview: 'with', sort: 'source_asc' })).items.map(function (item) { return item.id; }), ['preview-alpha', 'preview-zulu']);
  assert.deepEqual((await source.listEntries({ preview: 'without' })).items.map(function (item) { return item.id; }), ['preview-error']);
  assert.deepEqual((await source.listEntries({ sort: 'title_desc' })).items.map(function (item) { return item.id; }), ['preview-zulu', 'preview-error', 'preview-alpha']);
  assert.deepEqual((await source.listEntries({ sort: 'updated_desc' })).items.map(function (item) { return item.id; }), ['preview-alpha', 'preview-error', 'preview-zulu']);
  assert.deepEqual((await source.listEntries({ sort: 'updated_asc' })).items.map(function (item) { return item.id; }), ['preview-zulu', 'preview-error', 'preview-alpha']);
  assert.deepEqual((await source.listEntries({ sort: 'source_desc' })).items.map(function (item) { return item.id; }), ['preview-zulu', 'preview-error', 'preview-alpha']);
});

test('composable retrieval filters combine source, kind, visibility, tag, and saved dates', async function () {
  var source = createDemoSource(entries);
  var result = await source.listEntries({
    kind: 'article',
    source_domain: 'journal.example.test',
    visibility: 'normal',
    tag: 'research',
    saved_from: '2026-08-01',
    saved_to: '2026-08-31',
    sort: 'source_asc',
    page_size: 30
  });
  assert.deepEqual(result.items.map(function (item) { return item.id; }), ['demo-009', 'demo-002']);
});

test('single and batch delete permanently remove synthetic Entries', async function () {
  var source = createDemoSource(entries);
  var single = await source.deleteEntry('demo-001');
  assert.equal(single.deleted, 1);
  assert.equal(await source.getEntry('demo-001'), null);
  var batch = await source.batchEntries({ entry_ids: ['demo-002', 'demo-003'], operation: 'delete', value: {} });
  assert.deepEqual([batch.matched, batch.changed], [2, 2]);
  assert.equal((await source.listEntries({ page_size: 30 })).total, 21);
});

test('query batch applies to every synthetic result and rejects a stale count', async function () {
  var source = createDemoSource(entries);
  var before = await source.listEntries({ search: 'private', page_size: 30 });
  var snapshot = await source.selectionSnapshot({ search: 'private' });
  var result = await source.batchEntries({
    query: { search: 'private' },
    expected_count: before.total,
    expected_digest: snapshot.expected_digest,
    operation: 'set_kind',
    value: { kind: 'research' }
  });
  assert.deepEqual([result.matched, result.changed], [before.total, before.total]);
  assert.equal((await source.listEntries({ search: 'private', kind: 'research', page_size: 30 })).total, before.total);
  await assert.rejects(source.batchEntries({
    query: { search: 'private' },
    expected_count: before.total - 1,
    expected_digest: snapshot.expected_digest,
    operation: 'set_policy',
    value: { visibility: 'private' }
  }), /result set changed/i);
});

test('query batch rejects a same-count result set whose opaque identities changed', async function () {
  var source = createDemoSource(entries);
  var before = await source.listEntries({ search: 'private', page_size: 30 });
  var snapshot = await source.selectionSnapshot({ search: 'private' });
  await source.deleteEntry(before.items[0].id);
  await source.addEntry({ url: 'https://replacement.example.test/item', title: 'Private replacement' });
  var after = await source.listEntries({ search: 'private', page_size: 30 });
  assert.equal(after.total, before.total);
  await assert.rejects(source.batchEntries({
    query: { search: 'private' },
    expected_count: snapshot.expected_count,
    expected_digest: snapshot.expected_digest,
    operation: 'set_kind',
    value: { kind: 'research' }
  }), /result set changed/i);
});
