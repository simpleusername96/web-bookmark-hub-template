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

function makeV5Fixture(dbPath, { conflict = false } = {}) {
  const registry = openRegistry({ dbPath });
  const entryId = captureEntries(registry, {
    channel: "web",
    adapter: "web-add-url",
    requesterScope: "web:schema-v6",
    clientRequestId: "66666666-6666-4666-8666-666666666666",
    items: [{ entryUrl: "https://example.test/schema-v6" }]
  }).items[0].entry_id;
  addComment(registry, entryId, "Preserved comment");
  registry.close();

  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TRIGGER entry_comments_no_delete;
    DROP TRIGGER entry_revisions_no_delete;
    DROP TRIGGER entry_revisions_no_update;

    ALTER TABLE entry_revisions RENAME TO entry_revisions_v6;
    CREATE TABLE entry_revisions (
      id INTEGER PRIMARY KEY,
      entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE RESTRICT,
      revision_number INTEGER NOT NULL CHECK(revision_number >= 1),
      action TEXT NOT NULL CHECK(action IN ('created','updated','archived','restored')),
      actor_type TEXT NOT NULL CHECK(actor_type IN ('user','agent','system')),
      actor_id TEXT,
      changes_json TEXT NOT NULL CHECK(json_valid(changes_json) AND json_type(changes_json) = 'object'),
      reason TEXT,
      created_at TEXT NOT NULL
    );
    INSERT INTO entry_revisions SELECT * FROM entry_revisions_v6;
    DROP TABLE entry_revisions_v6;
    CREATE UNIQUE INDEX entry_revisions_entry_revision_uq ON entry_revisions(entry_id, revision_number);
    CREATE INDEX entry_revisions_entry_created_at_idx ON entry_revisions(entry_id, created_at DESC, id DESC);

    ALTER TABLE capture_request_items RENAME TO capture_request_items_v6;
    CREATE TABLE capture_request_items (
      request_id INTEGER NOT NULL REFERENCES capture_requests(id) ON DELETE CASCADE,
      item_index INTEGER NOT NULL CHECK(item_index >= 0),
      outcome_code TEXT NOT NULL,
      entry_id INTEGER REFERENCES entries(id) ON DELETE RESTRICT,
      details_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(details_json) AND json_type(details_json) = 'object'),
      recorded_at TEXT NOT NULL,
      PRIMARY KEY(request_id, item_index)
    );
    INSERT INTO capture_request_items SELECT * FROM capture_request_items_v6;
    DROP TABLE capture_request_items_v6;
    CREATE INDEX capture_request_items_entry_id_idx ON capture_request_items(entry_id) WHERE entry_id IS NOT NULL;

    CREATE TRIGGER entry_comments_no_delete
    BEFORE DELETE ON entry_comments
    BEGIN SELECT RAISE(ABORT, 'entry comments are append-only'); END;
    CREATE TRIGGER entry_revisions_no_delete
    BEFORE DELETE ON entry_revisions
    BEGIN SELECT RAISE(ABORT, 'entry revisions are append-only'); END;
    CREATE TRIGGER entry_revisions_no_update
    BEFORE UPDATE ON entry_revisions
    BEGIN SELECT RAISE(ABORT, 'entry revisions are append-only'); END;
    ALTER TABLE capture_policy_defaults DROP COLUMN selected_image_storage;
    ALTER TABLE capture_policy_rules DROP COLUMN kind;
    UPDATE registry_meta SET value = 'web-bookmark-hub/registry/v5' WHERE key = 'schema_id';
    PRAGMA user_version = 5;
    PRAGMA foreign_keys = ON;
  `);
  if (conflict) db.exec("CREATE TABLE entry_revisions_v5 (id INTEGER PRIMARY KEY)");
  db.close();
  return entryId;
}

test("v5 migrates to the current schema with parent-only child deletion and nullable capture replay identity", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wbh-schema-v6-"));
  let registry;
  try {
    const dbPath = path.join(directory, "registry.sqlite3");
    const entryId = makeV5Fixture(dbPath);
    registry = openRegistry({ dbPath });
    assert.equal(registry.db.prepare("PRAGMA user_version").get().user_version, 18);
    assert.equal(registry.db.prepare("SELECT value FROM registry_meta WHERE key = 'schema_id'").get().value, "web-bookmark-hub/registry/v18");
    assert.equal(registry.db.prepare("SELECT body FROM entry_comments WHERE entry_id = ?").get(entryId).body, "Preserved comment");
    assert.equal(registry.db.prepare("PRAGMA foreign_key_list(entry_revisions)").all()[0].on_delete, "CASCADE");
    assert.equal(registry.db.prepare("PRAGMA foreign_key_list(capture_request_items)").all().find((row) => row.table === "entries").on_delete, "SET NULL");
    assert.throws(() => registry.db.prepare("DELETE FROM entry_comments WHERE entry_id = ?").run(entryId), /append-only/);
    assert.throws(() => registry.db.prepare("DELETE FROM entry_revisions WHERE entry_id = ?").run(entryId), /append-only/);
    registry.db.prepare("DELETE FROM entries WHERE id = ?").run(entryId);
    assert.equal(registry.db.prepare("SELECT COUNT(*) AS count FROM entry_comments WHERE entry_id = ?").get(entryId).count, 0);
    assert.equal(registry.db.prepare("SELECT COUNT(*) AS count FROM entry_revisions WHERE entry_id = ?").get(entryId).count, 0);
    assert.equal(registry.db.prepare("SELECT entry_id FROM capture_request_items WHERE item_index = 0").get().entry_id, null);
  } finally {
    registry?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a failed v5-to-v6 rebuild rolls back the schema and data", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wbh-schema-v6-fail-"));
  try {
    const dbPath = path.join(directory, "registry.sqlite3");
    const entryId = makeV5Fixture(dbPath, { conflict: true });
    assert.throws(() => openRegistry({ dbPath }), { code: "DATABASE_MIGRATION_FAILED" });
    const db = new DatabaseSync(dbPath);
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 5);
    assert.equal(db.prepare("SELECT url_original FROM entries WHERE id = ?").get(entryId).url_original, "https://example.test/schema-v6");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM entry_revisions WHERE entry_id = ?").get(entryId).count, 1);
    db.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
