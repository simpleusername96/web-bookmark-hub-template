"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");

const { withTransaction } = require("../registry/database.js");
const { addEntry, getEntry, listEntries } = require("../registry/entries.js");
const { SCHEMA_SQL, initializeSchema } = require("../registry/schema.js");

function makeV4Fixture(db) {
  db.exec(SCHEMA_SQL);
  db.exec(`
    DROP TRIGGER entries_canonical_url_unique_insert;
    DROP TRIGGER entries_canonical_url_unique_update;
    ALTER TABLE entries DROP COLUMN title_origin;
    ALTER TABLE capture_policy_defaults DROP COLUMN selected_image_storage;
    ALTER TABLE capture_policy_rules DROP COLUMN kind;
    UPDATE registry_meta SET value = 'web-bookmark-hub/registry/v4' WHERE key = 'schema_id';
    PRAGMA user_version = 4;
  `);
  const timestamp = "2026-08-01T00:00:00.000Z";
  const insert = db.prepare(`
    INSERT INTO entries (
      url_original, url_canonical, title, kind, kind_source, provider, source_domain,
      saved_at, visibility, agent_access, ai_processing, content_focus, created_via,
      capture_adapter, record_created_at, record_updated_at
    ) VALUES (?, ?, ?, 'page', 'derived', ?, ?, ?, 'private', 'blocked', 'disabled',
      'visual', 'chrome', ?, ?, ?)
  `);
  insert.run("https://x.com/artist/status/1", "https://x.com/artist/status/1", "captured caption", "x", "x.com", timestamp, "x-media", timestamp, timestamp);
  insert.run("https://x.com/artist/status/1?utm_source=old", "https://x.com/artist/status/1", "legacy duplicate", "x", "x.com", timestamp, "x-media", timestamp, timestamp);
  insert.run("https://example.test/page", "https://example.test/page", "Page title", "generic-web", "example.test", timestamp, "current-tab", timestamp, timestamp);
  insert.run("https://x.com/editor/status/2", "https://x.com/editor/status/2", "User replacement", "x", "x.com", timestamp, "x-media", timestamp, timestamp);
  for (let id = 1; id <= 4; id += 1) {
    db.prepare(`
      INSERT INTO entry_revisions (
        entry_id, revision_number, action, actor_type, changes_json, created_at
      ) VALUES (?, 1, 'created', 'system', '{}', ?)
    `).run(id, timestamp);
  }
  db.prepare(`
    INSERT INTO entry_revisions (
      entry_id, revision_number, action, actor_type, changes_json, created_at
    ) VALUES (4, 2, 'updated', 'user', '{"title":{"before":"caption","after":"User replacement"}}', ?)
  `).run(timestamp);
}

test("v4 migrates to the current schema while preserving legacy duplicates and classifying title provenance", () => {
  const db = new DatabaseSync(":memory:");
  const registry = { db };
  try {
    db.exec("PRAGMA foreign_keys = ON");
    makeV4Fixture(db);
    initializeSchema(db, withTransaction);
    assert.equal(registry.db.prepare("PRAGMA user_version").get().user_version, 18);
    assert.equal(registry.db.prepare("SELECT value FROM registry_meta WHERE key = 'schema_id'").get().value, "web-bookmark-hub/registry/v18");
    assert.equal(registry.db.prepare("SELECT COUNT(*) AS count FROM entries").get().count, 4);
    assert.equal(getEntry(registry, 1).title, null);
    assert.equal(getEntry(registry, 1).title_origin, "capture_caption");
    assert.equal(getEntry(registry, 3).title_origin, "page");
    assert.equal(getEntry(registry, 4).title_origin, "user");
    assert.equal(listEntries(registry, { search: "captured caption" }).total, 0);
    const reused = addEntry(registry, { url: "https://x.com/artist/status/1?utm_medium=repeat" });
    assert.equal(reused.outcome_code, "already_saved");
    assert.equal(reused.entry.id, 1);
  } finally {
    db.close();
  }
});
