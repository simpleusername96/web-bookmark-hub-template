"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const test = require("node:test");
const { SCHEMA_SQL } = require("../registry/schema.js");
const { openRegistry } = require("../registry/database.js");
const { createCapturePolicyRule, listCapturePolicyRules } = require("../registry/capture-policy.js");

test("v13 migration preserves rule identity, policies and tags while allowing distinct save methods", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wbh-schema-v14-"));
  const dbPath = path.join(directory, "registry.sqlite3");
  let registry;
  let old;
  try {
    old = new DatabaseSync(dbPath);
    const v13 = SCHEMA_SQL.replace("web-bookmark-hub/registry/v18", "web-bookmark-hub/registry/v13")
      .replace(/  capture_mode TEXT[^\n]+\n/u, "")
      .replace("UNIQUE(hostname, path_prefix, capture_mode)", "UNIQUE(hostname, path_prefix)");
    old.exec(v13);
    old.exec("PRAGMA user_version = 13");
    old.exec("INSERT INTO capture_policy_rules (id, hostname, path_prefix, kind, visibility, agent_access, ai_processing, enabled, position, created_at, updated_at) VALUES (7, 'x.com', '/', 'post', 'private', 'metadata_only', 'disabled', 1, 2, '2026-09-01', '2026-09-02')");
    old.exec("INSERT INTO tags (id, name, normalized_name, created_at) VALUES (9, 'Keep', 'keep', '2026-09-01')");
    old.exec("INSERT INTO capture_policy_rule_tags (rule_id, tag_id, position) VALUES (7, 9, 0)");
    old.close();
    old = null;
    registry = openRegistry({ dbPath });
    assert.equal(registry.db.prepare("PRAGMA user_version").get().user_version, 18);
    const [rule] = listCapturePolicyRules(registry);
    assert.equal(rule.id, 7);
    assert.equal(rule.capture_mode, "all");
    assert.equal(rule.kind, "post");
    assert.equal(rule.agent_access, "blocked");
    assert.equal(rule.ai_processing, "disabled");
    assert.equal(rule.created_at, "2026-09-01");
    assert.equal(rule.updated_at, "2026-09-02");
    assert.deepEqual(rule.tags.map((tag) => tag.name), ["Keep"]);
    createCapturePolicyRule(registry, { hostname: "x.com", captureMode: "selected_images" });
    createCapturePolicyRule(registry, { hostname: "x.com", captureMode: "page" });
    assert.deepEqual(registry.db.prepare("PRAGMA foreign_key_check").all(), []);
    registry.close();
    registry = openRegistry({ dbPath });
    assert.deepEqual(listCapturePolicyRules(registry).map((item) => item.capture_mode), ["all", "selected_images", "page"]);
  } finally {
    old?.close();
    registry?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
