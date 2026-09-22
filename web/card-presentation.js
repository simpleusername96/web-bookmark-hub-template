(function exposeCardPresentation(root, factory) {
  const detailPresentation = typeof module === 'object' && module.exports
    ? require('./detail-presentation.js')
    : root.WBHDetailPresentation;
  const contentTypes = typeof module === 'object' && module.exports
    ? require('./content-types.js')
    : root.WBHContentTypes;
  const api = factory(detailPresentation, contentTypes);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WBHCardPresentation = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function cardPresentationFactory(detailPresentation, contentTypes) {
  'use strict';

  const LIMITS = Object.freeze({ title: 80, summary: 700, tags: 3 });

  function boundedText(value, limit) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (text.length <= limit) return text;
    return text.slice(0, Math.max(0, limit - 1)).trimEnd() + '…';
  }

  function comparablePointer(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(text) ? text : 'https://' + text;
    try {
      const parsed = new URL(candidate);
      if (!['http:', 'https:'].includes(parsed.protocol)) return '';
      const host = parsed.hostname.replace(/^www\./i, '').toLowerCase() + (parsed.port ? ':' + parsed.port : '');
      const path = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, '');
      return host + path + parsed.search + parsed.hash;
    } catch (_error) {
      return '';
    }
  }

  function presentationTitle(entry, url) {
    const origin = entry?.title_origin;
    const authored = !origin || origin === 'user' || origin === 'ai';
    const title = boundedText(authored && entry?.title, LIMITS.title);
    const titlePointer = comparablePointer(title);
    if (!titlePointer) return title;
    const destinations = [url, entry && entry.url_canonical].map(comparablePointer).filter(Boolean);
    return destinations.includes(titlePointer) ? '' : title;
  }

  function presentationTags(entry) {
    if (!Array.isArray(entry && entry.tags)) return Object.freeze([]);
    return Object.freeze(entry.tags.slice(0, LIMITS.tags).map(function copyTag(tag) {
      const name = typeof tag === 'string' ? tag : tag && (tag.name || tag.normalized_name);
      return boundedText(name, 48);
    }).filter(Boolean));
  }

  function describe(entry) {
    const value = entry && typeof entry === 'object' ? entry : {};
    const summary = boundedText(value.latest_summary && value.latest_summary.text, LIMITS.summary);
    const hasCover = detailPresentation.hasRenderableCover(value);
    const state = hasCover ? 'cover' : summary ? 'summary' : 'type';
    const url = String(value.url_original || value.url_canonical || '').trim();
    return Object.freeze({
      state,
      hasCover,
      title: presentationTitle(value, url),
      summary: state === 'summary' ? summary : '',
      fallbackState: summary ? 'summary' : 'type',
      fallbackSummary: summary,
      typeLabel: contentTypes.label(value.kind || 'page'),
      url,
      isPrivate: value.visibility === 'private',
      tags: presentationTags(value)
    });
  }

  function enrichmentFields(entry) {
    const data = entry?.typed_metadata?.enrichment;
    return data?.schema_version === 1 && data.source_url === entry.url_original && data.fields && typeof data.fields === 'object' ? data.fields : {};
  }

  function enrichmentFacts(entry) {
    const fields = enrichmentFields(entry), facts = [];
    const price = fields.price;
    if (price?.value && /^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/.test(String(price.value.amount)) && /^[A-Z]{3}$/.test(price.value.currency || '')) {
      const value = price.value;
      let amount;
      try { amount = new Intl.NumberFormat(undefined, { style: 'currency', currency: value.currency, maximumFractionDigits: 4 }).format(Number(value.amount)); }
      catch (_error) { amount = value.amount + ' ' + value.currency; }
      facts.push({ key: value.qualifier === 'from' ? 'enrichment.priceFrom' : 'enrichment.price', value: amount, observedAt: price.observed_at, stale: price.stale === true });
    }
    if (typeof fields.author?.value === 'string') facts.push({ key: 'enrichment.author', value: boundedText(fields.author.value, 160), stale: fields.author.stale === true });
    if (typeof fields.published_at?.value === 'string' && Number.isFinite(Date.parse(fields.published_at.value))) facts.push({ key: 'enrichment.published', value: new Date(fields.published_at.value).toLocaleString(), stale: fields.published_at.stale === true });
    return facts;
  }

  return { LIMITS, boundedText, comparablePointer, describe, enrichmentFields, enrichmentFacts };
}));
