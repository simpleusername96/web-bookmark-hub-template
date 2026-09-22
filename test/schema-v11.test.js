"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const test = require("node:test");

const { openRegistry } = require("../registry/database.js");
const { addEntry } = require("../registry/entries.js");

test("retired schema v11 link-health data is removed without changing Entries", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wbh-schema-v11-retired-"));
  const dbPath = path.join(directory, "registry.sqlite3");
  let registry = openRegistry({ dbPath });
  try {
    const entry = addEntry(registry, { url: "https://example.test/kept" }).entry;
    registry.db.exec(`
      CREATE TABLE entry_link_health (
        entry_id INTEGER PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
        checked_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('healthy','redirected','restricted','unavailable','blocked','error')),
        http_status INTEGER CHECK(http_status IS NULL OR (http_status >= 100 AND http_status <= 599)),
        final_url TEXT,
        redirect_count INTEGER NOT NULL CHECK(redirect_count >= 0 AND redirect_count <= 4),
        failure_code TEXT
      );
    `);
    registry.db.prepare("INSERT INTO entry_link_health (entry_id, checked_at, status, http_status, redirect_count) VALUES (?, ?, 'healthy', 200, 0)")
      .run(entry.id, "2026-09-03T00:00:00.000Z");
    registry.db.prepare("UPDATE registry_meta SET value = 'web-bookmark-hub/registry/v11' WHERE key = 'schema_id'").run();
    registry.db.exec("PRAGMA user_version = 11");
    registry.close();

    registry = openRegistry({ dbPath });
    assert.equal(registry.db.prepare("PRAGMA user_version").get().user_version, 17);
    assert.equal(registry.db.prepare("SELECT value FROM registry_meta WHERE key = 'schema_id'").get().value, "web-bookmark-hub/registry/v17");
    assert.equal(registry.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'entry_link_health'").get(), undefined);
    assert.equal(registry.db.prepare("SELECT url_original FROM entries WHERE id = ?").get(entry.id).url_original, "https://example.test/kept");
  } finally {
    if (registry) registry.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("an incomplete v11 retirement rolls back without changing its identity", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wbh-schema-v11-invalid-"));
  const dbPath = path.join(directory, "registry.sqlite3");
  let registry = openRegistry({ dbPath });
  registry.db.prepare("UPDATE registry_meta SET value = 'web-bookmark-hub/registry/v11' WHERE key = 'schema_id'").run();
  registry.db.exec("PRAGMA user_version = 11");
  registry.close();
  registry = null;
  try {
    assert.throws(() => openRegistry({ dbPath }), { code: "DATABASE_SCHEMA_INVALID" });
    const db = new DatabaseSync(dbPath);
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 11);
    assert.equal(db.prepare("SELECT value FROM registry_meta WHERE key = 'schema_id'").get().value, "web-bookmark-hub/registry/v11");
    db.close();
  } finally {
    if (registry) registry.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
