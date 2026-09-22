"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const test = require("node:test");

const { SCHEMA_SQL } = require("../registry/schema.js");
const { openRegistry } = require("../registry/database.js");
const { getEntry, listEntryRevisions, setAiTitle } = require("../registry/entries.js");
const { listComments } = require("../registry/comments.js");

test("v15 entries and child references survive AI title-origin migration", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wbh-schema-v16-"));
  const dbPath = path.join(directory, "registry.sqlite3");
  let raw;
  let registry;
  try {
    raw = new DatabaseSync(dbPath);
    raw.exec(SCHEMA_SQL
      .replace("web-bookmark-hub/registry/v17", "web-bookmark-hub/registry/v15")
      .replace("'none','user','page','capture_caption','ai'", "'none','user','page','capture_caption'"));
    raw.exec("PRAGMA user_version = 15");
    const insert = raw.prepare(`
      INSERT INTO entries (
        id, url_original, url_canonical, title, title_origin, kind, kind_source,
        provider, source_domain, typed_metadata_json, saved_at, visibility,
        agent_access, ai_processing, content_focus, created_via, record_created_at, record_updated_at
      ) VALUES (?, ?, ?, ?, ?, 'page', 'derived', 'generic-web', 'example.test', '{}',
        '2026-09-01T00:00:00.000Z', 'normal', 'allowed', 'enabled', 'text', 'web',
        '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')
    `);
    insert.run(1, "https://example.test/one", "https://example.test/one", "User title", "user");
    insert.run(2, "https://example.test/two", "https://example.test/two", null, "none");
    raw.prepare("INSERT INTO entry_comments (entry_id,body,created_at) VALUES (1,'User note','2026-09-01T00:00:00.000Z')").run();
    raw.close();
    raw = null;

    registry = openRegistry({ dbPath });
    assert.equal(registry.db.prepare("PRAGMA user_version").get().user_version, 17);
    assert.equal(getEntry(registry, 1).title_origin, "user");
    assert.equal(listComments(registry, 1).items[0].body, "User note");
    assert.equal(registry.db.prepare("PRAGMA foreign_key_check").all().length, 0);
    setAiTitle(registry, 2, "AI-authored page title", { expectedUrl: "https://example.test/two" });
    assert.equal(getEntry(registry, 2).title_origin, "ai");
    assert.equal(listEntryRevisions(registry, 2)[0].actor_type, "agent");
    assert.throws(() => setAiTitle(registry, 1, "Overwrite user title"), { code: "AI_TITLE_CONFLICT" });
  } finally {
    raw?.close();
    registry?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
