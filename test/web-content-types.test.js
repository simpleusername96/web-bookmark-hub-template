"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { ENTRY_KINDS } = require("../registry/constants.js");
const ContentTypes = require("../web/content-types.js");
const DetailPresentation = require("../web/detail-presentation.js");

test("Web content-type labels cover the Registry kind contract exactly once", () => {
  assert.deepEqual(ContentTypes.TYPES.map((type) => type.value), ENTRY_KINDS);
  assert.equal(new Set(ContentTypes.TYPES.map((type) => type.value)).size, ENTRY_KINDS.length);
  assert.equal(ContentTypes.label("animation"), "Image");
  assert.equal(ContentTypes.label("social"), "Post / Thread");
  assert.equal(ContentTypes.label("conversation"), "Post / Thread");
  assert.deepEqual(ContentTypes.optionPairs().at(0), ["page", "Web page"]);
});

test("detail presentation derives five groups and makes any valid cover the lead without mutation", () => {
  const expected = {
    page: "text", article: "text", post: "text", research: "research",
    code: "code", image: "visual", video: "timed-media"
  };
  assert.deepEqual(Object.fromEntries(ENTRY_KINDS.map((kind) => [kind, DetailPresentation.groupForKind(kind)])), expected);

  const entry = {
    kind: "research",
    content_focus: "text",
    url_original: "https://arxiv.org/abs/1234.5678",
    cover_image: { storage_kind: "remote", status: "referenced", source_url: "https://images.test/paper.png" }
  };
  const before = JSON.stringify(entry);
  assert.deepEqual(DetailPresentation.describe(entry), {
    group: "research",
    lead: "cover",
    hasCover: true,
    displayTitle: ""
  });
  assert.equal(JSON.stringify(entry), before);
  assert.deepEqual(DetailPresentation.describe({ kind: "video", title: "Talk", content_focus: "visual" }), {
    group: "timed-media",
    lead: "identity",
    hasCover: false,
    displayTitle: "Talk"
  });
  assert.equal(DetailPresentation.describe({ kind: "image", url_original: "https://images.test/post" }).displayTitle, "");
  assert.equal(DetailPresentation.describe({ kind: "image" }).displayTitle, "Untitled entry");
  assert.equal(DetailPresentation.hasRenderableCover({ cover_image: { storage_kind: "remote", source_url: "data:image/png;base64,a" } }), false);
  assert.equal(DetailPresentation.hasRenderableCover({ cover_image: { id: 3, storage_kind: "local", status: "ready" } }), true);
});
