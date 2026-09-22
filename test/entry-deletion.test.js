"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");

const { addComment } = require("../registry/comments.js");
const { captureEntries } = require("../registry/captures.js");
const { openRegistry } = require("../registry/database.js");
const { deleteEntries, deleteEntry } = require("../registry/entry-deletion.js");
const { addEntry, getEntry } = require("../registry/entries.js");
const { addTags } = require("../registry/tags.js");
const { addLocalImage } = require("../registry/visual-assets.js");

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wbh-entry-delete-"));
  const registry = openRegistry({ dbPath: path.join(directory, "registry.sqlite3") });
  return {
    directory,
    registry,
    dispose() {
      this.registry.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  };
}

function captureOne(registry, url) {
  return captureEntries(registry, {
    channel: "web",
    adapter: "web-add-url",
    requesterScope: "web:test",
    clientRequestId: "11111111-1111-4111-8111-111111111111",
    items: [{ entryUrl: url }]
  }).items[0].entry_id;
}

test("delete snapshots include committed assets before the lock and exclude competing writes while locked", async () => {
  for (const timing of ["before-lock", "after-snapshot"]) {
    const subject = fixture();
    let second;
    try {
      const entry = addEntry(subject.registry, { url: `https://example.test/delete-race-${timing}` }).entry;
      const source = path.join(subject.directory, "source.png");
      fs.writeFileSync(source, PNG);
      const attached = await addLocalImage(subject.registry, entry.id, source);
      second = new DatabaseSync(subject.registry.dbPath);
      second.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 0");
      const candidatePath = path.join(subject.registry.dataDir, "competing.png");
      let attempted = false;
      let inserted = false;
      function competingInsert() {
        attempted = true;
        fs.writeFileSync(candidatePath, PNG);
        try {
          second.prepare(`
            INSERT INTO entry_visual_assets (
              entry_id, source_kind, storage_kind, captured_at, status, sha256,
              storage_path, media_type, byte_size, position, is_cover, created_at, updated_at
            ) SELECT entry_id, source_kind, storage_kind, captured_at, status, ?,
              'competing.png', media_type, byte_size, position + 1, 0, created_at, updated_at
              FROM entry_visual_assets WHERE id = ?
          `).run("b".repeat(64), attached.asset.id);
          inserted = true;
        } catch (error) {
          fs.unlinkSync(candidatePath);
          assert.equal(error.errcode, 5, "the competing write must be SQLITE_BUSY");
        }
      }
      const db = new Proxy(subject.registry.db, {
        get(target, property) {
          if (property === "exec") return (sql) => {
            if (timing === "before-lock" && sql === "BEGIN IMMEDIATE") competingInsert();
            return target.exec(sql);
          };
          if (property === "prepare") return (sql) => {
            const statement = target.prepare(sql);
            if (timing !== "after-snapshot" || !/SELECT id, storage_path\s+FROM entry_visual_assets/.test(sql)) return statement;
            return { all(...args) {
              const rows = statement.all(...args);
              competingInsert();
              return rows;
            } };
          };
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        }
      });
      const result = await deleteEntry({ ...subject.registry, db }, entry.id);
      assert.equal(attempted, true);
      assert.equal(inserted, timing === "before-lock");
      assert.equal(result.files_removed, timing === "before-lock" ? 2 : 1);
      assert.equal(fs.existsSync(candidatePath), false);
      assert.equal(fs.existsSync(attached.asset.file_path), false);
      assert.equal(subject.registry.db.prepare("SELECT COUNT(*) AS count FROM entry_visual_assets").get().count, 0);
      assert.equal(subject.registry.db.prepare("SELECT COUNT(*) AS count FROM file_cleanup_queue").get().count, 0);
    } finally {
      second?.close();
      subject.dispose();
    }
  }
});

