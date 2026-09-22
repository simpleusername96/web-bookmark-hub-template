"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { openRegistry } = require("../registry/database");
const { addEntry, editEntry, getEntry } = require("../registry/entries");
const {
  addLocalImage, addRemoteImageReference, auditLocalVisualAssets, clearCover, getVisualAsset, listVisualAssets,
  findSavedVisualAssetPresence, removeVisualAsset, resolveVisualAssetPath, setCover
} = require("../registry/visual-assets");
const { MAX_LOCAL_IMAGE_BYTES } = require("../registry/visual-asset-contract.js");
const { MAX_CAPTURE_LOCAL_BYTES, captureDownloadLimit } = require("../server/capture-downloads.js");

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wbh-visual-"));
  const source = path.join(directory, "source.png"); fs.writeFileSync(source, PNG);
  const second = path.join(directory, "second.png"); fs.writeFileSync(second, Buffer.concat([PNG, Buffer.from([1])]));
  const registry = openRegistry({ dbPath: path.join(directory, "data", "registry.sqlite3") });
  const entry = addEntry(registry, { url: "https://example.test/visual", savedAt: "2026-01-01" }).entry;
  return { directory, source, second, registry, entry };
}
function done(x) { x.registry.close(); fs.rmSync(x.directory, { recursive: true, force: true, maxRetries: 3 }); }

test("local and remote visual assets preserve provenance, dedupe, ordering, and cover transitions", async () => {
  const x = setup();
  try {
    const first = await addLocalImage(x.registry, x.entry.id, x.source, { sourceKind: "user_upload" });
    assert.equal(first.duplicate, false); assert.equal(first.asset.is_cover, true); assert.equal(first.asset.position, 0);
    assert.equal(first.asset.storage_kind, "local"); assert.equal(first.asset.source_url, null);
    assert.equal(first.asset.storage_path.startsWith("visual-assets/"), true); assert.equal(fs.existsSync(first.asset.file_path), true);
    assert.equal(getEntry(x.registry, x.entry.id).content_focus, "visual");
    const same = await addLocalImage(x.registry, x.entry.id, x.source);
    assert.equal(same.duplicate, true); assert.equal(same.asset.id, first.asset.id);
    const remote = addRemoteImageReference(x.registry, x.entry.id, "https://images.example.test/cover.png?size=2#ignore", { sourceKind: "provider_thumbnail" });
    assert.equal(remote.duplicate, false); assert.equal(remote.asset.source_url, "https://images.example.test/cover.png?size=2");
    assert.equal(remote.asset.file_path, null); assert.equal(remote.asset.position, 1); assert.equal(remote.asset.is_cover, false);
    const duplicateRemote = addRemoteImageReference(x.registry, x.entry.id, "https://images.example.test/cover.png?size=2#another");
    assert.equal(duplicateRemote.duplicate, true); assert.equal(duplicateRemote.asset.id, remote.asset.id);
    const second = await addLocalImage(x.registry, x.entry.id, x.second, { sourceKind: "browser_selected", makeCover: true });
    assert.equal(second.asset.position, 2); assert.equal(second.asset.is_cover, true);
    assert.equal(getVisualAsset(x.registry, first.asset.id).is_cover, false);
    assert.equal(listVisualAssets(x.registry, x.entry.id).filter((asset) => asset.is_cover).length, 1);
    clearCover(x.registry, x.entry.id);
    assert.equal(listVisualAssets(x.registry, x.entry.id).some((asset) => asset.is_cover), false);
    setCover(x.registry, remote.asset.id);
    assert.equal(getVisualAsset(x.registry, remote.asset.id).is_cover, true);
    assert.throws(
      () => x.registry.db.prepare("UPDATE entry_visual_assets SET is_cover = 1 WHERE id IN (?, ?)").run(first.asset.id, remote.asset.id),
      /UNIQUE constraint failed/
    );
    editEntry(x.registry, x.entry.id, { contentFocus: "text" });
    assert.equal(getEntry(x.registry, x.entry.id).content_focus, "text");
    assert.equal(listVisualAssets(x.registry, x.entry.id).length, 3);
    assert.equal((await addLocalImage(x.registry, x.entry.id, x.source)).duplicate, true);
    assert.equal(getEntry(x.registry, x.entry.id).content_focus, "visual");
    assert.deepEqual(await auditLocalVisualAssets(x.registry), {
      total: 2, verified: 2, missing: 0, hash_mismatch: 0, size_mismatch: 0, media_type_mismatch: 0
    });
  } finally { done(x); }
});

