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
const V8_KINDS = "'article','social','video','animation','image','research','code','conversation','page'";
const TIMESTAMP = "2026-09-02T00:00:00.000Z";

function makeV8Fixture(dbPath, { invalidKind = false } = {}) {
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA_SQL
    .replace("web-bookmark-hub/registry/v17", "web-bookmark-hub/registry/v8")
    .replaceAll(V9_KINDS, V8_KINDS));
  db.exec("DROP TABLE capture_policy_rule_tags");
  db.exec("PRAGMA user_version = 8");

  const insert = db.prepare(`
    INSERT INTO entries (
      url_original, url_canonical, title, title_origin, kind, kind_source,
      provider, source_domain, typed_metadata_json, saved_at,
      visibility, agent_access, ai_processing, content_focus, created_via,
      deleted_at, record_created_at, record_updated_at
    ) VALUES (?, ?, ?, 'user', ?, 'user', 'generic-web', 'example.test', ?, ?,
      'normal', 'metadata_only', 'manual', ?, 'web', ?, ?, ?)
  `);
  const rows = [
    ["social", "text", null],
    ["conversation", "text", null],
    ["animation", "visual", TIMESTAMP],
    ["article", "text", null]
  ];
  rows.forEach(([kind, focus, deletedAt], index) => {
    const url = `https://example.test/v8-${index + 1}`;
    insert.run(url, url, `Entry ${index + 1}`, kind, JSON.stringify({ position: index + 1 }), TIMESTAMP, focus, deletedAt, TIMESTAMP, TIMESTAMP);
  });

  db.prepare("INSERT INTO entry_comments (entry_id, body, created_at) VALUES (1, 'kept', ?)").run(TIMESTAMP);
  db.prepare(`
    INSERT INTO entry_visual_assets (
      entry_id, source_kind, source_url, storage_kind, captured_at, status,
      position, is_cover, created_at, updated_at
    ) VALUES (3, 'browser_selected', 'https://images.example.test/kept.jpg', 'remote', ?, 'referenced', 0, 1, ?, ?)
  `).run(TIMESTAMP, TIMESTAMP, TIMESTAMP);
  const job = db.prepare(`
    INSERT INTO summary_jobs (
      entry_id, status, model, reasoning_effort, input_sha256, input_fields_json,
      policy_snapshot_json, requested_by, requested_at, completed_at
    ) VALUES (2, 'completed', 'gpt-5.6-luna', 'max', 'input', '[]', '{}', 'test', ?, ?)
  `).run(TIMESTAMP, TIMESTAMP);
  db.prepare(`
    INSERT INTO summaries (
      entry_id, job_id, summary_text, model, reasoning_effort, input_sha256, created_at
    ) VALUES (2, ?, 'kept summary', 'gpt-5.6-luna', 'max', 'input', ?)
  `).run(Number(job.lastInsertRowid), TIMESTAMP);

  const insertRule = db.prepare(`
    INSERT INTO capture_policy_rules (
      hostname, path_prefix, kind, visibility, agent_access, ai_processing,
      enabled, position, created_at, updated_at
    ) VALUES (?, '/', ?, 'normal', 'metadata_only', 'manual', 1, ?, ?, ?)
  `);
  ["social", "conversation", "animation"].forEach((kind, index) => {
    insertRule.run(`rule-${index + 1}.example.test`, kind, index, TIMESTAMP, TIMESTAMP);
  });

  if (invalidKind) {
    db.exec("PRAGMA ignore_check_constraints = ON");
    db.prepare("UPDATE entries SET kind = 'unknown' WHERE id = 4").run();
    db.exec("PRAGMA ignore_check_constraints = OFF");
  }
  db.close();
}

test("v8 migrates atomically to seven Content types with revisions and dependencies intact", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wbh-schema-v9-"));
  let registry;
  try {
    const dbPath = path.join(directory, "registry.sqlite3");
    makeV8Fixture(dbPath);
    registry = openRegistry({ dbPath });

    assert.equal(registry.db.prepare("PRAGMA user_version").get().user_version, 17);
    assert.equal(
      registry.db.prepare("SELECT value FROM registry_meta WHERE key = 'schema_id'").get().value,
      "web-bookmark-hub/registry/v17"
    );
    assert.deepEqual(
      registry.db.prepare("SELECT kind FROM entries ORDER BY id").all().map((row) => row.kind),
      ["post", "post", "image", "article"]
    );
    assert.deepEqual(
      registry.db.prepare("SELECT kind FROM capture_policy_rules ORDER BY id").all().map((row) => row.kind),
      ["post", "post", "image"]
    );
    assert.deepEqual(
      registry.db.prepare("SELECT entry_id, changes_json FROM entry_revisions ORDER BY entry_id").all().map((row) => [
        Number(row.entry_id), JSON.parse(row.changes_json).kind
      ]),
      [
        [1, { before: "social", after: "post" }],
        [2, { before: "conversation", after: "post" }],
        [3, { before: "animation", after: "image" }]
      ]
    );
    assert.deepEqual(
      registry.db.prepare("SELECT DISTINCT record_updated_at FROM entries ORDER BY record_updated_at").all().map((row) => row.record_updated_at),
      [TIMESTAMP]
    );
    assert.equal(registry.db.prepare("SELECT COUNT(*) AS count FROM entries WHERE deleted_at IS NOT NULL").get().count, 1);
    assert.equal(registry.db.prepare("SELECT COUNT(*) AS count FROM entry_comments").get().count, 1);
    assert.equal(registry.db.prepare("SELECT COUNT(*) AS count FROM entry_visual_assets").get().count, 1);
    assert.equal(registry.db.prepare("SELECT COUNT(*) AS count FROM summaries").get().count, 1);
    assert.deepEqual(registry.db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.throws(() => registry.db.prepare("UPDATE entries SET kind = 'social' WHERE id = 1").run(), /CHECK constraint failed/);
    assert.throws(() => registry.db.prepare("UPDATE capture_policy_rules SET kind = 'animation' WHERE id = 1").run(), /CHECK constraint failed/);
  } finally {
    registry?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a failed v8-to-v9 copy leaves the v8 Registry readable and unchanged", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wbh-schema-v9-fail-"));
  try {
    const dbPath = path.join(directory, "registry.sqlite3");
    makeV8Fixture(dbPath, { invalidKind: true });
    assert.throws(() => openRegistry({ dbPath }), { code: "DATABASE_MIGRATION_FAILED" });

    const after = new DatabaseSync(dbPath);
    assert.equal(after.prepare("PRAGMA user_version").get().user_version, 8);
    assert.equal(after.prepare("SELECT value FROM registry_meta WHERE key = 'schema_id'").get().value, "web-bookmark-hub/registry/v8");
    assert.equal(after.prepare("SELECT kind FROM entries WHERE id = 1").get().kind, "social");
    assert.equal(after.prepare("SELECT kind FROM entries WHERE id = 4").get().kind, "unknown");
    assert.equal(after.prepare("SELECT COUNT(*) AS count FROM entry_revisions").get().count, 0);
    assert.equal(after.prepare("SELECT COUNT(*) AS count FROM capture_policy_rules").get().count, 3);
    after.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
