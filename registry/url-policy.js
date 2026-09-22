'use strict';

const { ENTRY_KINDS, canonicalEntryKind } = require('./constants');
const { registryError } = require('./errors');

const TRACKING_PARAMETER = /^(utm_.*|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid)$/i;
const DIRECT_ANIMATION_EXTENSION = /\.(?:gif|apng)$/i;
const DIRECT_IMAGE_EXTENSION = /\.(?:avif|jpe?g|png|svg|webp)$/i;

function normalizeSourceDomain(hostname) {
  const normalized = String(hostname || '').trim().toLowerCase().replace(/\.$/, '');
  return normalized.startsWith('www.') ? normalized.slice(4) : normalized;
}

function hostnameFrom(value) {
  if (value instanceof URL) return value.hostname;
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    return new URL(text).hostname;
  } catch {
    return text.replace(/^\[|\]$/g, '').split('/')[0].split(':')[0];
  }
}

function domainIs(hostname, domain) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function deriveProvider(value) {
  const hostname = normalizeSourceDomain(hostnameFrom(value));
  if (domainIs(hostname, 'youtube.com') || hostname === 'youtu.be') return 'youtube';
  if (domainIs(hostname, 'x.com') || domainIs(hostname, 'twitter.com')) return 'x';
  if (domainIs(hostname, 'pinterest.com')) return 'pinterest';
  if (domainIs(hostname, 'chatgpt.com') || domainIs(hostname, 'chat.openai.com')) return 'chatgpt';
  if (domainIs(hostname, 'github.com')) return 'github';
  return 'generic-web';
}

function deriveKind(url, provider = deriveProvider(url)) {
  const pathname = url instanceof URL ? url.pathname : new URL(url).pathname;
  const hostname = normalizeSourceDomain(hostnameFrom(url));
  if (DIRECT_ANIMATION_EXTENSION.test(pathname)) return 'image';
  if (DIRECT_IMAGE_EXTENSION.test(pathname)) return 'image';
  if (/\.pdf$/i.test(pathname) || /(^|\/)papers?(\/|$)/i.test(pathname) ||
      domainIs(hostname, 'arxiv.org') || domainIs(hostname, 'doi.org')) return 'research';
  if (/(^|\/)(?:articles?|blogs?|news|tutorials?)(\/|$)/i.test(pathname)) return 'article';
  if (provider === 'youtube') return 'video';
  if (provider === 'github') {
    return pathname.split('/').filter(Boolean).length >= 2 ? 'code' : 'page';
  }
  if (provider === 'chatgpt') {
    return /^\/(?:c|share)\//i.test(pathname) ? 'post' : 'page';
  }
  if (provider === 'x' || ['threads.net', 'reddit.com', 'bsky.app']
    .some((domain) => domainIs(hostname, domain))) return 'post';
  if (provider === 'pinterest') return 'image';
  return 'page';
}

function validateKind(kind) {
  const canonical = canonicalEntryKind(kind);
  if (!ENTRY_KINDS.includes(canonical)) {
    throw registryError('INVALID_KIND', `Unsupported entry kind: ${kind}.`, { kind });
  }
  return canonical;
}

function canonicalizeUrl(rawUrl) {
  const parsed = parseUrl(rawUrl);
  parsed.hash = '';
  for (const key of [...parsed.searchParams.keys()]) {
    if (isTrackingParameter(key)) parsed.searchParams.delete(key);
  }
  parsed.searchParams.sort();
  return parsed.toString();
}

function deriveCreatorHandle(value, provider = deriveProvider(value)) {
  const parsed = value instanceof URL ? value : parseUrl(value);
  const segments = parsed.pathname.split('/').filter(Boolean);
  let candidate = null;
  if (provider === 'x' && segments.length >= 3 && segments[1] === 'status' && /^\d+$/.test(segments[2])) {
    candidate = segments[0];

  }
  if (!candidate || /^(?:accounts|direct|explore|home|i|intent|legal|login|notifications|search|settings|stories)$/i.test(candidate)) {
    return null;
  }
  try {
    return decodeURIComponent(candidate);
  } catch {
    return null;
  }
}

function isTrackingParameter(value) {
  return TRACKING_PARAMETER.test(String(value || ''));
}

function parseUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    throw registryError('INVALID_URL', 'A non-empty HTTP(S) URL is required.');
  }
  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw registryError('INVALID_URL', 'A valid HTTP(S) URL is required.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw registryError('INVALID_URL_SCHEME', 'Only HTTP(S) URLs are supported.', { protocol: parsed.protocol });
  }
  if (parsed.username || parsed.password) {
    throw registryError('URL_CREDENTIALS_NOT_ALLOWED', 'URLs with embedded credentials are not allowed.');
  }
  return parsed;
}

function analyzeUrl(rawUrl, { kindOverride } = {}) {
  const url_original = typeof rawUrl === 'string' ? rawUrl.trim() : rawUrl;
  const parsed = parseUrl(rawUrl);
  const provider = deriveProvider(parsed);
  const source_domain = normalizeSourceDomain(parsed.hostname);
  const kind = kindOverride === undefined || kindOverride === null
    ? deriveKind(parsed, provider)
    : validateKind(kindOverride);
  return {
    url_original,
    url_canonical: canonicalizeUrl(url_original),
    provider,
    source_domain,
    creator_handle: deriveCreatorHandle(parsed, provider),
    kind,
    kind_source: kindOverride === undefined || kindOverride === null ? 'derived' : 'user',
  };
}

module.exports = {
  analyzeUrl,
  canonicalizeUrl,
  deriveCreatorHandle,
  deriveProvider,
  deriveKind,
  isTrackingParameter,
  normalizeSourceDomain,
  validateKind,
};