test("remote references reject credentials and local removal preserves transaction/file safety", async () => {
  const x = setup();
  try {
    assert.throws(() => addRemoteImageReference(x.registry, x.entry.id, "https://user:pass@images.example.test/a.png"), (error) => error.code === "VISUAL_ASSET_SOURCE_URL_INVALID");
    assert.throws(() => addRemoteImageReference(x.registry, x.entry.id, "file:///tmp/a.png"), (error) => error.code === "VISUAL_ASSET_SOURCE_URL_INVALID");
    assert.throws(() => addRemoteImageReference(x.registry, x.entry.id, "https://images.example.test/a.png", { sourceKind: "page_snapshot" }), (error) => error.code === "VISUAL_ASSET_SOURCE_KIND_INVALID");
    const first = await addLocalImage(x.registry, x.entry.id, x.source);
    const second = await addLocalImage(x.registry, x.entry.id, x.second);
    const remote = addRemoteImageReference(x.registry, x.entry.id, "https://images.example.test/reference.png");
    const removedRemote = await removeVisualAsset(x.registry, remote.asset.id);
    assert.equal(removedRemote.file_removed, false);
    const removed = await removeVisualAsset(x.registry, first.asset.id);
    assert.equal(removed.removed, true); assert.equal(fs.existsSync(first.asset.file_path), false);
    assert.equal(fs.existsSync(second.asset.file_path), true);
    assert.deepEqual(listVisualAssets(x.registry, x.entry.id).map((asset) => asset.id), [second.asset.id]);
    assert.throws(() => resolveVisualAssetPath(x.registry, "../outside.png"), (error) => error.code === "VISUAL_ASSET_PATH_INVALID");
  } finally { done(x); }
});

test("visual asset removal restores a local asset when the row delete is rejected", async () => {
  const x = setup();
  try {
    const asset = await addLocalImage(x.registry, x.entry.id, x.source);
    x.registry.db.exec("CREATE TRIGGER reject_visual_delete BEFORE DELETE ON entry_visual_assets BEGIN SELECT RAISE(ABORT, 'synthetic delete failure'); END;");
    await assert.rejects(removeVisualAsset(x.registry, asset.asset.id), (error) => error.code === "VISUAL_ASSET_REMOVE_FAILED");
    assert.equal(fs.existsSync(asset.asset.file_path), true);
    assert.equal(getVisualAsset(x.registry, asset.asset.id).status, "ready");
  } finally { done(x); }
});

test("saved visual asset presence matches canonical Entry and normalized image URLs without exposing identities", () => {
  const x = setup();
  try {
    const saved = addRemoteImageReference(
      x.registry,
      x.entry.id,
      "https://images.example.test/cover.png?size=2#stored",
      { sourceKind: "browser_selected" }
    );
    assert.deepEqual(findSavedVisualAssetPresence(x.registry, [
      {
        entryUrl: "https://example.test/visual?utm_source=ignored#detail",
        assetUrls: [
          "https://images.example.test/responsive-cover.png",
          "https://images.example.test/cover.png?size=2#page"
        ]
      },
      {
        entryUrl: "https://example.test/visual",
        assetUrl: "https://images.example.test/other.png"
      }
    ]), [true, false]);
    x.registry.db.prepare("UPDATE entry_visual_assets SET status = 'error' WHERE id = ?").run(saved.asset.id);
    assert.deepEqual(findSavedVisualAssetPresence(x.registry, [{
      entryUrl: "https://example.test/visual",
      assetUrl: "https://images.example.test/cover.png?size=2"
    }]), [false]);
    assert.throws(
      () => findSavedVisualAssetPresence(x.registry, [{ entryUrl: x.entry.url_original, assetUrl: "file:///private.png" }]),
      (error) => error.code === "VISUAL_ASSET_SOURCE_URL_INVALID"
    );
  } finally { done(x); }
});

test("dedupe restores a missing local file from the selected source", async () => {
  const x = setup();
  try {
    const first = await addLocalImage(x.registry, x.entry.id, x.source, { sourceKind: "browser_selected" });
    fs.unlinkSync(first.asset.file_path);

    const restored = await addLocalImage(x.registry, x.entry.id, x.source, { sourceKind: "browser_selected" });

    assert.equal(restored.duplicate, true);
    assert.equal(restored.repaired, true);
    assert.equal(restored.asset.id, first.asset.id);
    assert.deepEqual(fs.readFileSync(first.asset.file_path), PNG);
    assert.deepEqual(await auditLocalVisualAssets(x.registry), {
      total: 1, verified: 1, missing: 0, hash_mismatch: 0, size_mismatch: 0, media_type_mismatch: 0
    });
  } finally { done(x); }
});

