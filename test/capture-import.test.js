"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { openRegistry } = require("../registry/database.js");
const { addEntry, getEntry, listEntries } = require("../registry/entries.js");
const { createFolder } = require("../registry/folders.js");
const { importCaptureManifest } = require("../registry/capture-import.js");
const { listVisualAssets } = require("../registry/visual-assets.js");

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wbh-capture-import-"));
  const captureDirectory = path.join(directory, "capture");
  fs.mkdirSync(captureDirectory);
  fs.writeFileSync(path.join(captureDirectory, "selected.png"), PNG);
  fs.writeFileSync(path.join(captureDirectory, "unrelated.html"), "<html>not an image</html>");
  const registry = openRegistry({ dbPath: path.join(directory, "registry", "registry.sqlite3") });
  return { directory, captureDirectory, registry };
}

function dispose(subject) {
  subject.registry.close();
  fs.rmSync(subject.directory, { recursive: true, force: true, maxRetries: 3 });
}

function writeManifest(subject, items) {
  const manifestPath = path.join(subject.captureDirectory, "capture.json");
  fs.writeFileSync(manifestPath, JSON.stringify({ items }));
  return manifestPath;
}

test("capture import creates one visual Entry and reuses it on repeat without side effects", async () => {
  const subject = setup();
  try {
    const folder = createFolder(subject.registry, { name: "Synthetic artwork" });
    const manifestPath = writeManifest(subject, [{
      postUrl: "https://example.test/post?utm_source=ignored",
      title: "Selected image",
      dateISO: "2026-08-27T01:00:00.000Z",
      savedAt: "2026-08-28T02:00:00.000Z",
      assets: [
        { relativePath: "selected.png", sourceUrl: "https://images.example.test/selected.png" },
        { relativePath: "selected.png", sourceUrl: "https://images.example.test/selected.png" }
      ]
    }]);
    const first = await importCaptureManifest(subject.registry, manifestPath, { folderId: folder.id });
    const second = await importCaptureManifest(subject.registry, manifestPath);
    assert.deepEqual(first.counts, { entries_created: 1, entries_already_saved: 0, local_images_added: 1, local_images_repaired: 0, remote_references_added: 0, items_skipped: 0, assets_skipped: 0 });
    assert.equal(first.items[0].outcome_code, "created");
    assert.equal(first.items[0].local_image_ids.length, 1);
    const importedEntry = getEntry(subject.registry, first.items[0].entry_id);
    assert.equal(importedEntry.content_focus, "visual");
    assert.equal(importedEntry.folder_id, folder.id);
    assert.equal(importedEntry.saved_at, "2026-08-28T02:00:00.000Z");
    assert.equal(importedEntry.published_at, "2026-08-27T01:00:00.000Z");
    assert.equal(importedEntry.created_via, "manifest_import");
    assert.equal(importedEntry.capture_adapter, "legacy-manifest");
    assert.equal(Number.isSafeInteger(importedEntry.capture_request_id), true);
    assert.equal(getEntry(subject.registry, second.items[0].entry_id).folder_id, folder.id);
    assert.equal(second.items[0].outcome_code, "already_saved");
    assert.equal(second.counts.entries_already_saved, 1);
    assert.equal(second.counts.local_images_added, 0);
    const images = listVisualAssets(subject.registry, first.items[0].entry_id);
    assert.equal(images.length, 1);
    assert.equal(images[0].source_kind, "browser_selected");
    assert.equal(images[0].source_url, "https://images.example.test/selected.png");
    assert.equal(images[0].is_cover, true);
    assert.equal(fs.existsSync(images[0].file_path), true);
    fs.unlinkSync(images[0].file_path);
    const repaired = await importCaptureManifest(subject.registry, manifestPath, { attachAssetsToExisting: true });
    assert.equal(repaired.counts.local_images_added, 0);
    assert.equal(repaired.counts.local_images_repaired, 1);
    assert.equal(fs.existsSync(images[0].file_path), true);
    const previewPage = listEntries(subject.registry, { preview: "with" });
    assert.equal(previewPage.total, 1);
    assert.equal(previewPage.items[0].cover_image.id, images[0].id);
  } finally {
    dispose(subject);
  }
});

