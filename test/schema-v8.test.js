"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const { openRegistry } = require("../registry/database.js");
const { SCHEMA_SQL } = require("../registry/schema.js");

const STORAGE_COLUMN = "  selected_image_storage TEXT CHECK(selected_image_storage IN ('reference_only','local_copy')),\n";
const V9_KINDS = "'page','article','post','research','code','image','video'";
const V8_KINDS = "'article','social','video','animation','image','research','code','conversation','page'";
const RULE_KIND_COLUMN = `  kind TEXT CHECK(kind IN (${V9_KINDS})),\n`;

function makeV7Fixture(dbPath, { conflictingColumn = false } = {}) {
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA_SQL
    .replace("web-bookmark-hub/registry/v18", "web-bookmark-hub/registry/v7")
    .replace(STORAGE_COLUMN, "")
    .replace(RULE_KIND_COLUMN, "")
    .replace(V9_KINDS, V8_KINDS));
  db.exec("DROP TABLE capture_policy_rule_tags");
  if (conflictingColumn) {
    db.exec("ALTER TABLE capture_policy_defaults ADD COLUMN selected_image_storage TEXT");
  }
  db.prepare(`
    INSERT INTO capture_policy_rules (
      hostname, path_prefix, visibility, agent_access, ai_processing,
      enabled, position, created_at, updated_at
    ) VALUES ('example.test', '/papers', 'normal', 'metadata_only', 'manual', 1, 0, ?, ?)
  `).run("2026-09-02T00:00:00.000Z", "2026-09-02T00:00:00.000Z");
  db.exec("PRAGMA user_version = 7");
  db.close();
}

test("v7 migrates atomically with unset selected-image storage and optional rule kind", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wbh-schema-v8-"));
  let registry;
  try {
    const dbPath = path.join(directory, "registry.sqlite3");
    makeV7Fixture(dbPath);
    registry = openRegistry({ dbPath });
    assert.equal(registry.db.prepare("PRAGMA user_version").get().user_version, 18);
    assert.equal(
      registry.db.prepare("SELECT value FROM registry_meta WHERE key = 'schema_id'").get().value,
      "web-bookmark-hub/registry/v18"
    );
    assert.equal(
      registry.db.prepare("SELECT selected_image_storage FROM capture_policy_defaults WHERE id = 1").get().selected_image_storage,
      null
    );
    assert.equal(registry.db.prepare("SELECT kind FROM capture_policy_rules").get().kind, null);
    assert.equal(registry.db.prepare("SELECT COUNT(*) AS count FROM capture_policy_rules").get().count, 1);
    assert.throws(
      () => registry.db.prepare("UPDATE capture_policy_rules SET kind = 'unknown'").run(),
      /CHECK constraint failed/
    );
    assert.throws(
      () => registry.db.prepare("UPDATE capture_policy_defaults SET selected_image_storage = 'download_all'").run(),
      /CHECK constraint failed/
    );
  } finally {
    registry?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a failed v7-to-v8 migration leaves the v7 fixture readable and unchanged", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wbh-schema-v8-fail-"));
  try {
    const dbPath = path.join(directory, "registry.sqlite3");
    makeV7Fixture(dbPath, { conflictingColumn: true });
    assert.throws(() => openRegistry({ dbPath }), { code: "DATABASE_MIGRATION_FAILED" });
    const after = new DatabaseSync(dbPath);
    assert.equal(after.prepare("PRAGMA user_version").get().user_version, 7);
    assert.equal(
      after.prepare("SELECT value FROM registry_meta WHERE key = 'schema_id'").get().value,
      "web-bookmark-hub/registry/v7"
    );
    assert.equal(after.prepare("SELECT COUNT(*) AS count FROM capture_policy_rules").get().count, 1);
    assert.equal(after.prepare("PRAGMA table_info(capture_policy_rules)").all().some((row) => row.name === "kind"), false);
    after.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
