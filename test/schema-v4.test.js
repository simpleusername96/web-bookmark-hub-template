"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");

const { openRegistry } = require("../registry/database.js");

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wbh-schema-v4-"));
}

function createV3Fixture(dbPath) {
  const registry = openRegistry({ dbPath });
  registry.close();
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA foreign_keys = OFF;
    DROP INDEX entries_active_saved_at_id_idx;
    DROP INDEX entry_revisions_entry_revision_uq;
    DROP INDEX entry_revisions_entry_created_at_idx;
    DROP INDEX capture_policy_rules_match_idx;
    DROP INDEX capture_policy_rules_position_idx;
    DROP TRIGGER entry_revisions_no_update;
    DROP TRIGGER entry_revisions_no_delete;
    DROP TRIGGER entries_canonical_url_unique_insert;
    DROP TRIGGER entries_canonical_url_unique_update;
    DROP TABLE entry_revisions;
    DROP TABLE capture_policy_defaults;
    DROP TABLE capture_policy_rule_tags;
    DROP TABLE capture_policy_rules;
    ALTER TABLE entries DROP COLUMN deleted_at;
    ALTER TABLE entries DROP COLUMN title_origin;
    UPDATE registry_meta SET value = 'web-bookmark-hub/registry/v3' WHERE key = 'schema_id';
    PRAGMA user_version = 3;
  `);
  const timestamp = "2026-03-01T00:00:00.000Z";
  db.prepare(`
    INSERT INTO entries (
      url_original, url_canonical, title, kind, kind_source, provider, source_domain,
      saved_at, visibility, agent_access, ai_processing, content_focus, created_via,
      record_created_at, record_updated_at
    ) VALUES (?, ?, 'Legacy v3', 'page', 'derived', 'generic-web', 'example.test',
      ?, 'normal', 'metadata_only', 'manual', 'text', 'legacy', ?, ?)
  `).run("https://example.test/v3", "https://example.test/v3", timestamp, timestamp, timestamp);
  db.close();
}

test("a real v3 Registry migrates to the current schema with a system baseline and safe defaults", () => {
  const directory = temporaryDirectory();
  let registry;
  try {
    const dbPath = path.join(directory, "registry.sqlite3");
    createV3Fixture(dbPath);
    registry = openRegistry({ dbPath });
    assert.equal(registry.db.prepare("PRAGMA user_version").get().user_version, 17);
    assert.equal(
      registry.db.prepare("SELECT value FROM registry_meta WHERE key = 'schema_id'").get().value,
      "web-bookmark-hub/registry/v17"
    );
    assert.deepEqual(
      { ...registry.db.prepare("SELECT action, actor_type, actor_id FROM entry_revisions WHERE entry_id = 1").get() },
      { action: "created", actor_type: "system", actor_id: "schema-v4-migration" }
    );
    assert.deepEqual(
      { ...registry.db.prepare("SELECT visibility, agent_access, ai_processing FROM capture_policy_defaults").get() },
      { visibility: "private", agent_access: "blocked", ai_processing: "disabled" }
    );
  } finally {
    registry?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Entry revisions reject update and delete at the database boundary", () => {
  const directory = temporaryDirectory();
  let registry;
  try {
    registry = openRegistry({ dbPath: path.join(directory, "registry.sqlite3") });
    const timestamp = "2026-03-01T00:00:00.000Z";
    registry.db.prepare(`
      INSERT INTO entries (
        url_original, url_canonical, kind, kind_source, provider, source_domain,
        saved_at, record_created_at, record_updated_at
      ) VALUES ('https://example.test/a', 'https://example.test/a', 'page', 'derived',
        'generic-web', 'example.test', ?, ?, ?)
    `).run(timestamp, timestamp, timestamp);
    registry.db.prepare(`
      INSERT INTO entry_revisions (
        entry_id, revision_number, action, actor_type, changes_json, created_at
      ) VALUES (1, 1, 'created', 'system', '{}', ?)
    `).run(timestamp);
    assert.throws(() => registry.db.exec("UPDATE entry_revisions SET reason = 'changed'"), /append-only/);
    assert.throws(() => registry.db.exec("DELETE FROM entry_revisions"), /append-only/);
  } finally {
    registry?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