test("capture import adds one remote reference without fetching when no local selected image exists", async () => {
  const subject = setup();
  try {
    const report = await importCaptureManifest(subject.registry, writeManifest(subject, [{
      postUrl: "https://example.test/remote",
      selectedAt: "2026-08-26T03:00:00.000Z",
      mediaUrls: ["https://images.example.test/thumbnail"]
    }]));
    assert.equal(report.counts.remote_references_added, 1);
    assert.equal(getEntry(subject.registry, report.items[0].entry_id).saved_at, "2026-08-26T03:00:00.000Z");
    const images = listVisualAssets(subject.registry, report.items[0].entry_id);
    assert.deepEqual(images.map((image) => [image.storage_kind, image.source_url]), [["remote", "https://images.example.test/thumbnail"]]);
    assert.equal(images[0].is_cover, true);
  } finally {
    dispose(subject);
  }
});

test("capture import skips unsupported local and remote media while retaining its valid Entry", async () => {
  const subject = setup();
  try {
    const report = await importCaptureManifest(subject.registry, writeManifest(subject, [{
      postUrl: "https://example.test/mixed",
      assets: [{ relativePath: "unrelated.html" }],
      mediaUrls: ["https://media.example.test/clip.mp4"],
      downloadableUrls: ["https://downloads.example.test/archive.zip"]
    }]));
    assert.equal(report.counts.entries_created, 1);
    assert.equal(report.counts.assets_skipped, 3);
    assert.deepEqual(report.skips.map((skip) => skip.code), [
      "VISUAL_ASSET_IMAGE_UNSUPPORTED",
      "CAPTURE_DOWNLOADABLE_IGNORED",
      "CAPTURE_REMOTE_MEDIA_UNSUPPORTED"
    ]);
    assert.equal(listVisualAssets(subject.registry, report.items[0].entry_id).length, 0);
  } finally {
    dispose(subject);
  }
});

test("capture import rejects linked or traversing asset paths without exposing source paths", async () => {
  const subject = setup();
  try {
    const outside = path.join(subject.directory, "outside.png");
    fs.writeFileSync(outside, PNG);
    const linked = path.join(subject.captureDirectory, "linked.png");
    let hasLinkedEscape = true;
    try {
      fs.symlinkSync(outside, linked, process.platform === "win32" ? "file" : "file");
    } catch (error) {
      hasLinkedEscape = false;
    }
    const items = [
      { postUrl: "https://example.test/traversal", assets: [{ relativePath: "../outside.png" }] },
      { postUrl: "https://example.test/credentials", mediaUrls: ["https://user:pass@images.example.test/a.png"] }
    ];
    if (hasLinkedEscape) items.splice(1, 0, { postUrl: "https://example.test/linked", assets: [{ relativePath: "linked.png" }] });
    const report = await importCaptureManifest(subject.registry, writeManifest(subject, items));
    assert.deepEqual(report.skips.map((skip) => skip.code), hasLinkedEscape
      ? ["CAPTURE_ASSET_PATH_INVALID", "CAPTURE_ASSET_PATH_INVALID", "URL_CREDENTIALS_NOT_ALLOWED"]
      : ["CAPTURE_ASSET_PATH_INVALID", "URL_CREDENTIALS_NOT_ALLOWED"]);
    assert.equal(JSON.stringify(report).includes(subject.directory), false);
    assert.equal(JSON.stringify(report).includes("user:pass"), false);
  } finally {
    dispose(subject);
  }
});

test("capture import rejects an invalid batch folder before creating Entries", async () => {
  const subject = setup();
  try {
    const manifestPath = writeManifest(subject, [{ postUrl: "https://example.test/not-created" }]);
    await assert.rejects(
      importCaptureManifest(subject.registry, manifestPath, { folderId: 999 }),
      (error) => error.code === "FOLDER_NOT_FOUND"
    );
    assert.equal(subject.registry.db.prepare("SELECT COUNT(*) AS count FROM entries").get().count, 0);
  } finally {
    dispose(subject);
  }
});
