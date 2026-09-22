(function exposeContentTypes(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WBHContentTypes = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function contentTypesFactory() {
  'use strict';

  const TYPES = Object.freeze([
    Object.freeze({ value: 'page', label: 'Web page' }),
    Object.freeze({ value: 'article', label: 'Article' }),
    Object.freeze({ value: 'post', label: 'Post / Thread' }),
    Object.freeze({ value: 'research', label: 'Research' }),
    Object.freeze({ value: 'code', label: 'Code' }),
    Object.freeze({ value: 'image', label: 'Image' }),
    Object.freeze({ value: 'video', label: 'Video' })
  ]);

  const LEGACY_ALIASES = Object.freeze({ social: 'post', conversation: 'post', animation: 'image' });

  function label(value) {
    const canonical = LEGACY_ALIASES[value] || value;
    return TYPES.find(function findType(type) { return type.value === canonical; })?.label || value;
  }

  function optionPairs() {
    return TYPES.map(function pair(type) { return [type.value, type.label]; });
  }

  return { LEGACY_ALIASES, TYPES, label, optionPairs };
}));
