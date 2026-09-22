(function exposeDetailPresentation(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WBHDetailPresentation = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function detailPresentationFactory() {
  'use strict';

  const GROUPS = Object.freeze({
    article: 'text',
    post: 'text',
    page: 'text',
    image: 'visual',
    video: 'timed-media',
    research: 'research',
    code: 'code'
  });

  function groupForKind(kind) {
    return GROUPS[kind] || 'text';
  }

  function hasRenderableCover(entry) {
    const cover = entry?.cover_image;
    if (!cover || typeof cover !== 'object') return false;
    if (cover.storage_kind === 'local') {
      return cover.status === 'ready' && Number.isSafeInteger(Number(cover.id)) && Number(cover.id) > 0;
    }
    if (cover.storage_kind !== 'remote') return false;
    if (cover.status !== 'referenced') return false;
    try {
      const url = new URL(String(cover.source_url || ''));
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
    } catch (_error) {
      return false;
    }
  }

  function describe(entry) {
    const value = entry && typeof entry === 'object' ? entry : {};
    const hasCover = hasRenderableCover(value);
    const hasUrl = Boolean(value.url_original || value.url_canonical);
    return Object.freeze({
      group: groupForKind(value.kind),
      lead: hasCover ? 'cover' : 'identity',
      hasCover,
      displayTitle: value.title || (hasUrl ? '' : 'Untitled entry')
    });
  }

  return { GROUPS, describe, groupForKind, hasRenderableCover };
}));
