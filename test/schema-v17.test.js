"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const test = require("node:test");

const { openRegistry } = require("../registry/database.js");
const { addEntry } = require("../registry/entries.js");
const { pendingIds } = require("../server/ai-url-summary.js");

test("v16 completed AI jobs become counted legacy attempts without fabricated usage", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wbh-schema-v17-"));
  const dbPath = path.join(directory, "registry.sqlite3");
  let registry;
  let raw;
  try {
    registry = openRegistry({ dbPath });
    const entry = addEntry(registry, { url: "https://example.test/legacy", visibility: "normal" }).entry;
    registry.close();
    registry = null;
    raw = new DatabaseSync(dbPath);
    raw.exec(`
      DROP TABLE ai_summary_attempts;
      UPDATE registry_meta SET value = 'web-bookmark-hub/registry/v16' WHERE key = 'schema_id';
      PRAGMA user_version = 16;
    `);
    raw.prepare(`
      INSERT INTO summary_jobs (entry_id, status, model, reasoning_effort, input_sha256,
        input_fields_json, policy_snapshot_json, requested_by, requested_at, completed_at)
      VALUES (?, 'completed', 'gpt-5.6-luna', 'max', 'synthetic', '[]', '{}',
        'ai-url-summary', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:01.000Z')
    `).run(entry.id);
    raw.close();
    raw = null;

    registry = openRegistry({ dbPath });
    assert.equal(registry.db.prepare("PRAGMA user_version").get().user_version, 18);
    const attempt = registry.db.prepare("SELECT * FROM ai_summary_attempts WHERE entry_id = ?").get(entry.id);
    assert.equal(attempt.source, "legacy");
    assert.equal(attempt.status, "complete");
    assert.equal(attempt.input_tokens, null);
    assert.equal(attempt.total_ms, null);
    assert.deepEqual(pendingIds(registry), []);
  } finally {
    raw?.close();
    registry?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
