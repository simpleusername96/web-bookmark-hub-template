"use strict";

const { canonicalizeUrl } = require("../registry/url-policy.js");
const { RegistryError } = require("../registry/errors.js");

// Each matcher identifies ONE saved object, not a search/list page. Query values
// that select a product variant are part of its identity, never tracking noise.
const TEMPLATES = Object.freeze([
  { id: "naver", category: "shopping", kind: "page", version: 2,
    match(u) {
      if (["smartstore.naver.com", "brand.naver.com"].includes(u.hostname)) {
        return u.pathname.match(/^\/([^/]+)\/products\/(\d+)\/?$/)?.slice(1).join("/");
      }
      if (["shopping.naver.com", "search.shopping.naver.com"].includes(u.hostname)) {
        return u.pathname.match(/^\/catalog\/(\d+)\/?$/)?.[1];
      }
    } },
  { id: "coupang", category: "shopping", kind: "page", version: 2,
    match(u) {
      if (!["coupang.com", "www.coupang.com", "m.coupang.com"].includes(u.hostname)) return;
      const id = u.pathname.match(/^\/vp\/products\/(\d+)\/?$/)?.[1];
      return id && [id, u.searchParams.get("itemId") || "", u.searchParams.get("vendorItemId") || ""].join("/");
    } },
  { id: "dcinside", category: "community", kind: "post", version: 2,
    match(u) {
      if (u.hostname === "gall.dcinside.com" && /^\/(?:mgallery\/|mini\/)?board\/view\/?$/.test(u.pathname)) {
        const id = u.searchParams.get("id"), no = u.searchParams.get("no");
        if (id && /^\d+$/.test(no || "")) return `${id}/${no}`;
      }
      if (u.hostname === "m.dcinside.com") return u.pathname.match(/^\/board\/([^/]+)\/(\d+)\/?$/)?.slice(1).join("/");
    } },
  { id: "fmkorea", category: "community", kind: "post", version: 2,
    match(u) {
      if (!["fmkorea.com", "www.fmkorea.com", "m.fmkorea.com"].includes(u.hostname)) return;
      if (["/", "/index.php"].includes(u.pathname) && /^\d+$/.test(u.searchParams.get("document_srl") || "")) return u.searchParams.get("document_srl");
      return u.pathname.match(/^\/(?:[A-Za-z_][\w-]*\/)?(\d+)\/?$/)?.[1];
    } },
  { id: "steam", category: "game", kind: "page", version: 2,
    match(u) {
      if (u.hostname !== "store.steampowered.com") return;
      const id = u.pathname.match(/^\/app\/(\d+)(?:\/[^/]*)?\/?$/)?.[1];
      return id && `${id}/${u.searchParams.get("cc") || ""}/${u.searchParams.get("l") || ""}`;
    } },
  { id: "itch", category: "game", kind: "page", version: 2,
    match(u) {
      if (!/^[a-z0-9-]+\.itch\.io$/.test(u.hostname) || u.hostname === "www.itch.io") return;
      const slug = u.pathname.match(/^\/([^/]+)\/?$/)?.[1];
      if (slug && !["profile", "games", "devlog", "dashboard", "login"].includes(slug)) return `${u.hostname}/${slug}`;
    } }
]);

function matchTemplate(value) {
  let url;
  try { url = new URL(canonicalizeUrl(value)); } catch { return null; }
  if (url.port && url.port !== "443" && url.port !== "80") return null;
  for (const template of TEMPLATES) {
    const key = template.match(url);
    if (key) return { ...template, objectKey: `${template.id}:${key}`, url: url.href };
  }
  return null;
}

function requireTemplate(value) {
  const template = matchTemplate(value);
  if (!template) throw new RegistryError("ENRICH_UNSUPPORTED_URL", "Use a supported detail URL; open short links in your browser first.");
  return template;
}

module.exports = { TEMPLATES, matchTemplate, requireTemplate };
