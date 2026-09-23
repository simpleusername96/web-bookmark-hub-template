"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const { openRegistry } = require("../registry/database.js");
const { SCHEMA_SQL } = require("../registry/schema.js");

const V9_KINDS = "'page','article','post','research','code','image','video'";
const V6_KINDS = "'article','social','video','image','paper','repository','session','page'";

function makeV6Fixture(dbPath) {
  const db = new DatabaseSync(dbPath);
  const v6Sql = SCHEMA_SQL
    .replace("web-bookmark-hub/registry/v18", "web-bookmark-hub/registry/v6")
    .replace("  selected_image_storage TEXT CHECK(selected_image_storage IN ('reference_only','local_copy')),\n", "")
    .replace(`  kind TEXT CHECK(kind IN (${V9_KINDS})),\n`, "")
    .replace(V9_KINDS, V6_KINDS);
  db.exec(v6Sql);
  db.exec("DROP TABLE capture_policy_rule_tags");
  db.exec("PRAGMA user_version = 6");
  const insert = db.prepare(`
    INSERT INTO entries (
      url_original, url_canonical, kind, kind_source, provider, source_domain,
      saved_at, record_created_at, record_updated_at
    ) VALUES (?, ?, ?, 'user', 'generic-web', 'example.test', ?, ?, ?)
  `);
  const timestamp = "2026-09-01T00:00:00.000Z";
  ["paper", "repository", "session"].forEach((kind, index) => {
    const url = `https://example.test/legacy-${index + 1}`;
    insert.run(url, url, kind, timestamp, timestamp, timestamp);
  });
  db.close();
}

test("v6 migrates atomically through canonical content types to the current schema", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wbh-schema-v7-"));
  let registry;
  try {
    const dbPath = path.join(directory, "registry.sqlite3");
    makeV6Fixture(dbPath);
    registry = openRegistry({ dbPath });
    assert.equal(registry.db.prepare("PRAGMA user_version").get().user_version, 18);
    assert.equal(
      registry.db.prepare("SELECT value FROM registry_meta WHERE key = 'schema_id'").get().value,
      "web-bookmark-hub/registry/v18"
    );
    assert.deepEqual(
      registry.db.prepare("SELECT kind FROM entries ORDER BY id").all().map((row) => row.kind),
      ["research", "code", "post"]
    );
    assert.deepEqual(registry.db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(registry.db.prepare("SELECT COUNT(*) AS count FROM entries").get().count, 3);
  } finally {
    registry?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a failed v6-to-v7 kind copy rolls back to readable v6", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wbh-schema-v7-fail-"));
  try {
    const dbPath = path.join(directory, "registry.sqlite3");
    makeV6Fixture(dbPath);
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA ignore_check_constraints = ON");
    db.prepare("UPDATE entries SET kind = 'unknown' WHERE id = 1").run();
    db.exec("PRAGMA ignore_check_constraints = OFF");
    db.close();

    assert.throws(() => openRegistry({ dbPath }), { code: "DATABASE_MIGRATION_FAILED" });
    const after = new DatabaseSync(dbPath);
    assert.equal(after.prepare("PRAGMA user_version").get().user_version, 6);
    assert.equal(after.prepare("SELECT value FROM registry_meta WHERE key = 'schema_id'").get().value, "web-bookmark-hub/registry/v6");
    assert.equal(after.prepare("SELECT kind FROM entries WHERE id = 1").get().kind, "unknown");
    after.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
