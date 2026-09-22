'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const UiLanguage = require('../web/ui-language.js');

test('Web language switches actions while canonical product nouns stay English', function () {
  UiLanguage.setLanguage('en');
  assert.equal(UiLanguage.text('action.saveUrl'), 'Save URL');
  assert.equal(UiLanguage.text('action.addNote'), 'Add Note');
  assert.equal(UiLanguage.text('rule.mode.selected_images'), 'Image selection');

  UiLanguage.setLanguage('ko');
  assert.equal(UiLanguage.text('action.saveUrl'), 'URL 저장');
  assert.equal(UiLanguage.text('action.addNote'), 'Note 추가');
  assert.equal(UiLanguage.text('rule.saveMethod'), '저장 방식');
  assert.equal(UiLanguage.text('rule.mode.all'), '모든 저장');
  assert.equal(UiLanguage.text('rule.mode.page'), '일반 URL 저장');
  assert.equal(UiLanguage.text('rule.mode.selected_images'), '이미지 선택 저장');
  assert.equal(UiLanguage.text('action.setContentType'), 'Content type 변경');
  assert.equal(UiLanguage.text('confirm.removeVisualReference'), '이 이미지 참조를 제거할까요?');
  assert.equal(UiLanguage.text('results.listCaption'), '저장된 Entry입니다. 클릭하거나 Space를 눌러 선택을 바꾸고, 두 번 클릭하거나 Enter를 눌러 상세 정보를 엽니다.');
  assert.equal(UiLanguage.text('results.column.title'), 'Title');
  assert.equal(UiLanguage.text('results.column.tags'), 'Tags');
  assert.equal(UiLanguage.text('placeholder.commaSeparated'), '쉼표로 구분');
  assert.equal(UiLanguage.text('status.saved'), '저장됨');
  assert.equal(UiLanguage.text('status.dateUnknown'), '날짜를 알 수 없음');

  UiLanguage.setLanguage('en');
  assert.equal(UiLanguage.text('confirm.removeVisualReference'), 'Remove this visual reference?');
  assert.equal(UiLanguage.text('results.page', { page: 3 }), 'Page 3');
  assert.equal(UiLanguage.text('settings.renameFolder', { name: 'Research' }), 'Rename Research');
});

test('Web language falls back safely and persists a supported choice', function () {
  const previousStorage = globalThis.localStorage;
  const writes = [];
  globalThis.localStorage = { setItem(key, value) { writes.push([key, value]); } };
  try {
    assert.equal(UiLanguage.setLanguage('ko'), 'ko');
    assert.deepEqual(writes.at(-1), [UiLanguage.STORAGE_KEY, 'ko']);
    assert.equal(UiLanguage.setLanguage('unsupported'), 'en');
    assert.equal(UiLanguage.text('missing.key'), 'missing.key');
  } finally {
    UiLanguage.setLanguage('en');
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
  }
});
