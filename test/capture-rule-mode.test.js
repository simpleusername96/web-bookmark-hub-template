"use strict";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const test = require("node:test");
const { openRegistry } = require("../registry/database.js");
const { captureEntries } = require("../registry/captures.js");
const { getEntry } = require("../registry/entries.js");
const { createRule, updateRule } = require("../server/capture-policy-api.js");
const { createCapturePolicyRule, resolveCapturePolicy, previewCapturePolicyRule, applyCapturePolicyRule } = require("../registry/capture-policy.js");

function fixture(t) {
  const registry = openRegistry({ dbPath: ":memory:" });
  t.after(() => registry.close());
  return registry;
}

function rule(registry, mode, changes = {}) {
  return createRule(registry, {
    url_prefix: "https://x.com/", capture_mode: mode, kind: "post",
    visibility: mode === "selected_images" ? "private" : "normal",
    ...changes
  });
}

function save(registry, url, assets = [], changes = {}, adapter = assets.length ? "x-media" : "current-tab") {
  const result = captureEntries(registry, {
    channel: "chrome", requesterScope: "chrome:test", clientRequestId: randomUUID(), adapter,
    items: [{ entryUrl: url, assetUrls: assets, ...changes }]
  });
  assert.ok(result.items[0].entry_id, JSON.stringify(result));
  return getEntry(registry, result.items[0].entry_id);
}

function policy(entry) { return [entry.kind, entry.visibility, entry.agent_access, entry.ai_processing]; }

test("same-site UI/API rules split selected images from ordinary posts without hardcoded X defaults", (t) => {
  const registry = fixture(t);
  const beforeRules = save(registry, "https://x.com/synthetic/status/1");
  assert.deepEqual(policy(beforeRules), ["post", "private", "blocked", "disabled"]);
  const images = rule(registry, "selected_images");
  const pages = rule(registry, "page");
  assert.notEqual(images.id, pages.id);
  assert.equal(images.capture_mode, "selected_images");
  const selected = save(registry, "https://x.com/synthetic/status/2", ["https://images.example.test/selected.jpg"]);
  const post = save(registry, "https://x.com/synthetic/status/3");
  assert.deepEqual(policy(selected), ["post", "private", "blocked", "disabled"]);
  assert.deepEqual(policy(post), ["post", "normal", "allowed", "enabled"]);
  const generic = save(registry, "https://x.com/synthetic/status/4", ["https://images.example.test/other.jpg"], {}, "generic");
  assert.deepEqual(policy(generic), policy(selected));
  assert.deepEqual(policy(save(registry, "https://elsewhere.example.test/post/1")), ["page", "private", "blocked", "disabled"]);
  const overridden = save(registry, "https://x.com/synthetic/status/5", ["https://images.example.test/explicit.jpg"], {
    kind: "image", visibility: "normal"
  });
  assert.deepEqual(policy(overridden), ["image", "normal", "allowed", "enabled"]);
  assert.deepEqual(policy(save(registry, selected.url_original)), policy(selected));
  assert.deepEqual(policy(save(registry, post.url_original, ["https://images.example.test/later.jpg"])), policy(post));
});

test("specific save method wins at equal depth while deeper rules and explicit overrides retain priority", (t) => {
  const registry = fixture(t);
  const all = rule(registry, "all", { kind: "article", tags: ["fallback"] });
  const selected = rule(registry, "selected_images", { tags: ["visual"] });
  const url = "https://x.com/synthetic/status/20";
  assert.equal(resolveCapturePolicy(registry, url).rule_id, all.id);
  const selectedPolicy = resolveCapturePolicy(registry, url, {}, "selected_images");
  assert.equal(selectedPolicy.rule_id, selected.id);
  assert.deepEqual(selectedPolicy.defaultTags, ["visual"]);
  updateRule(registry, selected.id, { enabled: false });
  assert.equal(resolveCapturePolicy(registry, url, {}, "selected_images").rule_id, all.id);
  updateRule(registry, selected.id, { enabled: true });
  const deep = rule(registry, "all", { url_prefix: "https://x.com/synthetic" });
  assert.equal(resolveCapturePolicy(registry, url, {}, "selected_images").rule_id, deep.id);
  assert.equal(resolveCapturePolicy(registry, "https://x.com/synthetic2/status/20", {}, "selected_images").rule_id, selected.id);
});

test("rule API validates modes and preserves them during unrelated edits", (t) => {
  const registry = fixture(t);
  const saved = rule(registry, "selected_images", { tags: ["keep"] });
  assert.equal(updateRule(registry, saved.id, { visibility: "normal" }).capture_mode, "selected_images");
  assert.equal(updateRule(registry, saved.id, { capture_mode: "page" }).capture_mode, "page");
  assert.throws(() => rule(registry, "page"), { code: "CAPTURE_POLICY_RULE_CONFLICT" });
  rule(registry, "selected_images");
  rule(registry, "all");
  for (const value of ["invalid", null, 1]) {
    assert.throws(() => rule(registry, value), { code: "VALIDATION_ERROR" });
    assert.throws(() => updateRule(registry, saved.id, { capture_mode: value }), { code: "VALIDATION_ERROR" });
  }
  const legacy = createCapturePolicyRule(registry, { hostname: "legacy.example.test" });
  assert.equal(legacy.capture_mode, "all");
});

test("preview/apply respects selected-image evidence, including removed images and later selections", (t) => {
  const registry = fixture(t);
  const image = save(registry, "https://x.com/synthetic/status/30", ["https://images.example.test/selected.jpg"]);
  const post = save(registry, "https://x.com/synthetic/status/31");
  const laterImage = save(registry, "https://x.com/synthetic/status/32");
  save(registry, laterImage.url_original, ["https://images.example.test/later.jpg"]);
  registry.db.prepare("DELETE FROM entry_visual_assets WHERE entry_id = ?").run(image.id);
  const images = rule(registry, "selected_images");
  const pages = rule(registry, "page");
  assert.deepEqual(previewCapturePolicyRule(registry, images.id).entry_ids, [image.id, laterImage.id]);
  assert.deepEqual(previewCapturePolicyRule(registry, pages.id).entry_ids, [post.id]);
  applyCapturePolicyRule(registry, pages.id);
  assert.deepEqual(policy(getEntry(registry, post.id)), ["post", "normal", "allowed", "enabled"]);
  assert.deepEqual(policy(getEntry(registry, image.id)), ["post", "private", "blocked", "disabled"]);
  applyCapturePolicyRule(registry, images.id);
  assert.deepEqual(policy(getEntry(registry, image.id)), ["post", "private", "blocked", "disabled"]);
});

test("automatic provider thumbnails count as URL saves, not image selection", (t) => {
  const registry = fixture(t);
  rule(registry, "selected_images", { url_prefix: "https://youtube.com/", kind: "image" });
  const pageRule = rule(registry, "page", { url_prefix: "https://youtube.com/", kind: "video" });
  const entry = save(registry, "https://youtube.com/watch?v=abcdefghijk");
  assert.deepEqual(policy(entry), ["video", "normal", "allowed", "enabled"]);
  assert.deepEqual(previewCapturePolicyRule(registry, pageRule.id).entry_ids, [entry.id]);
});
