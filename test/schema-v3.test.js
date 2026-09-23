"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");

const { openRegistry, SCHEMA_VERSION } = require("../registry/database.js");
const { addEntry } = require("../registry/entries.js");
const {
  authenticateApiClient,
  createApiClient,
  listApiClients,
  revokeApiClient
} = require("../registry/api-clients.js");

function fixtureDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wbh-schema-v3-"));
}

function dispose(registry, directory) {
  registry?.close();
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
}

function createV2Fixture(dbPath, { conflictingTarget = false } = {}) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE registry_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO registry_meta VALUES ('schema_id', 'web-bookmark-hub/registry/v2');
    CREATE TABLE folders (
      id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES folders(id) ON DELETE RESTRICT,
      name TEXT NOT NULL, normalized_name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE entries (
      id INTEGER PRIMARY KEY, url_original TEXT NOT NULL, url_canonical TEXT NOT NULL, title TEXT,
      kind TEXT NOT NULL, kind_source TEXT NOT NULL, provider TEXT NOT NULL, source_domain TEXT NOT NULL,
      typed_metadata_json TEXT NOT NULL DEFAULT '{}', saved_at TEXT NOT NULL, published_at TEXT, updated_at TEXT,
      visibility TEXT NOT NULL DEFAULT 'private', agent_access TEXT NOT NULL DEFAULT 'blocked',
      ai_processing TEXT NOT NULL DEFAULT 'disabled', folder_id INTEGER REFERENCES folders(id) ON DELETE RESTRICT,
      content_focus TEXT NOT NULL DEFAULT 'text', record_created_at TEXT NOT NULL, record_updated_at TEXT NOT NULL
    );
    CREATE TABLE entry_comments (
      id INTEGER PRIMARY KEY, entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
      body TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TRIGGER entry_comments_no_update BEFORE UPDATE ON entry_comments
      BEGIN SELECT RAISE(ABORT, 'entry comments are append-only'); END;
    CREATE TRIGGER entry_comments_no_delete BEFORE DELETE ON entry_comments
      BEGIN SELECT RAISE(ABORT, 'entry comments are append-only'); END;
    CREATE TABLE tags (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, normalized_name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
    );
    CREATE TABLE entry_tags (
      entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
      tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      added_at TEXT NOT NULL, PRIMARY KEY(entry_id, tag_id)
    );
    CREATE TABLE entry_visual_assets (
      id INTEGER PRIMARY KEY, entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
      source_kind TEXT NOT NULL, source_url TEXT, storage_kind TEXT NOT NULL, captured_at TEXT NOT NULL,
      status TEXT NOT NULL, sha256 TEXT, storage_path TEXT, media_type TEXT, byte_size INTEGER,
      position INTEGER NOT NULL, is_cover INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE summary_jobs (
      id INTEGER PRIMARY KEY, entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
      status TEXT NOT NULL, model TEXT NOT NULL, reasoning_effort TEXT NOT NULL, input_sha256 TEXT NOT NULL,
      input_fields_json TEXT NOT NULL, policy_snapshot_json TEXT NOT NULL, requested_by TEXT NOT NULL,
      requested_at TEXT NOT NULL, completed_at TEXT, failure_code TEXT
    );
    CREATE TABLE summaries (
      id INTEGER PRIMARY KEY, entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
      job_id INTEGER NOT NULL UNIQUE REFERENCES summary_jobs(id) ON DELETE CASCADE, summary_text TEXT NOT NULL,
      model TEXT NOT NULL, reasoning_effort TEXT NOT NULL, input_sha256 TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX entries_saved_at_id_idx ON entries(saved_at DESC, id DESC);
    CREATE INDEX entries_kind_idx ON entries(kind);
    CREATE INDEX entries_provider_idx ON entries(provider);
    CREATE INDEX entries_source_domain_idx ON entries(source_domain);
    CREATE INDEX entries_visibility_agent_access_idx ON entries(visibility, agent_access);
    CREATE INDEX entry_comments_entry_id_created_at_idx ON entry_comments(entry_id, created_at, id);
    CREATE INDEX entry_tags_tag_id_entry_id_idx ON entry_tags(tag_id, entry_id);
    CREATE INDEX summary_jobs_entry_id_requested_at_idx ON summary_jobs(entry_id, requested_at DESC, id DESC);
    CREATE UNIQUE INDEX folders_root_normalized_name_uq ON folders(normalized_name) WHERE parent_id IS NULL;
    CREATE UNIQUE INDEX folders_sibling_normalized_name_uq ON folders(parent_id, normalized_name) WHERE parent_id IS NOT NULL;
    CREATE INDEX folders_parent_id_name_idx ON folders(parent_id, normalized_name, id);
    CREATE INDEX entries_folder_id_idx ON entries(folder_id, saved_at DESC, id DESC);
    CREATE INDEX entries_content_focus_idx ON entries(content_focus, saved_at DESC, id DESC);
    CREATE INDEX entry_visual_assets_entry_id_position_idx ON entry_visual_assets(entry_id, position, id);
    CREATE UNIQUE INDEX entry_visual_assets_one_cover_uq ON entry_visual_assets(entry_id) WHERE is_cover = 1;
    PRAGMA user_version = 2;
  `);
  const timestamp = "2026-02-01T00:00:00.000Z";
  db.prepare("INSERT INTO folders VALUES (1, NULL, 'References', 'references', ?, ?)")
    .run(timestamp, timestamp);
  db.prepare(`
    INSERT INTO entries (
      id, url_original, url_canonical, title, kind, kind_source, provider, source_domain,
      typed_metadata_json, saved_at, visibility, agent_access, ai_processing, folder_id,
      content_focus, record_created_at, record_updated_at
    ) VALUES (1, ?, ?, 'Migrated', 'page', 'derived', 'generic-web', 'example.test',
      '{}', ?, 'normal', 'allowed', 'manual', 1, 'visual', ?, ?)
  `).run("https://example.test/images/a1", "https://example.test/images/a1", timestamp, timestamp, timestamp);
  db.prepare("INSERT INTO entry_comments VALUES (1, 1, 'kept', ?)").run(timestamp);
  db.prepare("INSERT INTO tags VALUES (1, 'Keep', 'keep', ?)").run(timestamp);
  db.prepare("INSERT INTO entry_tags VALUES (1, 1, ?)").run(timestamp);
  db.prepare(`
    INSERT INTO entry_visual_assets VALUES (
      1, 1, 'browser_selected', 'https://media.example.test/a1.png', 'remote', ?,
      'referenced', NULL, NULL, NULL, NULL, 0, 1, ?, ?
    )
  `).run(timestamp, timestamp, timestamp);
  db.prepare(`
    INSERT INTO summary_jobs VALUES (
      1, 1, 'completed', 'gpt-5.6-luna', 'max', 'input', '[]', '{}', 'test', ?, ?, NULL
    )
  `).run(timestamp, timestamp);
  db.prepare(`
    INSERT INTO summaries VALUES (
      1, 1, 1, 'kept summary', 'gpt-5.6-luna', 'max', 'input', ?
    )
  `).run(timestamp);
  if (conflictingTarget) db.exec("CREATE TABLE capture_requests (id INTEGER PRIMARY KEY)");
  db.close();
}

test("fresh current schema exposes capture provenance, revision, policy, API client, URL identity, and deletion boundaries", () => {
  const directory = fixtureDirectory();
  let registry;
  try {
    registry = openRegistry({ dbPath: path.join(directory, "registry.sqlite3") });
    assert.equal(SCHEMA_VERSION, 18);
    assert.equal(registry.db.prepare("PRAGMA user_version").get().user_version, 18);
    const entryColumns = registry.db.prepare("PRAGMA table_info(entries)").all().map((row) => row.name);
    assert.deepEqual(
      ["created_via", "capture_adapter", "capture_request_id", "capture_item_index"].filter((name) => !entryColumns.includes(name)),
      []
    );
    const created = addEntry(registry, { url: "https://example.test/fresh" }).entry;
    assert.equal(created.created_via, "cli");
    assert.equal(created.capture_request_id, null);
    assert.equal(registry.db.prepare("SELECT COUNT(*) AS count FROM entry_revisions WHERE entry_id = ?").get(created.id).count, 1);
    assert.deepEqual(
      { ...registry.db.prepare("SELECT visibility, agent_access, ai_processing FROM capture_policy_defaults WHERE id = 1").get() },
      { visibility: "private", agent_access: "blocked", ai_processing: "disabled" }
    );
  } finally {
    dispose(registry, directory);
  }
});

test("a real v2 registry migrates to the current schema without changing Registry data", () => {
  const directory = fixtureDirectory();
  let registry;
  try {
    const dbPath = path.join(directory, "registry.sqlite3");
    createV2Fixture(dbPath);
    registry = openRegistry({ dbPath });
    assert.equal(registry.db.prepare("PRAGMA user_version").get().user_version, 18);
    assert.equal(registry.db.prepare("SELECT value FROM registry_meta WHERE key = 'schema_id'").get().value, "web-bookmark-hub/registry/v18");
    const migrated = registry.db.prepare("SELECT id, folder_id, content_focus, created_via FROM entries").get();
    assert.deepEqual(
      [migrated.id, migrated.folder_id, migrated.content_focus, migrated.created_via],
      [1, 1, "visual", "legacy"]
    );
    assert.equal(registry.db.prepare("SELECT COUNT(*) AS count FROM entry_comments").get().count, 1);
    assert.equal(registry.db.prepare("SELECT COUNT(*) AS count FROM entry_tags").get().count, 1);
    assert.equal(registry.db.prepare("SELECT COUNT(*) AS count FROM folders").get().count, 1);
    assert.equal(registry.db.prepare("SELECT COUNT(*) AS count FROM entry_visual_assets").get().count, 1);
    assert.equal(registry.db.prepare("SELECT COUNT(*) AS count FROM summary_jobs").get().count, 1);
    assert.equal(registry.db.prepare("SELECT COUNT(*) AS count FROM summaries").get().count, 1);
    assert.equal(registry.db.prepare("SELECT COUNT(*) AS count FROM entry_revisions WHERE entry_id = 1").get().count, 1);
  } finally {
    dispose(registry, directory);
  }
});

test("capture ledger constraints keep requester UUIDs, item indexes, and provenance unique", () => {
  const directory = fixtureDirectory();
  let registry;
  try {
    registry = openRegistry({ dbPath: path.join(directory, "registry.sqlite3") });
    const timestamp = "2026-02-01T00:00:00.000Z";
    const request = registry.db.prepare(`
      INSERT INTO capture_requests (
        requester_scope, client_request_id, payload_sha256, channel, adapter,
        state, item_count, requested_at, completed_at
      ) VALUES ('client:1', '11111111-1111-4111-8111-111111111111', ?, 'chrome', 'generic', 'processing', 1, ?, NULL)
    `).run("a".repeat(64), timestamp);
    assert.throws(() => registry.db.prepare(`
      INSERT INTO capture_requests (
        requester_scope, client_request_id, payload_sha256, channel, state, item_count, requested_at
      ) VALUES ('client:1', '11111111-1111-4111-8111-111111111111', ?, 'chrome', 'processing', 0, ?)
    `).run("b".repeat(64), timestamp), /UNIQUE/);
    assert.throws(() => registry.db.prepare(`
      INSERT INTO entries (
        url_original, url_canonical, kind, kind_source, provider, source_domain,
        saved_at, created_via, capture_request_id, record_created_at, record_updated_at
      ) VALUES ('https://example.test/a', 'https://example.test/a', 'page', 'derived',
        'generic-web', 'example.test', ?, 'chrome', ?, ?, ?)
    `).run(timestamp, request.lastInsertRowid, timestamp, timestamp), /capture provenance must be complete/);
    const entry = addEntry(registry, { url: "https://example.test/a" }, {
      provenance: {
        createdVia: "chrome",
        captureAdapter: "generic",
        captureRequestId: Number(request.lastInsertRowid),
        captureItemIndex: 0
      }
    }).entry;
    registry.db.prepare(`
      INSERT INTO capture_request_items (
        request_id, item_index, outcome_code, entry_id, details_json, recorded_at
      ) VALUES (?, 0, 'created', ?, '{}', ?)
    `).run(request.lastInsertRowid, entry.id, timestamp);
    assert.throws(() => registry.db.prepare(`
      INSERT INTO capture_request_items (
        request_id, item_index, outcome_code, entry_id, details_json, recorded_at
      ) VALUES (?, 0, 'created', ?, '{}', ?)
    `).run(request.lastInsertRowid, entry.id, timestamp), /UNIQUE/);
  } finally {
    dispose(registry, directory);
  }
});

test("API clients store only token hashes and revocation fails closed", () => {
  const directory = fixtureDirectory();
  let registry;
  try {
    registry = openRegistry({ dbPath: path.join(directory, "registry.sqlite3") });
    const token = "synthetic-token-value-that-is-long-enough-1234567890";
    const client = createApiClient(registry, {
      token,
      extensionId: "abcdefghijklmnopabcdefghijklmnop",
      label: "Synthetic Chrome"
    }, { clock: () => new Date("2026-02-01T00:00:00.000Z") });
    const stored = registry.db.prepare("SELECT token_sha256 FROM api_clients WHERE id = ?").get(client.id);
    assert.equal(stored.token_sha256.length, 64);
    assert.notEqual(stored.token_sha256, token);
    assert.equal(JSON.stringify(listApiClients(registry)).includes(token), false);
    assert.equal(authenticateApiClient(registry, token, { touch: false }).id, client.id);
    revokeApiClient(registry, client.id, { clock: () => new Date("2026-02-02T00:00:00.000Z") });
    assert.throws(
      () => authenticateApiClient(registry, token, { touch: false }),
      (error) => error.code === "API_CLIENT_UNAUTHORIZED"
    );
  } finally {
    dispose(registry, directory);
  }
});

test("a failed v2-to-v3 migration rolls back every v3 change", () => {
  const directory = fixtureDirectory();
  try {
    const dbPath = path.join(directory, "registry.sqlite3");
    createV2Fixture(dbPath, { conflictingTarget: true });
    assert.throws(
      () => openRegistry({ dbPath }),
      (error) => error.code === "DATABASE_MIGRATION_FAILED"
    );
    const db = new DatabaseSync(dbPath);
    try {
      assert.equal(db.prepare("PRAGMA user_version").get().user_version, 2);
      assert.equal(db.prepare("SELECT value FROM registry_meta WHERE key = 'schema_id'").get().value, "web-bookmark-hub/registry/v2");
      assert.equal(db.prepare("PRAGMA table_info(entries)").all().some((row) => row.name === "created_via"), false);
      assert.deepEqual(db.prepare("PRAGMA table_info(capture_requests)").all().map((row) => row.name), ["id"]);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  }
});
