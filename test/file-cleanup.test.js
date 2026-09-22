"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { openRegistry, withTransaction } = require("../registry/database.js");
const { enqueueFileCleanup, reconcileFileCleanup } = require("../registry/file-cleanup.js");

test("cleanup refuses an intermediate directory link escape and leaves a repairable queue", (context) => {
  withFixture((registry, directory) => {
    const outside = path.join(directory, "outside");
    fs.mkdirSync(outside);
    const marker = path.join(outside, "synthetic.png");
    fs.writeFileSync(marker, "outside marker");
    const linked = path.join(registry.dataDir, "entry-1");
    if (!createLink(context, outside, linked, "junction")) return;
    enqueue(registry, "entry-1/synthetic.png");

    assert.deepEqual(reconcileFileCleanup(registry), { attempted: 1, removed: 0, missing: 0, failed: 1, pending: 1 });
    assert.equal(fs.readFileSync(marker, "utf8"), "outside marker");
    assert.deepEqual({ ...registry.db.prepare("SELECT attempts, failure_code FROM file_cleanup_queue").get() }, {
      attempts: 1, failure_code: "VISUAL_ASSET_PATH_INVALID"
    });

    fs.rmSync(linked);
    fs.mkdirSync(linked);
    fs.writeFileSync(path.join(linked, "synthetic.png"), "owned marker");
    assert.deepEqual(reconcileFileCleanup(registry), { attempted: 1, removed: 1, missing: 0, failed: 0, pending: 0 });
    assert.equal(fs.readFileSync(marker, "utf8"), "outside marker");
  });
});

test("cleanup keeps dangling intermediate directory links pending even beneath missing descendants", (context) => {
  withFixture((registry, directory) => {
    const outside = path.join(directory, "missing-outside");
    const link = path.join(registry.dataDir, "entry-1");
    if (!createLink(context, outside, link, "junction")) return;
    enqueue(registry, "entry-1/missing.png", "entry-1/absent/deeper.png");
    assert.deepEqual(reconcileFileCleanup(registry), { attempted: 2, removed: 0, missing: 0, failed: 2, pending: 2 });
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    assert.equal(registry.db.prepare("SELECT COUNT(*) AS count FROM file_cleanup_queue WHERE failure_code = 'VISUAL_ASSET_PATH_INVALID'").get().count, 2);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "missing.png"), "outside marker");
    assert.equal(reconcileFileCleanup(registry).failed, 2);
    assert.equal(fs.readFileSync(path.join(outside, "missing.png"), "utf8"), "outside marker");
  });
});

test("cleanup removes owned files, tolerates missing paths and retains unrelated files", () => {
  withFixture((registry) => {
    fs.mkdirSync(path.join(registry.dataDir, "entry-1"));
    fs.writeFileSync(path.join(registry.dataDir, "entry-1", "owned.png"), "owned");
    fs.writeFileSync(path.join(registry.dataDir, "unrelated.png"), "keep");
    enqueue(registry, "entry-1/owned.png", "absent/missing.png");
    assert.deepEqual(reconcileFileCleanup(registry), { attempted: 2, removed: 1, missing: 1, failed: 0, pending: 0 });
    assert.equal(fs.existsSync(path.join(registry.dataDir, "entry-1")), false);
    assert.equal(fs.readFileSync(path.join(registry.dataDir, "unrelated.png"), "utf8"), "keep");
  });
});

test("cleanup unlinks a final file symlink without deleting its outside target", (context) => {
  withFixture((registry, directory) => {
    const target = path.join(directory, "outside.png");
    fs.writeFileSync(target, "outside marker");
    const link = path.join(registry.dataDir, "selected.png");
    if (!createLink(context, target, link, "file")) return;
    enqueue(registry, "selected.png");
    assert.equal(reconcileFileCleanup(registry).removed, 1);
    assert.equal(fs.existsSync(link), false);
    assert.equal(fs.readFileSync(target, "utf8"), "outside marker");
  });
});

function enqueue(registry, ...paths) {
  withTransaction(registry.db, () => {
    for (const storagePath of paths) enqueueFileCleanup(registry, storagePath, "synthetic_test");
  });
}

function createLink(context, target, link, type) {
  try {
    fs.symlinkSync(target, link, type);
    return true;
  } catch (error) {
    if (!["EPERM", "EACCES"].includes(error.code)) throw error;
    context.skip("Link creation is unavailable on this host.");
    return false;
  }
}

function withFixture(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wbh-file-cleanup-"));
  const registry = openRegistry({ dbPath: path.join(directory, "registry.sqlite3") });
  try { run(registry, directory); } finally {
    registry.close();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  }
}
