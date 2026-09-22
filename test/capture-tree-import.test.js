"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  MAX_DIRECTORY_DEPTH,
  MAX_MANIFESTS,
  MAX_VISITED_ENTRIES,
  discoverManifests,
  importCaptureTree
} = require("../registry/capture-tree-import.js");
const { openRegistry } = require("../registry/database.js");
const { addEntry, archiveEntry, getEntry, listEntryRevisions } = require("../registry/entries.js");
const { listVisualAssets } = require("../registry/visual-assets.js");

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

test("capture tree leaves archived Entries unchanged for local and remote image imports", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wbh-capture-archived-"));
  const tree = path.join(directory, "legacy");
  fs.mkdirSync(tree);
  fs.writeFileSync(path.join(tree, "image.png"), PNG);
  const registry = openRegistry({ dbPath: path.join(directory, "registry", "registry.sqlite3") });
  try {
    const entries = ["local", "remote"].map((suffix) => {
      const entry = addEntry(registry, { url: `https://example.test/archived-${suffix}`, title: "Original" }).entry;
      archiveEntry(registry, entry.id);
      return getEntry(registry, entry.id, { includeArchived: true });
    });
    const revisions = entries.map((entry) => listEntryRevisions(registry, entry.id));
    fs.writeFileSync(path.join(tree, "manifest.json"), JSON.stringify({ items: [
      { postUrl: entries[0].url_canonical, assets: [{ relativePath: "image.png" }] },
      { postUrl: entries[1].url_canonical, mediaUrls: ["https://images.example.test/remote.png"] }
    ] }));
    const report = await importCaptureTree(registry, tree);
    assert.equal(report.manifests.failed, 0);
    assert.equal(report.counts.entries_already_saved, 2);
    assert.equal(report.counts.local_images_added, 0);
    assert.equal(report.counts.remote_references_added, 0);
    for (const [index, entry] of entries.entries()) {
      assert.deepEqual(getEntry(registry, entry.id, { includeArchived: true }), entry);
      assert.deepEqual(listEntryRevisions(registry, entry.id), revisions[index]);
      assert.deepEqual(listVisualAssets(registry, entry.id), []);
    }
  } finally {
    registry.close();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("capture tree attempts each manifest once and writes only aggregate migration evidence", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wbh-capture-tree-"));
  const tree = path.join(directory, "legacy");
  const registry = openRegistry({ dbPath: path.join(directory, "registry", "registry.sqlite3") });
  const reportPath = path.join(directory, "reports", "migration.json");
  try {
    for (const name of ["one", "two"]) fs.mkdirSync(path.join(tree, name), { recursive: true });
    fs.writeFileSync(path.join(tree, "one", "image.png"), PNG);
    fs.writeFileSync(path.join(tree, "one", "manifest.json"), JSON.stringify({ items: [{
      postUrl: "https://synthetic.example.test/post/1",
      assets: [{ relativePath: "image.png" }]
    }] }));
    fs.writeFileSync(path.join(tree, "two", "manifest.json"), JSON.stringify({ items: [{
      postUrl: "https://synthetic.example.test/post/2",
      assets: [{ relativePath: "missing.png" }]
    }] }));
    fs.writeFileSync(path.join(tree, "two", "sync-report.json"), "{}");

    const report = await importCaptureTree(registry, tree, { reportPath });
    assert.deepEqual(report.manifests, { found: 2, attempted: 2, imported: 2, failed: 0 });
    assert.equal(report.counts.entries_created, 2);
    assert.equal(report.counts.local_images_added, 1);
    assert.equal(report.skip_codes.CAPTURE_ASSET_NOT_FOUND, 1);
    const localAsset = registry.db.prepare("SELECT storage_path FROM entry_visual_assets WHERE storage_kind = 'local' ORDER BY id LIMIT 1").get();
    const localAssetPath = path.join(registry.dataDir, ...localAsset.storage_path.split("/"));
    fs.unlinkSync(localAssetPath);
    const replay = await importCaptureTree(registry, tree);
    assert.equal(replay.counts.entries_created, 0);
    assert.equal(replay.counts.entries_already_saved, 2);
    assert.equal(replay.counts.local_images_added, 0);
    assert.equal(replay.counts.local_images_repaired, 1);
    assert.equal(fs.existsSync(localAssetPath), true);
    const persisted = fs.readFileSync(reportPath, "utf8");
    assert.equal(persisted.includes("synthetic.example.test"), false);
    assert.equal(persisted.includes(directory), false);
  } finally {
    registry.close();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("capture tree discovery enforces stable path-free limits at exact boundaries", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wbh-capture-limits-"));
  try {
    assert.equal(MAX_DIRECTORY_DEPTH, 32);
    assert.equal(MAX_VISITED_ENTRIES, 50_000);
    assert.equal(MAX_MANIFESTS, 5_000);

    const depthRoot = path.join(directory, "depth");
    let leaf = depthRoot;
    fs.mkdirSync(leaf, { recursive: true });
    for (let depth = 0; depth < 3; depth += 1) {
      leaf = path.join(leaf, `d${depth}`);
      fs.mkdirSync(leaf);
    }
    fs.writeFileSync(path.join(leaf, "manifest.json"), JSON.stringify({ items: [] }));
    assert.equal((await discoverManifests(depthRoot, { maxDirectoryDepth: 3 })).length, 1);
    await assert.rejects(
      discoverManifests(depthRoot, { maxDirectoryDepth: 2 }),
      (error) => error.code === "CAPTURE_TREE_DEPTH_LIMIT" && !error.message.includes(directory)
    );

    const countRoot = path.join(directory, "count");
    fs.mkdirSync(countRoot);
    fs.writeFileSync(path.join(countRoot, "a.txt"), "");
    fs.writeFileSync(path.join(countRoot, "manifest.json"), JSON.stringify({ items: [] }));
    assert.equal((await discoverManifests(countRoot, { maxVisitedEntries: 2, maxManifests: 1 })).length, 1);
    await assert.rejects(
      discoverManifests(countRoot, { maxVisitedEntries: 1 }),
      (error) => error.code === "CAPTURE_TREE_ENTRY_LIMIT" && !error.message.includes(directory)
    );
    await assert.rejects(
      discoverManifests(countRoot, { maxManifests: 0 }),
      (error) => error.code === "CAPTURE_TREE_MANIFEST_LIMIT" && !error.message.includes(directory)
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("capture tree limit failures occur before mutation and symlinks are not traversed", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wbh-capture-before-mutation-"));
  const tree = path.join(directory, "legacy");
  const outside = path.join(directory, "outside");
  fs.mkdirSync(tree, { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(tree, "manifest.json"), JSON.stringify({ items: [{
    postUrl: "https://synthetic.example.test/limit"
  }] }));
  fs.writeFileSync(path.join(tree, "extra.txt"), "");
  fs.writeFileSync(path.join(outside, "manifest.json"), JSON.stringify({ items: [{
    postUrl: "https://synthetic.example.test/outside"
  }] }));
  try {
    fs.symlinkSync(outside, path.join(tree, "linked"), "junction");
  } catch (error) {
    if (["EPERM", "EACCES"].includes(error.code)) context.skip("symlink creation is unavailable");
    else throw error;
  }
  const registry = openRegistry({ dbPath: path.join(directory, "registry", "registry.sqlite3") });
  try {
    await assert.rejects(
      discoverManifests(tree, { maxVisitedEntries: 1 }),
      (error) => error.code === "CAPTURE_TREE_ENTRY_LIMIT"
    );
    assert.equal(registry.db.prepare("SELECT COUNT(*) AS count FROM entries").get().count, 0);
    const found = await discoverManifests(tree);
    assert.equal(found.length, 1);
    assert.equal(found[0], path.join(tree, "manifest.json"));
  } finally {
    registry.close();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("capture tree validates every manifest before importing any valid manifest", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wbh-capture-prevalidate-"));
  const tree = path.join(directory, "legacy");
  fs.mkdirSync(path.join(tree, "a"), { recursive: true });
  fs.mkdirSync(path.join(tree, "b"), { recursive: true });
  fs.writeFileSync(path.join(tree, "a", "manifest.json"), JSON.stringify({ items: [{
    postUrl: "https://synthetic.example.test/valid"
  }] }));
  fs.writeFileSync(path.join(tree, "b", "manifest.json"), "not json");
  const registry = openRegistry({ dbPath: path.join(directory, "registry", "registry.sqlite3") });
  try {
    const report = await importCaptureTree(registry, tree);
    assert.deepEqual(report.manifests, { found: 2, attempted: 2, imported: 1, failed: 1 });
    assert.equal(report.manifest_failure_codes.CAPTURE_MANIFEST_INVALID, 1);
    assert.equal(registry.db.prepare("SELECT COUNT(*) AS count FROM entries").get().count, 1);
  } finally {
    registry.close();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  }
});
