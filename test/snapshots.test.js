"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { openRegistry } = require("../registry/database");
const { addEntry } = require("../registry/entries");
const { attachSnapshot, listSnapshots, removeSnapshot, resolveSnapshotPath } = require("../registry/snapshots");

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wbh-snapshot-"));
  const source = path.join(directory, "source.png"); fs.writeFileSync(source, PNG);
  const registry = openRegistry({ dbPath: path.join(directory, "data", "registry.sqlite3") });
  const item = addEntry(registry, { url: "https://example.test/image", savedAt: "2026-01-01" }).entry;
  return { directory, source, registry, item };
}
function done(x) { x.registry.close(); fs.rmSync(x.directory, { recursive: true, force: true, maxRetries: 3 }); }

test("snapshot API is a page_snapshot compatibility view with independent local records", async () => {
  const x = setup();
  try {
    const first = await attachSnapshot(x.registry, x.item.id, x.source, { capturedAt: "2026-01-02" });
    const second = await attachSnapshot(x.registry, x.item.id, x.source, { capturedAt: "2026-01-03" });
    assert.equal(first.storage_path.startsWith("snapshots/"), true);
    assert.equal(first.sha256, createHash("sha256").update(PNG).digest("hex"));
    assert.equal(first.media_type, "image/png"); assert.equal(first.byte_size, PNG.length);
    assert.notEqual(first.id, second.id); assert.notEqual(first.file_path, second.file_path);
    assert.equal(fs.existsSync(first.file_path), true); assert.equal(fs.existsSync(second.file_path), true);
    assert.deepEqual(listSnapshots(x.registry, x.item.id).map((snapshot) => snapshot.id), [second.id, first.id]);
    const removed = await removeSnapshot(x.registry, first.id);
    assert.equal(removed.removed, true); assert.equal(removed.file_removed, true);
    assert.equal(fs.existsSync(first.file_path), false);
    assert.deepEqual(listSnapshots(x.registry, x.item.id).map((snapshot) => snapshot.id), [second.id]);
  } finally { done(x); }
});

test("snapshot attachment preserves legacy structural errors and safe path behavior", async () => {
  const x = setup();
  try {
    const textFile = path.join(x.directory, "not-image.txt"); fs.writeFileSync(textFile, "not an image");
    await assert.rejects(attachSnapshot(x.registry, x.item.id, textFile), (error) => error.code === "SNAPSHOT_IMAGE_UNSUPPORTED");
    assert.throws(() => resolveSnapshotPath(x.registry, "../outside.png"), (error) => error.code === "SNAPSHOT_PATH_INVALID");
    assert.throws(() => resolveSnapshotPath(x.registry, path.join(x.directory, "outside.png")), (error) => error.code === "SNAPSHOT_PATH_INVALID");
  } finally { done(x); }
});

test("snapshot removal restores its mapped visual row and file when deletion fails", async () => {
  const x = setup();
  try {
    const snapshot = await attachSnapshot(x.registry, x.item.id, x.source);
    x.registry.db.exec("CREATE TRIGGER reject_visual_delete BEFORE DELETE ON entry_visual_assets BEGIN SELECT RAISE(ABORT, 'synthetic delete failure'); END;");
    await assert.rejects(removeSnapshot(x.registry, snapshot.id), (error) => error.code === "SNAPSHOT_REMOVE_FAILED");
    assert.equal(fs.existsSync(snapshot.file_path), true);
    assert.deepEqual(listSnapshots(x.registry, x.item.id).map((item) => item.id), [snapshot.id]);
  } finally { done(x); }
});

test("snapshot storage rejects a linked directory that escapes the application-data root", (context) => {
  const x = setup();
  try {
    const entryDirectory = path.join(x.registry.dataDir, "snapshots", String(x.item.id));
    const outsideDirectory = path.join(x.directory, "outside");
    fs.mkdirSync(path.dirname(entryDirectory), { recursive: true }); fs.mkdirSync(outsideDirectory, { recursive: true });
    try { fs.symlinkSync(outsideDirectory, entryDirectory, process.platform === "win32" ? "junction" : "dir"); }
    catch (error) { context.skip(`directory links are unavailable: ${error.code || error.message}`); return; }
    assert.throws(() => resolveSnapshotPath(x.registry, `snapshots/${x.item.id}/escaped.png`), (error) => error.code === "SNAPSHOT_PATH_INVALID");
  } finally { done(x); }
});
