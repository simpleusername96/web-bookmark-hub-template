"use strict";

const { matchTemplate } = require("./templates.js");
const { youtubeVideoId } = require("../registry/provider-thumbnails.js");

function domain(host, base) {
  return host === base || host.endsWith("." + base);
}

function routeEvidence(value) {
  const url = new URL(value);
  const host = url.hostname.toLowerCase().replace(/\.$/u, "");
  const path = url.pathname;
  const x = domain(host, "x.com") || domain(host, "twitter.com");
  const status = x && /^\/([^/]+)\/status\/(\d+)(?:\/(?:photo|video)\/\d+)?\/?$/u.exec(path);
  if (status) return { kind: "x_post", itemKey: status[2], fetchUrl: url.href };

  if (domain(host, "arxiv.org")) {
    const paper = /^\/(?:abs|pdf)\/(\d{4}\.\d{4,5}|[a-z.-]+\/\d{7})(?:v\d+)?(?:\.pdf)?\/?$/iu.exec(path);
    if (paper) return { kind: "arxiv", itemKey: paper[1], fetchUrl: new URL("/abs/" + paper[1], url).href };
  }

  const product = matchTemplate(url.href);
  if (product?.category === "shopping") {
    return { kind: "product", itemKey: product.objectKey, fetchUrl: url.href };
  }

  if (youtubeVideoId(url.href)) {
    return { kind: "youtube", itemKey: youtubeVideoId(url.href), fetchUrl: url.href };
  }

  if (domain(host, "chatgpt.com") || domain(host, "chat.openai.com") || domain(host, "gemini.google.com")) {
    const publicShare = /^\/share\/[^/]+\/?$/u.test(path);
    return { kind: publicShare ? "chat_share" : "chat_private", itemKey: publicShare ? path : null, fetchUrl: url.href };
  }

  if (
    (domain(host, "threads.net") && /^\/@[^/]+\/post\/[^/]+\/?$/u.test(path)) ||
    (domain(host, "bsky.app") && /^\/profile\/[^/]+\/post\/[^/]+\/?$/u.test(path)) ||
    (domain(host, "reddit.com") && /^\/r\/[^/]+\/comments\/[^/]+(?:\/[^/]*)?\/?$/u.test(path))
  ) return { kind: "social_post", itemKey: path, fetchUrl: url.href };

  return { kind: "generic", itemKey: null, fetchUrl: url.href };
}

module.exports = { routeEvidence };
