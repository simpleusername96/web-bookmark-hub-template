"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { openRegistry } = require("../registry/database.js");

test("schema v12 migrates to rule-tag relations in schema v13", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wbh-schema-v13-"));
  const dbPath = path.join(directory, "registry.sqlite3");
  let registry = openRegistry({ dbPath });
  try {
    registry.db.exec("DROP TABLE capture_policy_rule_tags");
    registry.db.prepare("UPDATE registry_meta SET value = 'web-bookmark-hub/registry/v12' WHERE key = 'schema_id'").run();
    registry.db.exec("PRAGMA user_version = 12");
    registry.close();

    registry = openRegistry({ dbPath });
    assert.equal(registry.db.prepare("PRAGMA user_version").get().user_version, 17);
    assert.equal(
      registry.db.prepare("SELECT value FROM registry_meta WHERE key = 'schema_id'").get().value,
      "web-bookmark-hub/registry/v17"
    );
    assert.deepEqual(
      registry.db.prepare("PRAGMA table_info(capture_policy_rule_tags)").all().map((row) => row.name),
      ["rule_id", "tag_id", "position"]
    );
    const foreignKeys = registry.db.prepare("PRAGMA foreign_key_list(capture_policy_rule_tags)").all();
    assert.equal(foreignKeys.some((row) => row.table === "capture_policy_rules" && row.on_delete === "CASCADE"), true);
    assert.equal(foreignKeys.some((row) => row.table === "tags" && row.on_delete === "RESTRICT"), true);
    assert.equal(
      registry.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'capture_policy_rule_tags_tag_idx'").get().name,
      "capture_policy_rule_tags_tag_idx"
    );
  } finally {
    if (registry) registry.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
