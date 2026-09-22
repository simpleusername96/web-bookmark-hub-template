"use strict";

const net = require("node:net");
const { isPublicAddress } = require("../server/public-network.js");
const { RegistryError } = require("../registry/errors.js");
const { requireTemplate, matchTemplate } = require("./templates.js");
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const FIELD_KEYS = Object.freeze(["title", "image_url", "price", "author", "published_at"]);

function missingFields(fields, value) {
  const expected = requireTemplate(value).category === "community" ? ["title", "image_url", "author", "published_at"] : ["title", "image_url", "price"];
  return expected.filter((key) => !(key in fields));
}

function text(value, max = 1000) {
  if (typeof value !== "string") return "";
  return value.replace(/&(?:amp|quot|apos|lt|gt|nbsp);|&#(?:x[0-9a-f]+|\d+);/gi, (entity) => {
    const names = { "&amp;": "&", "&quot;": '"', "&apos;": "'", "&lt;": "<", "&gt;": ">", "&nbsp;": " " };
    if (names[entity.toLowerCase()]) return names[entity.toLowerCase()];
    const hex = entity.toLowerCase().startsWith("&#x");
    const n = Number.parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "";
  }).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function attributes(tag) {
  const out = Object.create(null);
  const pattern = /([^\s=<>/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s<>]+))/g;
  for (const m of tag.matchAll(pattern)) out[m[1].toLowerCase()] = text(m[2] ?? m[3] ?? m[4], 8192);
  return out;
}

function imageUrl(value, base) {
  if (typeof value !== "string" || value.length > 4096) return null;
  try {
    const u = new URL(value, base);
    const h = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (u.protocol !== "https:" || u.username || u.password || u.port || !h.includes(".") || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(h)) return null;
    if (net.isIP(h) && !isPublicAddress(h)) return null;
    return u.href;
  } catch { return null; }
}

function normalizePrice(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const amount = String(value.amount ?? value.price ?? "");
  const currency = String(value.currency ?? value.priceCurrency ?? "").toUpperCase();
  if (!/^(?:0|[1-9]\d{0,11})(?:\.\d{1,4})?$/.test(amount) || !/^[A-Z]{3}$/.test(currency)) return null;
  return { amount, currency, qualifier: value.qualifier === "from" ? "from" : "exact" };
}

function normalizeFields(input, base) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new RegistryError("ENRICH_INVALID_FIELDS", "Expected a bounded field object.");
  if (Object.keys(input).some((key) => !FIELD_KEYS.includes(key))) throw new RegistryError("ENRICH_INVALID_FIELDS", "Unknown enrichment field.");
  const out = {};
  for (const key of ["title", "author"]) {
    const value = text(input[key], key === "title" ? 1000 : 160);
    if (value) out[key] = value;
  }
  const image = imageUrl(input.image_url, base);
  if (image) out.image_url = image;
  const price = normalizePrice(input.price);
  if (price) out.price = price;
  // Require an explicit timezone. Do not reinterpret a Korean local timestamp as UTC.
  if (typeof input.published_at === "string" && /(?:Z|[+-]\d\d:\d\d)$/i.test(input.published_at)) {
    const d = new Date(input.published_at);
    if (Number.isFinite(d.getTime())) out.published_at = d.toISOString();
  }
  return out;
}

