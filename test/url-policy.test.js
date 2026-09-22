'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  analyzeUrl,
  canonicalizeUrl,
  deriveKind,
  deriveCreatorHandle,
  deriveProvider,
  normalizeSourceDomain,
  validateKind,
} = require('../registry/url-policy');

test('analyzeUrl preserves the trimmed original and derives canonical metadata', () => {
  const result = analyzeUrl('  https://www.example.test/path?b=2&utm_source=test&a=1#section  ');
  assert.deepEqual(result, {
    url_original: 'https://www.example.test/path?b=2&utm_source=test&a=1#section',
    url_canonical: 'https://www.example.test/path?a=1&b=2',
    provider: 'generic-web',
    source_domain: 'example.test',
    creator_handle: null,
    kind: 'page',
    kind_source: 'derived',
  });
});

test('canonicalization drops only tracking parameters and sorts keys', () => {
  assert.equal(
    canonicalizeUrl('https://example.test/a?z=last&GCLID=discard&a=first&a=second'),
    'https://example.test/a?a=first&a=second&z=last',
  );
});

test('provider classification uses the hostname only', () => {
  assert.equal(deriveProvider('source.example.test'), 'generic-web');
  assert.equal(deriveProvider('source.example.test/path'), 'generic-web');
  assert.equal(normalizeSourceDomain('WWW.Example.Test.'), 'example.test');
});

test('unsafe or unsupported URLs and kinds have stable errors', () => {
  assert.throws(() => analyzeUrl('file:///tmp/a'), { code: 'INVALID_URL_SCHEME' });
  assert.throws(() => analyzeUrl('https://user:secret@example.test/a'), { code: 'URL_CREDENTIALS_NOT_ALLOWED' });
  assert.throws(() => validateKind('unknown'), { code: 'INVALID_KIND' });
  assert.throws(() => validateKind('paper'), { code: 'INVALID_KIND' });
  assert.equal(JSON.stringify(captureError(() => analyzeUrl('not a url?token=private-value'))).includes('private-value'), false);
});

function captureError(callback) {
  try {
    callback();
  } catch (error) {
    return error;
  }
  return null;
}
