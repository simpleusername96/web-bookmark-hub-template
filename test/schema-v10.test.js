"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { openRegistry } = require("../registry/database.js");

test("v9 migrates atomically through the cleanup queue into the current schema", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wbh-schema-v10-"));
  const dbPath = path.join(directory, "registry.sqlite3");
  let registry;
  try {
    registry = openRegistry({ dbPath });
    registry.db.exec("DROP TABLE file_cleanup_queue");
    registry.db.prepare("UPDATE registry_meta SET value = 'web-bookmark-hub/registry/v9' WHERE key = 'schema_id'").run();
    registry.db.exec("PRAGMA user_version = 9");
    registry.close();
    registry = openRegistry({ dbPath });
    assert.equal(registry.db.prepare("PRAGMA user_version").get().user_version, 18);
    assert.equal(registry.db.prepare("SELECT value FROM registry_meta WHERE key = 'schema_id'").get().value, "web-bookmark-hub/registry/v18");
    assert.deepEqual(
      registry.db.prepare("PRAGMA table_info(file_cleanup_queue)").all().map((row) => row.name),
      ["storage_path", "reason", "enqueued_at", "attempts", "failure_code"]
    );
    assert.deepEqual(registry.db.prepare("PRAGMA foreign_key_list(file_cleanup_queue)").all(), []);
  } finally {
    if (registry) registry.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