function extractPage(html, value) {
  if (typeof html !== "string" || Buffer.byteLength(html) > MAX_HTML_BYTES) throw new RegistryError("ENRICH_TOO_LARGE", "Page exceeds the HTML limit.");
  const template = requireTemplate(value), warnings = [], sources = {}, fields = {};
  html = html.replace(/<!--[\s\S]*?-->/g, "");
  const markup = html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "");
  const titleTag = text(markup.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] || "");
  if (/access denied|attention required|just a moment|verify (?:you are|you're) human|robot check|로그인(?:\s*[:|\-]|$)|접근.{0,12}(?:제한|차단)/i.test(titleTag) || /id=["'](?:cf-chl-widget|challenge-form|captcha-form)["']/i.test(html)) {
    throw new RegistryError("ENRICH_ACCESS_REQUIRED", "A login or challenge page was returned; use an explicitly authorized browser workflow.");
  }
  const meta = Object.create(null);
  const metadataHtml = markup.match(/<head\b[^>]*>([\s\S]*?)<\/head\s*>/i)?.[1] || markup;
  for (const m of metadataHtml.matchAll(/<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)) {
    const a = attributes(m[0]), key = (a.property || a.name || a.itemprop || "").toLowerCase();
    if (key && a.content && meta[key] === undefined) meta[key] = a.content;
  }
  const nodes = [];
  function visit(v, depth = 0) {
    if (!v || typeof v !== "object" || depth > 16 || nodes.length >= 256) return;
    if (Array.isArray(v)) { for (const child of v) visit(child, depth + 1); return; }
    if (v["@type"]) nodes.push(v);
    for (const key of ["@graph", "mainEntity", "itemListElement", "item"]) visit(v[key], depth + 1);
  }
  let count = 0;
  for (const m of html.matchAll(/<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (attributes(m[1]).type?.toLowerCase() !== "application/ld+json") continue;
    if (++count > 16) { warnings.push("structured_data_limit"); break; }
    try { visit(JSON.parse(m[2])); } catch { warnings.push("invalid_json_ld"); }
  }
  const wanted = template.category === "community" ? ["DiscussionForumPosting", "Article", "BlogPosting", "SocialMediaPosting"] : ["Product", "VideoGame", "SoftwareApplication"];
  const candidates = nodes.filter((node) => [node["@type"]].flat().some((type) => wanted.includes(String(type).replace(/^https?:\/\/schema.org\//, ""))));
  const matching = candidates.filter((node) => {
    const declaredUrl = node.url || node["@id"];
    if (!declaredUrl) return false;
    try { return matchTemplate(new URL(declaredUrl, value).href)?.objectKey === template.objectKey; } catch { return false; }
  });
  const only = candidates.length === 1 ? candidates[0] : null;
  const declared = only && (only.url || only['@id']);
  const explicitlyDifferent = Boolean(declared && !matching.length);
  if (explicitlyDifferent) warnings.push("unverified_entity_url");
  const entity = matching.length === 1 ? matching[0] : only && !explicitlyDifferent ? only : null;
  if (candidates.length > 1 && !entity) warnings.push("ambiguous_entity");
  function put(key, raw, source) {
    if (raw === undefined || raw === null || raw === "" || fields[key] !== undefined) return;
    const normalized = normalizeFields({ [key]: raw }, value);
    if (normalized[key] === undefined) { warnings.push(`invalid_${key}`); return; }
    fields[key] = normalized[key]; sources[key] = source;
  }
  if (entity) {
    put("title", entity.name || entity.headline, "json-ld:name/headline");
    const image = Array.isArray(entity.image) ? entity.image[0] : entity.image;
    put("image_url", typeof image === "object" ? image?.url || image?.contentUrl : image, "json-ld:image");
    const author = Array.isArray(entity.author) ? entity.author[0] : entity.author;
    put("author", typeof author === "object" ? author?.name : author, "json-ld:author");
    put("published_at", entity.datePublished, "json-ld:datePublished");
    const offers = entity.offers ? [entity.offers].flat() : [];
    const optionSelected = new URL(value).searchParams.has("vendorItemId") || new URL(value).searchParams.has("itemId");
    const eligible = optionSelected ? offers.filter((offer) => {
      try { return offer.url && matchTemplate(new URL(offer.url, value).href)?.objectKey === template.objectKey; } catch { return false; }
    }) : offers;
    if (eligible.length === 1) {
      const offer = eligible[0];
      put("price", normalizePrice({ price: offer.price ?? offer.lowPrice, priceCurrency: offer.priceCurrency, qualifier: offer.price === undefined ? "from" : "exact" }), "json-ld:offers");
    } else if (offers.length) warnings.push(optionSelected ? "option_price_unverified" : "ambiguous_offers");
  }
  for (const key of ["og:title", "twitter:title"]) put("title", meta[key], `meta:${key}`);
  for (const key of ["og:image:secure_url", "og:image", "twitter:image"]) put("image_url", meta[key], `meta:${key}`);
  put("author", meta.author || meta["article:author"], "meta:author");
  put("published_at", meta["article:published_time"], "meta:published_time");
  // Meta prices are page-scoped, but are not proof of a selected Coupang variant.
  if (!warnings.includes("ambiguous_offers") && !warnings.includes("ambiguous_entity") && !new URL(value).searchParams.has("vendorItemId") && !new URL(value).searchParams.has("itemId")) {
    put("price", normalizePrice({ price: meta["product:price:amount"] || meta["price"], priceCurrency: meta["product:price:currency"] || meta["pricecurrency"] }), "meta:price");
  }
  if (template.id === "dcinside") {
    put("title", text(markup.match(/<span\b[^>]*class=["'][^"']*\btitle_subject\b[^"']*["'][^>]*>([^<]*)/i)?.[1]), "dcinside:title_subject");
    put("author", attributes(markup.match(/<[^>]*\bdata-nick\s*=[^>]*>/i)?.[0] || "")["data-nick"], "dcinside:data-nick");
  }
  put("title", text(markup.match(/<h1\b[^>]*>([^<]*)<\/h1>/i)?.[1]), "html:h1");
  put("title", titleTag, "html:title");
  const normalized = normalizeFields(fields, value);
  for (const key of Object.keys(fields)) if (!(key in normalized)) warnings.push(`invalid_${key}`);
  return { template_id: template.id, template_version: template.version, category: template.category,
    fields: normalized, sources: Object.fromEntries(Object.keys(normalized).map((key) => [key, sources[key]])),
    missing: missingFields(normalized, value), warnings: [...new Set(warnings)] };
}

module.exports = { FIELD_KEYS, MAX_HTML_BYTES, attributes, extractPage, imageUrl, missingFields, normalizeFields, normalizePrice, text };
