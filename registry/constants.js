'use strict';

const ENTRY_KINDS = Object.freeze([
  'page',
  'article',
  'post',
  'research',
  'code',
  'image',
  'video',
]);

const ENTRY_KIND_ALIASES = Object.freeze({
  social: 'post',
  conversation: 'post',
  animation: 'image',
});

function canonicalEntryKind(value) {
  const normalized = String(value || '').trim().toLocaleLowerCase('en-US');
  return ENTRY_KIND_ALIASES[normalized] || normalized;
}

const VISIBILITIES = Object.freeze(['normal', 'private']);
const AGENT_ACCESS_LEVELS = Object.freeze(['blocked', 'metadata_only', 'allowed']);
const AI_PROCESSING_MODES = Object.freeze(['disabled', 'manual', 'enabled']);
const CONTENT_FOCUS_VALUES = Object.freeze(['text', 'visual']);
const DEFAULT_CONTENT_FOCUS = 'text';
const ENTRY_CREATION_CHANNELS = Object.freeze(['legacy', 'cli', 'web', 'chrome', 'manifest_import']);

const SUMMARY_MODEL = 'gpt-6-luna';
const SUMMARY_REASONING_EFFORT = 'max';

const DEFAULT_POLICY = Object.freeze({
  visibility: 'private',
  agent_access: 'blocked',
  ai_processing: 'disabled',
});

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

module.exports = {
  ENTRY_KINDS,
  ENTRY_KIND_ALIASES,
  canonicalEntryKind,
  VISIBILITIES,
  AGENT_ACCESS_LEVELS,
  AI_PROCESSING_MODES,
  CONTENT_FOCUS_VALUES,
  DEFAULT_CONTENT_FOCUS,
  ENTRY_CREATION_CHANNELS,
  SUMMARY_MODEL,
  SUMMARY_REASONING_EFFORT,
  DEFAULT_POLICY,
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
};
