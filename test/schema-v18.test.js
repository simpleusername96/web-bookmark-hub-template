"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const test = require("node:test");

const { openRegistry } = require("../registry/database.js");
const { SCHEMA_SQL } = require("../registry/schema.js");

test("v17 summaries keep their model while v18 accepts gpt-6-luna", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wbh-schema-v18-"));
  const dbPath = path.join(directory, "registry.sqlite3");
  let raw;
  let registry;
  try {
    raw = new DatabaseSync(dbPath);
    raw.exec(SCHEMA_SQL
      .replace("web-bookmark-hub/registry/v18", "web-bookmark-hub/registry/v17")
      .replaceAll("model IN ('gpt-5.6-luna','gpt-6-luna')", "model = 'gpt-5.6-luna'"));
    raw.exec("PRAGMA user_version = 17");
    raw.exec(`
      INSERT INTO entries (id, url_original, url_canonical, kind, kind_source, provider,
        source_domain, saved_at, record_created_at, record_updated_at)
      VALUES (1, 'https://example.test/item', 'https://example.test/item', 'page', 'derived',
        'generic-web', 'example.test', '2026-09-01', '2026-09-01', '2026-09-01');
      INSERT INTO summary_jobs (id, entry_id, status, model, reasoning_effort, input_sha256,
        input_fields_json, policy_snapshot_json, requested_by, requested_at, completed_at)
      VALUES (7, 1, 'completed', 'gpt-5.6-luna', 'max', 'old-input', '[]', '{}',
        'test', '2026-09-01', '2026-09-01');
      INSERT INTO summaries (id, entry_id, job_id, summary_text, model, reasoning_effort,
        input_sha256, created_at)
      VALUES (8, 1, 7, 'Preserved summary', 'gpt-5.6-luna', 'max', 'old-input', '2026-09-01');
      INSERT INTO ai_summary_attempts (id, entry_id, source, started_at, completed_at,
        status, legacy_job_id)
      VALUES (9, 1, 'legacy', '2026-09-01', '2026-09-01', 'complete', 7);
    `);
    raw.close();
    raw = null;

    registry = openRegistry({ dbPath });
    assert.equal(registry.db.prepare("PRAGMA user_version").get().user_version, 18);
    assert.equal(registry.db.prepare("SELECT value FROM registry_meta WHERE key = 'schema_id'").get().value,
      "web-bookmark-hub/registry/v18");
    assert.equal(registry.db.prepare("SELECT model FROM summary_jobs WHERE id = 7").get().model, "gpt-5.6-luna");
    assert.deepEqual({ ...registry.db.prepare("SELECT job_id, summary_text, model FROM summaries WHERE id = 8").get() },
      { job_id: 7, summary_text: "Preserved summary", model: "gpt-5.6-luna" });
    assert.equal(registry.db.prepare("SELECT legacy_job_id FROM ai_summary_attempts WHERE id = 9").get().legacy_job_id, 7);
    registry.db.exec(`
      INSERT INTO summary_jobs (id, entry_id, status, model, reasoning_effort, input_sha256,
        input_fields_json, policy_snapshot_json, requested_by, requested_at, completed_at)
      VALUES (10, 1, 'completed', 'gpt-6-luna', 'max', 'new-input', '[]', '{}',
        'test', '2026-09-02', '2026-09-02');
      INSERT INTO summaries (id, entry_id, job_id, summary_text, model, reasoning_effort,
        input_sha256, created_at)
      VALUES (11, 1, 10, 'New summary', 'gpt-6-luna', 'max', 'new-input', '2026-09-02');
    `);
    assert.deepEqual(registry.db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    raw?.close();
    registry?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