test("dedupe verifies and repairs corrupt local bytes and stored metadata", async () => {
  const x = setup();
  try {
    const first = await addLocalImage(x.registry, x.entry.id, x.source, { sourceKind: "browser_selected" });
    const corruptions = [
      () => fs.writeFileSync(first.asset.file_path, Buffer.concat([PNG, Buffer.from([9])])),
      () => x.registry.db.prepare("UPDATE entry_visual_assets SET byte_size = byte_size + 1 WHERE id = ?").run(first.asset.id),
      () => x.registry.db.prepare("UPDATE entry_visual_assets SET media_type = 'image/jpeg' WHERE id = ?").run(first.asset.id),
      () => fs.writeFileSync(first.asset.file_path, Buffer.alloc(PNG.length, 7))
    ];
    for (const corrupt of corruptions) {
      corrupt();
      const repaired = await addLocalImage(x.registry, x.entry.id, x.source, { sourceKind: "browser_selected" });
      assert.equal(repaired.duplicate, true);
      assert.equal(repaired.repaired, true);
      assert.deepEqual(fs.readFileSync(first.asset.file_path), PNG);
      assert.equal(repaired.asset.byte_size, PNG.length);
      assert.equal(repaired.asset.media_type, "image/png");
    }
  } finally { done(x); }
});

test("a corrupt local duplicate without replacement bytes becomes missing and keeps a remote reference", async () => {
  const x = setup();
  try {
    const sourceUrl = "https://images.example.test/selected.png";
    const local = await addLocalImage(x.registry, x.entry.id, x.source, {
      sourceKind: "browser_selected",
      sourceUrl,
      makeCover: true
    });
    fs.writeFileSync(local.asset.file_path, Buffer.alloc(PNG.length, 3));
    const retained = addRemoteImageReference(x.registry, x.entry.id, sourceUrl, {
      sourceKind: "browser_selected",
      makeCover: true
    });
    assert.equal(retained.asset.storage_kind, "remote");
    assert.equal(retained.asset.status, "referenced");
    assert.equal(getVisualAsset(x.registry, local.asset.id).status, "missing");
    assert.equal(getEntry(x.registry, x.entry.id).cover_image.id, retained.asset.id);
  } finally { done(x); }
});

test("local attachment rejects outer transactions and repairs unavailable duplicates", async () => {
  const x = setup();
  try {
    x.registry.db.exec("BEGIN IMMEDIATE");
    await assert.rejects(
      addLocalImage(x.registry, x.entry.id, x.source),
      (error) => error.code === "VISUAL_ASSET_ATTACH_BUSY"
    );
    x.registry.db.exec("ROLLBACK");
    assert.deepEqual(listVisualAssets(x.registry, x.entry.id), []);

    const missing = await addLocalImage(x.registry, x.entry.id, x.source);
    x.registry.db.prepare("UPDATE entry_visual_assets SET status = 'missing' WHERE id = ?").run(missing.asset.id);
    const replacement = await addLocalImage(x.registry, x.entry.id, x.source);
    assert.equal(replacement.duplicate, true);
    assert.equal(replacement.repaired, true);
    assert.equal(replacement.asset.id, missing.asset.id);

    const failedRemote = addRemoteImageReference(x.registry, x.entry.id, "https://images.example.test/retry.png");
    x.registry.db.prepare("UPDATE entry_visual_assets SET status = 'error' WHERE id = ?").run(failedRemote.asset.id);
    const retriedRemote = addRemoteImageReference(x.registry, x.entry.id, "https://images.example.test/retry.png");
    assert.equal(retriedRemote.duplicate, false);
    assert.notEqual(retriedRemote.asset.id, failedRemote.asset.id);
  } finally { done(x); }
});

test("local image and aggregate capture limits accept the boundary and reject one byte over", async () => {
  const x = setup();
  try {
    const exact = path.join(x.directory, "exact-limit.png");
    fs.writeFileSync(exact, PNG);
    fs.truncateSync(exact, MAX_LOCAL_IMAGE_BYTES);
    const attached = await addLocalImage(x.registry, x.entry.id, exact);
    assert.equal(attached.asset.byte_size, MAX_LOCAL_IMAGE_BYTES);

    const oversized = path.join(x.directory, "over-limit.png");
    fs.writeFileSync(oversized, PNG);
    fs.truncateSync(oversized, MAX_LOCAL_IMAGE_BYTES + 1);
    const countBefore = listVisualAssets(x.registry, x.entry.id).length;
    await assert.rejects(addLocalImage(x.registry, x.entry.id, oversized), { code: "VISUAL_ASSET_IMAGE_TOO_LARGE" });
    assert.equal(listVisualAssets(x.registry, x.entry.id).length, countBefore);

    assert.deepEqual(captureDownloadLimit(MAX_CAPTURE_LOCAL_BYTES - MAX_LOCAL_IMAGE_BYTES), {
      maxBytes: MAX_LOCAL_IMAGE_BYTES,
      sizeErrorCode: undefined
    });
    assert.deepEqual(captureDownloadLimit(MAX_CAPTURE_LOCAL_BYTES - 1), {
      maxBytes: 1,
      sizeErrorCode: "CAPTURE_IMAGE_BATCH_TOO_LARGE"
    });
    assert.throws(() => captureDownloadLimit(MAX_CAPTURE_LOCAL_BYTES), { code: "CAPTURE_IMAGE_BATCH_TOO_LARGE" });
  } finally { done(x); }
});