test("permanent Entry deletion removes child data and local previews while redacting capture replay", async () => {
  const subject = fixture();
  try {
    const entryId = captureOne(subject.registry, "https://example.test/permanent");
    addComment(subject.registry, entryId, "Synthetic note");
    addTags(subject.registry, entryId, ["synthetic"]);
    const sourcePath = path.join(subject.directory, "source.png");
    fs.writeFileSync(sourcePath, PNG);
    const attached = await addLocalImage(subject.registry, entryId, sourcePath);
    assert.equal(fs.existsSync(attached.asset.file_path), true);

    const deleted = await deleteEntry(subject.registry, entryId);

    assert.deepEqual(deleted.entry_ids, [entryId]);
    assert.equal(deleted.deleted, 1);
    assert.equal(deleted.files_removed, 1);
    assert.equal(fs.existsSync(attached.asset.file_path), false);
    assert.equal(fs.existsSync(sourcePath), true);
    assert.throws(() => getEntry(subject.registry, entryId, { includeArchived: true }), { code: "ENTRY_NOT_FOUND" });
    for (const table of ["entry_comments", "entry_tags", "entry_visual_assets", "entry_revisions"]) {
      assert.equal(subject.registry.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE entry_id = ?`).get(entryId).count, 0);
    }
    const captureItem = subject.registry.db.prepare(`
      SELECT outcome_code, entry_id, details_json FROM capture_request_items WHERE item_index = 0
    `).get();
    assert.deepEqual({ ...captureItem }, { outcome_code: "deleted", entry_id: null, details_json: "{}" });
    assert.equal(addEntry(subject.registry, { url: "https://example.test/permanent" }).outcome_code, "created");
  } finally {
    subject.dispose();
  }
});

test("permanent batch deletion validates every Entry and local path before mutation", async () => {
  const subject = fixture();
  try {
    const first = addEntry(subject.registry, { url: "https://example.test/first" }).entry;
    const second = addEntry(subject.registry, { url: "https://example.test/second" }).entry;
    await assert.rejects(deleteEntries(subject.registry, [first.id, 999]), { code: "ENTRY_NOT_FOUND" });
    assert.equal(getEntry(subject.registry, first.id).id, first.id);
    assert.equal(getEntry(subject.registry, second.id).id, second.id);

    const sourcePath = path.join(subject.directory, "unsafe.png");
    fs.writeFileSync(sourcePath, PNG);
    const attached = await addLocalImage(subject.registry, first.id, sourcePath);
    subject.registry.db.prepare("UPDATE entry_visual_assets SET storage_path = '../escape.png' WHERE id = ?").run(attached.asset.id);
    await assert.rejects(deleteEntry(subject.registry, first.id), { code: "VISUAL_ASSET_PATH_INVALID" });
    assert.equal(getEntry(subject.registry, first.id).id, first.id);
  } finally {
    subject.dispose();
  }
});

test("permanent deletion tolerates an already missing local preview", async () => {
  const subject = fixture();
  try {
    const entry = addEntry(subject.registry, { url: "https://example.test/missing-preview" }).entry;
    const sourcePath = path.join(subject.directory, "missing.png");
    fs.writeFileSync(sourcePath, PNG);
    const attached = await addLocalImage(subject.registry, entry.id, sourcePath);
    fs.unlinkSync(attached.asset.file_path);
    const deleted = await deleteEntry(subject.registry, entry.id);
    assert.equal(deleted.deleted, 1);
    assert.equal(deleted.files_missing, 1);
  } finally {
    subject.dispose();
  }
});

test("cleanup queue preserves data before commit and reconciles every post-commit crash point", async () => {
  const subject = fixture();
  try {
    async function attachedEntry(suffix) {
      const entry = addEntry(subject.registry, { url: `https://example.test/${suffix}` }).entry;
      const sourcePath = path.join(subject.directory, `${suffix}.png`);
      fs.writeFileSync(sourcePath, PNG);
      return { entry, attached: await addLocalImage(subject.registry, entry.id, sourcePath) };
    }

    const before = await attachedEntry("before-commit");
    await assert.rejects(deleteEntry(subject.registry, before.entry.id, {
      beforeCommit() { throw new Error("fault-before-commit"); }
    }), { code: "ENTRY_DELETE_FAILED" });
    assert.equal(getEntry(subject.registry, before.entry.id).id, before.entry.id);
    assert.equal(fs.existsSync(before.attached.asset.file_path), true);
    assert.equal(subject.registry.db.prepare("SELECT COUNT(*) AS count FROM file_cleanup_queue").get().count, 0);

    const after = await attachedEntry("after-commit");
    await assert.rejects(deleteEntry(subject.registry, after.entry.id, {
      afterCommit() { throw new Error("fault-after-commit"); }
    }), /fault-after-commit/);
    assert.throws(() => getEntry(subject.registry, after.entry.id), { code: "ENTRY_NOT_FOUND" });
    assert.equal(fs.existsSync(after.attached.asset.file_path), true);
    assert.equal(subject.registry.db.prepare("SELECT COUNT(*) AS count FROM file_cleanup_queue").get().count, 1);

    subject.registry.close();
    subject.registry = openRegistry({ dbPath: path.join(subject.directory, "registry.sqlite3") });
    assert.equal(fs.existsSync(after.attached.asset.file_path), false);
    assert.equal(subject.registry.db.prepare("SELECT COUNT(*) AS count FROM file_cleanup_queue").get().count, 0);

    const afterUnlink = await attachedEntry("after-unlink");
    const deleted = await deleteEntry(subject.registry, afterUnlink.entry.id, {
      afterUnlink() { throw new Error("fault-after-unlink"); }
    });
    assert.equal(deleted.files_pending, 1);
    assert.equal(fs.existsSync(afterUnlink.attached.asset.file_path), false);
    assert.equal(subject.registry.db.prepare("SELECT COUNT(*) AS count FROM file_cleanup_queue").get().count, 1);

    subject.registry.close();
    subject.registry = openRegistry({ dbPath: path.join(subject.directory, "registry.sqlite3") });
    assert.equal(subject.registry.db.prepare("SELECT COUNT(*) AS count FROM file_cleanup_queue").get().count, 0);
  } finally {
    subject.dispose();
  }
});

test("batch deletion queues every local file in the same committed mutation", async () => {
  const subject = fixture();
  try {
    const entries = [];
    for (const suffix of ["batch-a", "batch-b"]) {
      const entry = addEntry(subject.registry, { url: `https://example.test/${suffix}` }).entry;
      const sourcePath = path.join(subject.directory, `${suffix}.png`);
      fs.writeFileSync(sourcePath, PNG);
      entries.push({ entry, attached: await addLocalImage(subject.registry, entry.id, sourcePath) });
    }
    await assert.rejects(deleteEntries(subject.registry, entries.map((item) => item.entry.id), {
      afterCommit() { throw new Error("batch-crash"); }
    }), /batch-crash/);
    assert.equal(subject.registry.db.prepare("SELECT COUNT(*) AS count FROM file_cleanup_queue").get().count, 2);
    entries.forEach((item) => assert.equal(fs.existsSync(item.attached.asset.file_path), true));
  } finally {
    subject.dispose();
  }
});
