"use strict";

const { RegistryError } = require("../registry/errors.js");
const { routeEvidence } = require("./evidence-route.js");
const { extractPage } = require("./extract.js");
const {
  isConnectionFailure,
  requestPinned,
  resolvePublicAddresses
} = require("../server/public-network.js");

const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_PDF_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 20_000;

async function fetchPublicEvidence(value, options = {}) {
  const initialUrl = publicUrl(value);
  const route = routeEvidence(initialUrl.href);
  if (route.kind === "chat_private") {
    throw new RegistryError("AI_EVIDENCE_ACCESS_REQUIRED", "Private conversation is not a public share.");
  }
  const now = options.now || Date.now;
  const context = {
    deadline: now() + positiveInteger(options.timeoutMs, REQUEST_TIMEOUT_MS),
    lookup: options.lookup,
    now,
    request: options.request || requestPinned
  };
  let url = publicUrl(route.fetchUrl);
  let response;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      options.beforeRequest?.();
      const addresses = await withinDeadline(resolvePublicAddresses(url.hostname, context.lookup), context);
      response = await requestFromPublicAddress(url, addresses, context);
      const statusCode = Number(response.statusCode || 0);
      const header = (name) => firstHeader(response.headers?.[name]);
      if ([301, 302, 303, 307, 308].includes(statusCode)) {
        const location = header("location");
        response.resume?.();
        if (!location || hop === MAX_REDIRECTS) {
          throw new RegistryError("AI_EVIDENCE_REDIRECT_LIMIT", "Page redirect limit was reached.");
        }
        const next = publicUrl(new URL(location, url).href);
        if (url.protocol === "https:" && next.protocol !== "https:") {
          throw new RegistryError("AI_EVIDENCE_REDIRECT_INVALID", "HTTPS downgrade was refused.");
        }
        url = next;
        continue;
      }
      if (statusCode !== 200) {
        response.resume?.();
        throw new RegistryError(
          statusCode === 429 ? "AI_EVIDENCE_RATE_LIMITED"
            : [401, 403].includes(statusCode) ? "AI_EVIDENCE_ACCESS_REQUIRED"
              : [404, 410].includes(statusCode) ? "AI_EVIDENCE_NOT_FOUND"
                : "AI_EVIDENCE_HTTP_ERROR",
          "Page retrieval failed.",
          { httpStatus: statusCode }
        );
      }
      const contentType = header("content-type");
      const isHtml = /^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(contentType);
      const isPdf = /^application\/pdf(?:;|$)/i.test(contentType);
      if (!isHtml && !isPdf) {
        response.resume?.();
        throw new RegistryError("AI_EVIDENCE_NOT_HTML", "Page response is neither HTML nor PDF.");
      }
      if (header("content-encoding") && header("content-encoding") !== "identity") {
        response.resume?.();
        throw new RegistryError("AI_EVIDENCE_ENCODING", "Unexpected compressed page response.");
      }
      const maxBytes = isPdf ? MAX_PDF_BYTES : MAX_HTML_BYTES;
      if (Number(header("content-length")) > maxBytes) {
        response.resume?.();
        throw new RegistryError("AI_EVIDENCE_TOO_LARGE", "Page response exceeds the size limit.");
      }
      const buffer = await readBoundedBody(response, context, maxBytes);
      if (isPdf) {
        if (buffer.subarray(0, 5).toString("ascii") !== "%PDF-") {
          throw new RegistryError("AI_EVIDENCE_PDF_INVALID", "Page response is not a valid PDF.");
        }
        options.beforeRequest?.();
        return {
          kind: "pdf", content_source: "pdf_first_page", sufficient: true,
          title: null, description: null, content: null, image_url: null,
          media_kind: "none", media_expected: false, pdf_bytes: buffer
        };
      }
      const charset = header("content-type").match(/charset=["']?([\w-]+)/i)?.[1]
        || buffer.subarray(0, 4096).toString("ascii").match(/charset\s*=\s*["']?([\w-]+)/i)?.[1]
        || "utf-8";
      let html;
      try {
        html = new TextDecoder(charset, { fatal: true }).decode(buffer);
      } catch {
        throw new RegistryError("AI_EVIDENCE_ENCODING", "Page encoding is unsupported or invalid.");
      }
      options.beforeRequest?.();
      return extractPublicEvidence(html, url.href, route);
    }
  } catch (error) {
    response?.destroy?.();
    if (error instanceof RegistryError && error.code.startsWith("AI_EVIDENCE_")) throw error;
    if (error?.code === "CAPTURE_IMAGE_ADDRESS_BLOCKED") {
      throw new RegistryError("AI_EVIDENCE_ADDRESS_BLOCKED", "Non-public network destination was refused.");
    }
    throw new RegistryError("AI_EVIDENCE_NETWORK", "Page network request failed.");
  }
  throw new RegistryError("AI_EVIDENCE_NETWORK", "Page network request failed.");
}

function extractPublicEvidence(htmlValue, pageUrl, requestedRoute = routeEvidence(pageUrl)) {
  const html = String(htmlValue || "");
  const route = requestedRoute;
  const markup = html.replace(/<(?:script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/(?:script|style|noscript|svg)\s*>/gi, " ");
  const meta = new Map();
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    const key = attribute(tag, "property") || attribute(tag, "name");
    const content = attribute(tag, "content");
    if (key && content !== null && !meta.has(key.toLocaleLowerCase("en-US"))) {
      meta.set(key.toLocaleLowerCase("en-US"), decodeHtml(content));
    }
  }
  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const title = boundedText(
    meta.get("og:title") || meta.get("twitter:title") || decodeHtml(stripTags(titleTag || "")),
    1000
  );
  const description = boundedText(
    meta.get("og:description") || meta.get("twitter:description") || meta.get("description"),
    4000
  );
  const declaredUrl = normalizedHttpUrl(meta.get("og:url"), pageUrl);
  const declaredRoute = declaredUrl && routeEvidence(declaredUrl);
  const mismatched = Boolean(declaredRoute && route.itemKey
    && (declaredRoute.kind !== route.kind || declaredRoute.itemKey !== route.itemKey));
  const sameItemMetadata = Boolean(declaredRoute && route.itemKey
    && declaredRoute.kind === route.kind && declaredRoute.itemKey === route.itemKey);
  const article = matchingArticle(markup, route, sameItemMetadata);
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(markup)?.[1] || "";
  const area = route.kind === "x_post" || route.kind === "social_post" ? article
    : route.kind === "chat_share" ? main
      : main || article;
  let content = boundedText(decodeHtml(stripTags(
    (area || "").replace(/<(?:nav|header|footer|aside|form)\b[^>]*>[\s\S]*?<\/(?:nav|header|footer|aside|form)\s*>/gi, " ")
  )), 3000);
  let pageTitle = title || null;
  if (route.kind === "arxiv") {
    const abstract = /<blockquote\b[^>]*class=["'][^"']*\babstract\b[^"']*["'][^>]*>([\s\S]*?)<\/blockquote>/i.exec(markup)?.[1];
    const heading = /<h1\b[^>]*class=["'][^"']*\btitle\b[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i.exec(markup)?.[1];
    content = boundedText(decodeHtml(stripTags(abstract || "")).replace(/^Abstract:\s*/i, ""), 3000);
    pageTitle = boundedText(decodeHtml(stripTags(heading || "")), 1000).replace(/^Title:\s*/i, "") || pageTitle;
  } else if (route.kind === "product") {
    try {
      const product = extractPage(html, pageUrl);
      const variant = new URL(pageUrl).searchParams.has("itemId")
        || new URL(pageUrl).searchParams.has("vendorItemId");
      if (product.warnings.includes("ambiguous_entity") || product.warnings.includes("unverified_entity_url")
        || (variant && product.sources.title !== "json-ld:name/headline")) {
        content = "";
        pageTitle = null;
      } else {
        pageTitle = product.fields.title || pageTitle;
        content = boundedText(description || content, 3000);
      }
    } catch { content = ""; pageTitle = null; }
  } else if (route.kind === "youtube") {
    content = boundedText(description, 3000);
  } else if (route.kind === "x_post" || route.kind === "social_post") {
    content = boundedText(content || description, 3000);
  } else if (route.kind === "generic") {
    content = boundedText(content || description, 3000);
  }
  const itemMedia = firstContentMedia(area, pageUrl);
  const openGraphImage = representativeImage(
    meta.get("og:image:secure_url") || meta.get("og:image"),
    pageUrl
  );
  const twitterImage = representativeImage(
    meta.get("twitter:image") || meta.get("twitter:image:src"),
    pageUrl
  );
  const firstImage = route.kind === "generic" ? firstUsefulImage(area, pageUrl) : null;
  const singlePostPoster = route.kind === "x_post" && !article && sameItemMetadata
    && [...markup.matchAll(/<video\b/gi)].length === 1;
  const singlePostPosterUrl = singlePostPoster
    ? firstTagUrl(markup, "video", "poster", pageUrl) : null;
  const metadataImage = ["x_post", "social_post", "product", "chat_share"].includes(route.kind)
    && !sameItemMetadata ? null : openGraphImage || twitterImage;
  const imageUrl = mismatched ? null : itemMedia?.url || singlePostPosterUrl || metadataImage || firstImage;
  const videoSignals = Boolean(singlePostPosterUrl) || /<video\b/i.test(area)
    || /\/(?:amplify_video_thumb|video_thumb)\//i.test(imageUrl || "")
    || /video|player/i.test(meta.get("og:type") || "")
    || /player/i.test(meta.get("twitter:card") || "");
  const gifSignals = /\.gif(?:$|[?#])/i.test(imageUrl || "") || /image\/gif/i.test(meta.get("og:image:type") || "");
  const genericTitle = /^(?:x|twitter|threads|reddit|youtube|chatgpt|gemini|arxiv)(?:\s*\/\s*.*)?$/i.test(pageTitle || "");
  const profileOnlyMetadata = (route.kind === "x_post" || route.kind === "social_post")
    && !area && Boolean(pageTitle && description)
    && pageTitle.toLocaleLowerCase("en-US") === description.toLocaleLowerCase("en-US");
  const itemSpecific = !["x_post", "social_post", "chat_share"].includes(route.kind)
    || Boolean(article || area || sameItemMetadata);
  const sufficient = !mismatched && !profileOnlyMetadata && itemSpecific
    && Boolean(content || (pageTitle && !genericTitle));
  return {
    kind: route.kind,
    item_key: route.itemKey,
    title: sufficient && !genericTitle ? pageTitle : null,
    description: sufficient ? description || null : null,
    content: sufficient ? content || null : null,
    content_source: content ? (route.kind === "arxiv" ? "abstract" : area ? "page_content" : "page_metadata") : "page_metadata",
    sufficient,
    reason: mismatched ? "AI_EVIDENCE_ITEM_MISMATCH" : sufficient ? null : "AI_EVIDENCE_INSUFFICIENT",
    image_url: imageUrl || null,
    media_kind: videoSignals || itemMedia?.kind === "video" ? "video" : gifSignals ? "gif" : imageUrl ? "image" : "none",
    media_expected: Boolean(videoSignals || gifSignals || imageUrl)
  };
}

function matchingArticle(markup, route, sameItemMetadata) {
  const articles = [...markup.matchAll(/<article\b[^>]*>[\s\S]*?<\/article>/gi)].map((match) => match[0]);
  if (route.kind === "x_post") {
    const matching = articles.filter((article) => new RegExp(`/status/${route.itemKey}(?:[/"'?#]|$)`).test(article));
    return matching.length === 1 ? matching[0] : "";
  }
  if (route.kind === "social_post") {
    const matching = articles.filter((article) => article.includes(route.itemKey));
    return matching.length === 1 ? matching[0] : sameItemMetadata && articles.length === 1 ? articles[0] : "";
  }
  return articles.length === 1 ? articles[0] : "";
}

function firstContentMedia(area, pageUrl) {
  for (const match of area.matchAll(/<(video|img)\b[^>]*>/gi)) {
    const tag = match[0];
    const candidate = normalizedHttpUrl(decodeHtml(attribute(tag, match[1].toLowerCase() === "video" ? "poster" : "src")), pageUrl);
    if (!candidate || /avatar|emoji|favicon|icon|logo|profile_images/i.test(candidate + " " + (attribute(tag, "alt") || "") + " " + (attribute(tag, "class") || ""))) continue;
    return { url: candidate, kind: match[1].toLowerCase() === "video" ? "video" : "image" };
  }
  return null;
}

function representativeImage(value, pageUrl) {
  const candidate = normalizedHttpUrl(value, pageUrl);
  return candidate && !/avatar|emoji|favicon|icon|logo|profile_images/i.test(candidate) ? candidate : null;
}

async function requestFromPublicAddress(url, addresses, context) {
  let lastError;
  for (let index = 0; index < addresses.length; index += 1) {
    try {
      return await withinDeadline(context.request({
        url,
        address: addresses[index].address,
        timeoutMs: remainingMs(context),
        headers: {
          accept: "text/html,application/xhtml+xml",
          "accept-encoding": "identity",
          "user-agent": "Mozilla/5.0 (compatible; WebBookmarkHub/0.3; explicit metadata retrieval)"
        }
      }), context);
    } catch (error) {
      lastError = error;
      if (!isConnectionFailure(error) || index === addresses.length - 1) throw error;
    }
  }
  throw lastError;
}

async function readBoundedBody(response, context, maxBytes) {
  const chunks = [];
  let byteSize = 0;
  await withinDeadline((async () => {
    for await (const rawChunk of response) {
      const chunk = Buffer.from(rawChunk);
      byteSize += chunk.length;
      if (byteSize > maxBytes) {
        response.destroy?.();
        throw new RegistryError("AI_EVIDENCE_TOO_LARGE", "Page response exceeds the size limit.");
      }
      chunks.push(chunk);
    }
  })(), context);
  return Buffer.concat(chunks);
}

function firstTagUrl(html, tagName, attributeName, pageUrl) {
  const expression = new RegExp(`<${tagName}\\b[^>]*>`, "gi");
  for (const match of html.matchAll(expression)) {
    const candidate = normalizedHttpUrl(decodeHtml(attribute(match[0], attributeName)), pageUrl);
    if (candidate) return candidate;
  }
  return null;
}

function firstUsefulImage(html, pageUrl) {
  for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
    const source = decodeHtml(attribute(match[0], "src") || "");
    if (/avatar|emoji|favicon|icon|logo|profile_images/i.test(source)) continue;
    const candidate = normalizedHttpUrl(source, pageUrl);
    if (candidate) return candidate;
  }
  return null;
}

function attribute(tag, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`\\s${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return match ? (match[1] ?? match[2] ?? match[3] ?? "") : null;
}

function normalizedHttpUrl(value, baseUrl) {
  if (!value) return null;
  try {
    const parsed = new URL(String(value).trim(), baseUrl);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    parsed.hash = "";
    return parsed.href;
  } catch {
    return null;
  }
}

function publicUrl(value) {
  const parsed = normalizedHttpUrl(value);
  if (!parsed) throw new RegistryError("AI_EVIDENCE_URL_INVALID", "Entry URL must be credential-free HTTP(S).");
  return new URL(parsed);
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&#(\d+);/g, (_match, digits) => String.fromCodePoint(Number(digits)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, digits) => String.fromCodePoint(Number.parseInt(digits, 16)))
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function stripTags(value) {
  return String(value || "").replace(/<[^>]+>/g, " ");
}

function boundedText(value, maxLength) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, maxLength) : "";
}

function withinDeadline(promise, context) {
  const timeoutMs = remainingMs(context);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(
      new RegistryError("AI_EVIDENCE_TIMEOUT", "Page request timed out.")
    ), timeoutMs);
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

function remainingMs(context) {
  const remaining = Math.ceil(context.deadline - context.now());
  if (remaining < 1) throw new RegistryError("AI_EVIDENCE_TIMEOUT", "Page request timed out.");
  return remaining;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function firstHeader(value) {
  return Array.isArray(value) ? String(value[0] || "") : String(value || "");
}

module.exports = {
  MAX_HTML_BYTES,
  extractPublicEvidence,
  fetchPublicEvidence
};
