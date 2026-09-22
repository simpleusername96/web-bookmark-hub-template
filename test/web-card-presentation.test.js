'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const CardPresentation = require('../web/card-presentation.js');
const UiLanguage = require('../web/ui-language.js');

function base(overrides) {
  return Object.assign({
    id: 1,
    kind: 'article',
    url_original: 'https://example.test/long-path',
    title: null,
    visibility: 'normal',
    tags: []
  }, overrides || {});
}

test('card state priority is renderable cover, stored summary, then type tile', function () {
  assert.equal(CardPresentation.describe(base({
    content_focus: 'text',
    cover_image: { id: 2, storage_kind: 'local', status: 'ready' },
    latest_summary: { text: 'Stored summary' }
  })).state, 'cover');
  assert.equal(CardPresentation.describe(base({
    latest_summary: { text: 'Stored summary' }
  })).state, 'summary');
  assert.equal(CardPresentation.describe(base()).state, 'type');
});

test('broken and unsafe covers fall through without hiding a valid summary', function () {
  assert.equal(CardPresentation.describe(base({
    cover_image: { id: 2, storage_kind: 'local', status: 'error' },
    latest_summary: { text: 'Readable fallback' }
  })).state, 'summary');
  assert.equal(CardPresentation.describe(base({
    cover_image: { storage_kind: 'remote', status: 'referenced', source_url: 'data:image/png;base64,a' }
  })).state, 'type');
  assert.equal(CardPresentation.describe(base({
    cover_image: { storage_kind: 'remote', status: 'referenced', source_url: 'https://images.example.test/a.jpg' }
  })).state, 'cover');
});

test('presentation bounds text, copies tags, preserves the destination URL, and does not mutate input', function () {
  const longKorean = '아주 긴 한국어 요약 '.repeat(100);
  const longUrl = 'https://example.test/' + 'segment/'.repeat(40) + '?source=original';
  const entry = base({
    title: '제목 '.repeat(100),
    url_original: longUrl,
    visibility: 'private',
    tags: [{ name: '연구' }, { name: '읽기' }, { name: '긴 태그' }, { name: '숨김' }],
    latest_summary: { text: longKorean }
  });
  const before = structuredClone(entry);
  const result = CardPresentation.describe(entry);
  assert.equal(result.state, 'summary');
  assert.equal(result.url, longUrl);
  assert.ok(result.title.length <= CardPresentation.LIMITS.title);
  assert.ok(result.summary.length <= CardPresentation.LIMITS.summary);
  assert.deepEqual(result.tags, ['연구', '읽기', '긴 태그']);
  assert.equal(result.isPrivate, true);
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(entry, before);
});

test('missing title, tags, and summary remain empty while Code keeps its clear type label', function () {
  assert.deepEqual(CardPresentation.describe(base({ kind: 'code', tags: null })), {
    state: 'type',
    fallbackState: 'type',
    fallbackSummary: '',
    hasCover: false,
    title: '',
    summary: '',
    typeLabel: 'Code',
    url: 'https://example.test/long-path',
    isPrivate: false,
    tags: []
  });
});

test('a cover keeps a deterministic text fallback for a failed image request', function () {
  const withSummary = CardPresentation.describe(base({
    cover_image: { id: 2, storage_kind: 'local', status: 'ready' },
    latest_summary: { text: 'Stored summary' }
  }));
  assert.equal(withSummary.state, 'cover');
  assert.equal(withSummary.fallbackState, 'summary');
  assert.equal(withSummary.fallbackSummary, 'Stored summary');

  const withoutSummary = CardPresentation.describe(base({
    cover_image: { id: 2, storage_kind: 'local', status: 'ready' }
  }));
  assert.equal(withoutSummary.fallbackState, 'type');
  assert.equal(withoutSummary.fallbackSummary, '');
});

test('a title that merely repeats the destination stays out of the card', function () {
  const presentation = CardPresentation.describe(base({
    title: 'arxiv.org/pdf/2508.05629v2',
    url_original: 'https://arxiv.org/pdf/2508.05629v2',
    url_canonical: 'https://arxiv.org/pdf/2508.05629v2'
  }));
  assert.equal(presentation.title, '');
  assert.equal(presentation.url, 'https://arxiv.org/pdf/2508.05629v2');

  const authored = CardPresentation.describe(base({ title: 'Readable research title' }));
  assert.equal(authored.title, 'Readable research title');
});

test('only user or AI title origin appears as a card heading', function () {
  assert.equal(CardPresentation.describe(base({ title: 'Browser tab heading', title_origin: 'page' })).title, '');
  assert.equal(CardPresentation.describe(base({ title: 'Image alt text', title_origin: 'capture_caption' })).title, '');
  assert.equal(CardPresentation.describe(base({ title: 'AI-authored work', title_origin: 'ai' })).title, 'AI-authored work');
  assert.equal(CardPresentation.describe(base({ title: 'User entry', title_origin: 'user' })).title, 'User entry');
});

test('localized surrounding labels do not translate canonical card vocabulary', function () {
  try {
    UiLanguage.setLanguage('ko');
    assert.equal(UiLanguage.text('results.column.title'), 'Title');
    assert.equal(UiLanguage.text('results.column.tags'), 'Tags');
    assert.equal(CardPresentation.describe(base({ kind: 'code' })).typeLabel, 'Code');
  } finally {
    UiLanguage.setLanguage('en');
  }
});
