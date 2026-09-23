"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const test = require("node:test");

const { createCapturePolicyRule, getCapturePolicy, listCapturePolicyRules } = require("../registry/capture-policy.js");
const { openRegistry } = require("../registry/database.js");
const { addEntry, getEntry } = require("../registry/entries.js");

test("v14 migration derives all compatibility policy mirrors from visibility", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wbh-schema-v15-"));
  const dbPath = path.join(directory, "registry.sqlite3");
  let registry;
  let raw;
  try {
    registry = openRegistry({ dbPath });
    const normal = addEntry(registry, { url: "https://example.test/normal", visibility: "normal" }).entry;
    const privateEntry = addEntry(registry, { url: "https://example.test/private", visibility: "private" }).entry;
    createCapturePolicyRule(registry, { hostname: "example.test", pathPrefix: "/normal", visibility: "normal" });
    registry.close();
    registry = null;

    raw = new DatabaseSync(dbPath);
    raw.exec(`
      UPDATE entries SET agent_access = 'metadata_only', ai_processing = 'manual' WHERE id = ${normal.id};
      UPDATE entries SET agent_access = 'allowed', ai_processing = 'enabled' WHERE id = ${privateEntry.id};
      UPDATE capture_policy_defaults SET visibility = 'normal', agent_access = 'blocked', ai_processing = 'disabled';
      UPDATE capture_policy_rules SET agent_access = 'blocked', ai_processing = 'manual';
      UPDATE registry_meta SET value = 'web-bookmark-hub/registry/v14' WHERE key = 'schema_id';
      PRAGMA user_version = 14;
    `);
    raw.close();
    raw = null;

    registry = openRegistry({ dbPath });
    assert.equal(registry.db.prepare("PRAGMA user_version").get().user_version, 18);
    assert.deepEqual([getEntry(registry, normal.id).agent_access, getEntry(registry, normal.id).ai_processing], ["allowed", "enabled"]);
    assert.deepEqual([getEntry(registry, privateEntry.id).agent_access, getEntry(registry, privateEntry.id).ai_processing], ["blocked", "disabled"]);
    const defaults = getCapturePolicy(registry);
    assert.deepEqual([defaults.visibility, defaults.agent_access, defaults.ai_processing], ["normal", "allowed", "enabled"]);
    const [rule] = listCapturePolicyRules(registry);
    assert.deepEqual([rule.visibility, rule.agent_access, rule.ai_processing], ["normal", "allowed", "enabled"]);
  } finally {
    raw?.close();
    registry?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
