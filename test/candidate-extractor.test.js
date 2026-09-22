"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const Contract = require("../extension/capture-contract.js");
const Extractor = require("../extension/candidate-extractor.js");

test("template cards expose each image and video poster as an independently selectable candidate", () => {
  const image = node({ tagName: "IMG", currentSrc: "https://cdn.example.test/a.jpg", alt: "Artwork" });
  const video = node({ tagName: "VIDEO", poster: "https://cdn.example.test/poster.jpg" });
  const date = node({ attributes: { datetime: "2026-08-01T00:00:00Z" } });
  const host = node({ queries: { img: [image], video: [video], "img[alt]": [image], "time[datetime]": [date] } });
  const first = node({ tagName: "A", href: "https://social.example.test/p/42/?utm=one", closest: { article: host } });
  const duplicate = node({ tagName: "A", href: "https://social.example.test/p/42/?utm=two", closest: { article: host } });
  const documentRef = documentWith({ "a[href*='/p/']": [first, duplicate] });
  const profile = {
    id: "social-posts",
    hostSuffixes: ["social.example.test"],
    gridPathRegex: /^\/artist\/?$/,
    detailPathRegex: /^\/p\/\d+\/?$/,
    cardSelectors: ["a[href*='/p/']"],
    cardContainerSelectors: ["article"],
    cardTitleSelectors: ["img[alt]"],
    cardDateSelectors: ["time[datetime]"],
    cardMediaSelectors: ["img", "video"]
  };
  const extractor = Extractor.createCandidateExtractor({
    documentRef,
    windowRef: windowAt("https://social.example.test/artist"),
    contract: Contract,
    profiles: [profile]
  });

  const records = extractor.scan();
  assert.equal(records.length, 2);
  assert.equal(records[0].host, image);
  assert.equal(records[1].host, video);
  assert.equal(records[0].candidate.entryUrl, first.href);
  assert.equal(Object.hasOwn(records[0].candidate, "title"), false);
  assert.equal(records[0].candidate.publishedAt, "2026-08-01T00:00:00.000Z");
  assert.deepEqual(records.map((record) => record.candidate.assetUrls), [
    ["https://cdn.example.test/a.jpg"],
    ["https://cdn.example.test/poster.jpg"]
  ]);
});

test("candidate identity keeps each selected asset separate while normalizing template Entry query variants", () => {
  const first = {
    entryUrl: "https://social.example.test/p/42?slide=1",
    title: "Post",
    assetUrls: ["https://cdn.example.test/one.jpg"],
    adapter: "social-posts"
  };
  const next = {
    entryUrl: "https://social.example.test/p/42?slide=2",
    assetUrls: ["https://cdn.example.test/one.jpg", "https://cdn.example.test/two.jpg"],
    adapter: "social-posts"
  };
  assert.equal(
    Extractor.candidateKey(first),
    Extractor.candidateKey({ ...next, assetUrls: ["https://cdn.example.test/one.jpg"] })
  );
  assert.notEqual(
    Extractor.candidateKey(first),
    Extractor.candidateKey({ ...next, assetUrls: ["https://cdn.example.test/two.jpg"] })
  );
  assert.notEqual(
    Extractor.candidateKey({ ...first, adapter: "generic" }),
    Extractor.candidateKey({ ...next, adapter: "generic" })
  );
  assert.deepEqual(Extractor.mergeCandidate(first, next).assetUrls, [
    "https://cdn.example.test/one.jpg",
    "https://cdn.example.test/two.jpg"
  ]);
});

test("generic images sharing one Entry URL remain independently selectable", () => {
  const link = node({ tagName: "A", href: "https://example.test/post/42" });
  const first = node({ tagName: "IMG", currentSrc: "https://cdn.example.test/one.jpg", closest: { "a[href]": link } });
  const second = node({ tagName: "IMG", currentSrc: "https://cdn.example.test/two.jpg", closest: { "a[href]": link } });
  const extractor = Extractor.createCandidateExtractor({
    documentRef: documentWith({ img: [first, second], video: [] }),
    windowRef: windowAt("https://example.test/gallery"),
    contract: Contract,
    profiles: []
  });

  const records = extractor.scan();
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((record) => record.host), [first, second]);
  assert.deepEqual(records.map((record) => record.candidate.assetUrls), [
    ["https://cdn.example.test/one.jpg"],
    ["https://cdn.example.test/two.jpg"]
  ]);
});

test("presence keeps responsive image references without changing the selected image", () => {
  const image = node({
    tagName: "IMG",
    currentSrc: "https://cdn.example.test/large.jpg",
    src: "https://cdn.example.test/original.jpg"
  });
  const extractor = Extractor.createCandidateExtractor({
    documentRef: documentWith({ img: [image], video: [] }),
    windowRef: windowAt("https://example.test/gallery"),
    contract: Contract,
    profiles: []
  });

  const candidate = extractor.scan()[0].candidate;
  assert.deepEqual(candidate.assetUrls, ["https://cdn.example.test/large.jpg"]);
  assert.deepEqual(candidate.presenceAssetUrls, [
    "https://cdn.example.test/large.jpg",
    "https://cdn.example.test/original.jpg"
  ]);
});

test("a known template route waits for logical cards instead of falling back to unrelated page images", () => {
  const unrelated = node({ tagName: "IMG", currentSrc: "https://cdn.example.test/logo.jpg", alt: "Logo" });
  const documentRef = documentWith({ img: [unrelated], video: [] });
  const extractor = Extractor.createCandidateExtractor({
    documentRef,
    windowRef: windowAt("https://social.example.test/artist"),
    contract: Contract,
    profiles: [{
      id: "social-posts",
      hostSuffixes: ["social.example.test"],
      gridPathRegex: /^\/artist\/?$/,
      detailPathRegex: /^\/p\/\d+\/?$/,
      cardSelectors: ["a[href*='/p/']"]
    }]
  });
  assert.deepEqual(extractor.scan(), []);
});

test("X photo and video presentation suffixes normalize to the post while meaningful query is preserved", () => {
  const profile = { id: "x-media" };
  assert.equal(
    Extractor.normalizeTemplateEntryUrl("https://x.com/artist/status/123/photo/2?ref=detail#media", profile),
    "https://x.com/artist/status/123?ref=detail"
  );
  assert.equal(
    Extractor.normalizeTemplateEntryUrl("https://twitter.com/artist/status/123/video/1", profile),
    "https://twitter.com/artist/status/123"
  );
});

function documentWith(queries) {
  return {
    title: "Synthetic social page",
    querySelectorAll(selector) { return queries[selector] || []; },
    querySelector() { return null; }
  };
}

function windowAt(href) {
  const location = new URL(href);
  return {
    location,
    innerHeight: 1000,
    innerWidth: 1400,
    getComputedStyle() { return { display: "block", visibility: "visible", opacity: "1" }; }
  };
}

function node(options = {}) {
  const queries = options.queries || {};
  const closest = options.closest || {};
  const attributes = options.attributes || {};
  return {
    tagName: options.tagName || "DIV",
    href: options.href,
    currentSrc: options.currentSrc,
    src: options.src,
    poster: options.poster,
    alt: options.alt,
    textContent: options.textContent || "",
    matches() { return false; },
    querySelectorAll(selector) { return queries[selector] || []; },
    querySelector() { return null; },
    closest(selector) { return closest[selector] || null; },
    getAttribute(name) { return attributes[name] || null; },
    getBoundingClientRect() { return { top: 10, left: 10, right: 310, bottom: 310, width: 300, height: 300 }; }
  };
}
