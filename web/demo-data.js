(function (root, factory) {
  var entries = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = entries;
  }
  root.WBH_DEMO_ENTRIES = entries;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function tag(name, addedAt) {
    var normalizedName = name.replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-US');
    return { id: 'tag-' + normalizedName.replace(/\s+/g, '-'), name: name, normalized_name: normalizedName, added_at: addedAt };
  }

  function metadata(label, previewTone, note) {
    var value = { label: label, preview_tone: previewTone };
    if (note) value.note = note;
    return value;
  }

  function entry(id, url, title, kind, provider, savedAt, tags, options) {
    var settings = options || {};
    var sourceDomain = new URL(url).hostname;
    return {
      id: id,
      url_original: url,
      url_canonical: url,
      title: title,
      kind: kind,
      kind_source: settings.kind_source || 'manual',
      provider: provider,
      source_domain: sourceDomain,
      typed_metadata: metadata(settings.label || kind, settings.preview_tone || 'paper', settings.note),
      saved_at: savedAt,
      published_at: settings.published_at || null,
      updated_at: settings.updated_at || savedAt,
      visibility: settings.visibility || 'normal',
      agent_access: settings.visibility === 'private' ? 'blocked' : 'allowed',
      ai_processing: settings.visibility === 'private' ? 'disabled' : 'enabled',
      content_focus: settings.content_focus || 'text',
      cover_image: settings.cover_image || null,
      latest_summary: settings.latest_summary || null,
      record_created_at: savedAt,
      record_updated_at: settings.updated_at || savedAt,
      tags: tags.map(function (name) { return tag(name, savedAt); }),
      comment_count: settings.comment_count || 0,
      snapshot_count: settings.snapshot_count || 0,
      summary_job_count: settings.summary_job_count || 0
    };
  }

  return [
    entry('demo-001', 'https://notes.example.test/quiet-index', 'A quiet index for small research notes', 'article', 'generic-web', '2026-08-28T09:00:00.000Z', ['research', 'workflow'], { preview_tone: 'cobalt', published_at: '2026-08-27T00:00:00.000Z', summary_job_count: 1, latest_summary: { id: 'summary-001', text: 'A compact method for keeping useful web pointers searchable without turning the registry into an offline archive.', model: 'gpt-6-luna', reasoning_effort: 'max', created_at: '2026-08-28T10:00:00.000Z' }, note: 'A user note can explain why a pointer is worth keeping without copying the page.' }),
    entry('demo-002', 'https://journal.example.test/field-notes/reading-without-archives', 'Reading without archiving every page', 'article', 'generic-web', '2026-08-27T15:30:00.000Z', ['research', 'privacy'], { preview_tone: 'amber', note: 'Metadata stays useful while the remote page remains the content owner.' }),
    entry('demo-003', 'https://youtube.example.test/watch/slow-tools', 'Slow tools for recurring work', 'video', 'youtube', '2026-08-26T12:00:00.000Z', ['workflow', 'video'], { preview_tone: 'violet', published_at: '2026-08-25T00:00:00.000Z', cover_image: { id: 'cover-003', storage_kind: 'remote', status: 'referenced', source_url: 'https://images.example.test/slow-tools.jpg' }, note: 'Saved for a later review of low-friction recurring workflows.' }),
    entry('demo-004', 'https://pinterest.example.test/sets/blue-shadows', 'Blue shadows and tiled rooms', 'image', 'pinterest', '2026-08-25T10:00:00.000Z', ['visual', 'reference'], { preview_tone: 'blue', content_focus: 'visual', note: 'A visual reference whose content color should remain distinct from the app theme.' }),
    entry('demo-005', 'https://x.example.test/post/structured-notes', 'A thread on structured notes', 'post', 'x', '2026-08-24T14:00:00.000Z', ['workflow', 'social'], { preview_tone: 'coral' }),
    entry('demo-006', 'https://arxiv.example.test/pointer-storage', 'Pointer storage and user intent', 'research', 'generic-web', '2026-08-23T08:00:00.000Z', ['research', 'privacy'], { preview_tone: 'mint', published_at: '2026-08-20T00:00:00.000Z', summary_job_count: 1, latest_summary: { id: 'summary-006', text: 'Pointer-first storage preserves user intent and retrieval metadata while leaving the original research content with its publisher.', model: 'gpt-6-luna', reasoning_effort: 'max', created_at: '2026-08-23T09:00:00.000Z' } }),
    entry('demo-007', 'https://github.example.test/registry-cli', 'A small registry CLI experiment', 'code', 'github', '2026-08-22T16:00:00.000Z', ['code', 'workflow'], { preview_tone: 'ink' }),
    entry('demo-008', 'https://notes.example.test/ai-boundaries', 'AI boundaries for private links', 'page', 'generic-web', '2026-08-21T11:00:00.000Z', ['privacy', 'ai'], { preview_tone: 'rose', visibility: 'private', agent_access: 'blocked', ai_processing: 'disabled' }),
    entry('demo-009', 'https://journal.example.test/field-notes/portable-taxonomy', 'A portable taxonomy for bookmarks', 'article', 'generic-web', '2026-08-20T09:00:00.000Z', ['taxonomy', 'research'], { preview_tone: 'ochre' }),
    entry('demo-010', 'https://youtube.example.test/watch/grid-feed-list', 'Grid, feed, and list as one query', 'video', 'youtube', '2026-08-19T18:00:00.000Z', ['ui', 'video'], { preview_tone: 'violet' }),
    entry('demo-011', 'https://pinterest.example.test/sets/monochrome-interfaces', 'Monochrome interface references', 'image', 'pinterest', '2026-08-18T13:00:00.000Z', ['visual', 'ui'], { preview_tone: 'slate', content_focus: 'visual' }),
    entry('demo-012', 'https://x.example.test/post/fewer-controls', 'Fewer controls, clearer retrieval', 'post', 'x', '2026-08-17T10:00:00.000Z', ['ui', 'social'], { preview_tone: 'coral' }),
    entry('demo-013', 'https://arxiv.example.test/metadata-minimum', 'The minimum useful metadata', 'research', 'generic-web', '2026-08-16T08:30:00.000Z', ['research', 'taxonomy'], { preview_tone: 'mint', summary_job_count: 1 }),
    entry('demo-014', 'https://github.example.test/typed-entry-shapes', 'Typed entry shapes without separate silos', 'code', 'github', '2026-08-15T17:00:00.000Z', ['code', 'taxonomy'], { preview_tone: 'ink' }),
    entry('demo-015', 'https://pinterest.example.test/private-visual-reference', 'Private visual reference queue', 'image', 'pinterest', '2026-08-14T12:00:00.000Z', ['visual', 'privacy'], { preview_tone: 'rose', content_focus: 'visual', visibility: 'private', agent_access: 'blocked', ai_processing: 'disabled' }),
    entry('demo-016', 'https://essay.example.test/focused-dialogs', 'Focused dialogs instead of detail rails', 'article', 'generic-web', '2026-08-12T09:00:00.000Z', ['ui', 'workflow'], { preview_tone: 'amber' }),
    entry('demo-017', 'https://youtube.example.test/watch/brief-capture', 'Brief capture for long reading queues', 'video', 'youtube', '2026-08-10T13:00:00.000Z', ['video', 'workflow'], { preview_tone: 'violet' }),
    entry('demo-018', 'https://pinterest.example.test/sets/poster-typography', 'Poster typography references', 'image', 'pinterest', '2026-08-08T12:00:00.000Z', ['visual', 'reference'], { preview_tone: 'blue', content_focus: 'visual' }),
    entry('demo-019', 'https://x.example.test/post/source-facets', 'Source facets should stay shallow', 'post', 'x', '2026-08-06T12:00:00.000Z', ['social', 'taxonomy'], { preview_tone: 'coral' }),
    entry('demo-020', 'https://arxiv.example.test/source-lifecycle', 'Source and feed item lifecycles', 'research', 'generic-web', '2026-08-04T07:00:00.000Z', ['research', 'rss'], { preview_tone: 'mint' }),
    entry('demo-021', 'https://github.example.test/command-line-search', 'Command line search for an AI-readable index', 'code', 'github', '2026-08-02T16:30:00.000Z', ['code', 'ai'], { preview_tone: 'ink' }),
    entry('demo-022', 'https://chatgpt.example.test/session-links', 'Chat session links worth returning to', 'post', 'chatgpt', '2026-07-31T14:00:00.000Z', ['ai', 'workflow'], { preview_tone: 'cobalt' }),
    entry('demo-023', 'https://blog.example.test/url-first', 'Why URL-first records age well', 'article', 'generic-web', '2026-07-28T09:00:00.000Z', ['research', 'reference'], { preview_tone: 'ochre' }),
    entry('demo-024', 'https://youtube.example.test/watch/rss-as-input', 'RSS as an input, not the product', 'video', 'youtube', '2026-07-25T13:00:00.000Z', ['rss', 'video'], { preview_tone: 'violet' })
  ];
}));
