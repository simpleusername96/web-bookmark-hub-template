"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const {
  assertPathOutsideRepository,
  assertRegistryDataPath,
  getApplicationDataDir,
  resolveDatabasePath,
} = require("../registry/data-paths");
const { SCHEMA_VERSION } = require("../registry/schema");
const { openRegistry, withTransaction } = require("../registry/database");

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "web-bookmark-hub-db-"));
}

test("ordinary Registry startup still reconciles queued files", () => {
  const directory = temporaryDirectory();
  const dbPath = path.join(directory, "registry.sqlite3");
  let registry = openRegistry({ dbPath });
  try {
    fs.writeFileSync(path.join(registry.dataDir, "queued.bin"), "queued");
    registry.db.prepare(`
      INSERT INTO file_cleanup_queue (storage_path, reason, enqueued_at, attempts)
      VALUES ('queued.bin', 'test_cleanup', '2026-09-08T00:00:00.000Z', 0)
    `).run();
  } finally {
    registry.close();
  }
  try {
    registry = openRegistry({ dbPath });
    assert.equal(fs.existsSync(path.join(registry.dataDir, "queued.bin")), false);
    assert.equal(registry.db.prepare("SELECT COUNT(*) AS count FROM file_cleanup_queue").get().count, 0);
  } finally {
    registry?.close();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("nested transactions use savepoints without leaking partial writes", () => {
  const registry = openRegistry({ dbPath: ":memory:" });
  try {
    registry.db.exec("CREATE TABLE nested_probe (value TEXT NOT NULL)");
    withTransaction(registry.db, () => {
      registry.db.prepare("INSERT INTO nested_probe VALUES (?)").run("outer");
      withTransaction(registry.db, () => registry.db.prepare("INSERT INTO nested_probe VALUES (?)").run("inner"));
    });
    assert.deepEqual(registry.db.prepare("SELECT value FROM nested_probe ORDER BY rowid").all().map((row) => row.value), ["outer", "inner"]);

    assert.throws(() => withTransaction(registry.db, () => {
      registry.db.prepare("INSERT INTO nested_probe VALUES (?)").run("rolled outer");
      withTransaction(registry.db, () => {
        registry.db.prepare("INSERT INTO nested_probe VALUES (?)").run("rolled inner");
        throw new Error("propagated");
      });
    }), /propagated/);

    withTransaction(registry.db, () => {
      registry.db.prepare("INSERT INTO nested_probe VALUES (?)").run("kept outer");
      try {
        withTransaction(registry.db, () => {
          registry.db.prepare("INSERT INTO nested_probe VALUES (?)").run("discarded inner");
          throw new Error("caught");
        });
      } catch (error) {
        assert.match(error.message, /caught/);
      }
    });
    assert.deepEqual(registry.db.prepare("SELECT value FROM nested_probe ORDER BY rowid").all().map((row) => row.value), ["outer", "inner", "kept outer"]);
  } finally {
    registry.close();
  }
});

function closeAndRemove(registry, directory) {
  registry?.close();
  fs.rmSync(directory, { recursive: true, force: true });
}

function createV1Fixture(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE registry_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO registry_meta VALUES ('schema_id', 'web-bookmark-hub/registry/v1');
    CREATE TABLE entries (
      id INTEGER PRIMARY KEY, url_original TEXT NOT NULL, url_canonical TEXT NOT NULL, title TEXT,
      kind TEXT NOT NULL, kind_source TEXT NOT NULL, provider TEXT NOT NULL, source_domain TEXT NOT NULL,
      typed_metadata_json TEXT NOT NULL DEFAULT '{}', saved_at TEXT NOT NULL, published_at TEXT, updated_at TEXT,
      visibility TEXT NOT NULL DEFAULT 'private', agent_access TEXT NOT NULL DEFAULT 'blocked',
      ai_processing TEXT NOT NULL DEFAULT 'disabled', record_created_at TEXT NOT NULL, record_updated_at TEXT NOT NULL
    );
    CREATE TABLE entry_comments (id INTEGER PRIMARY KEY, entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE, body TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TRIGGER entry_comments_no_update BEFORE UPDATE ON entry_comments BEGIN SELECT RAISE(ABORT, 'entry comments are append-only'); END;
    CREATE TRIGGER entry_comments_no_delete BEFORE DELETE ON entry_comments BEGIN SELECT RAISE(ABORT, 'entry comments are append-only'); END;
    CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT NOT NULL, normalized_name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
    CREATE TABLE entry_tags (entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE, tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE, added_at TEXT NOT NULL, PRIMARY KEY(entry_id, tag_id));
    CREATE TABLE entry_snapshots (id INTEGER PRIMARY KEY, entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE, captured_at TEXT NOT NULL, status TEXT NOT NULL, sha256 TEXT NOT NULL, storage_path TEXT NOT NULL, media_type TEXT NOT NULL, byte_size INTEGER NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE summary_jobs (id INTEGER PRIMARY KEY, entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE, status TEXT NOT NULL, model TEXT NOT NULL, reasoning_effort TEXT NOT NULL, input_sha256 TEXT NOT NULL, input_fields_json TEXT NOT NULL, policy_snapshot_json TEXT NOT NULL, requested_by TEXT NOT NULL, requested_at TEXT NOT NULL, completed_at TEXT, failure_code TEXT);
    CREATE TABLE summaries (id INTEGER PRIMARY KEY, entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE, job_id INTEGER NOT NULL UNIQUE REFERENCES summary_jobs(id) ON DELETE CASCADE, summary_text TEXT NOT NULL, model TEXT NOT NULL, reasoning_effort TEXT NOT NULL, input_sha256 TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX entries_saved_at_id_idx ON entries(saved_at DESC, id DESC);
    CREATE INDEX entries_kind_idx ON entries(kind);
    CREATE INDEX entries_provider_idx ON entries(provider);
    CREATE INDEX entries_source_domain_idx ON entries(source_domain);
    CREATE INDEX entries_visibility_agent_access_idx ON entries(visibility, agent_access);
    CREATE INDEX entry_comments_entry_id_created_at_idx ON entry_comments(entry_id, created_at, id);
    CREATE INDEX entry_tags_tag_id_entry_id_idx ON entry_tags(tag_id, entry_id);
    CREATE INDEX entry_snapshots_entry_id_idx ON entry_snapshots(entry_id, captured_at DESC, id DESC);
    CREATE INDEX summary_jobs_entry_id_requested_at_idx ON summary_jobs(entry_id, requested_at DESC, id DESC);
    PRAGMA user_version = 1;
  `);
  const timestamp = "2026-01-01T00:00:00.000Z";
  db.prepare("INSERT INTO entries (id, url_original, url_canonical, title, kind, kind_source, provider, source_domain, typed_metadata_json, saved_at, visibility, agent_access, ai_processing, record_created_at, record_updated_at) VALUES (1, ?, ?, 'fixture', 'page', 'derived', 'generic-web', 'example.test', '{}', ?, 'normal', 'allowed', 'manual', ?, ?)").run("https://example.test/a", "https://example.test/a", timestamp, timestamp, timestamp);
  db.prepare("INSERT INTO entry_comments (id, entry_id, body, created_at) VALUES (1, 1, 'note', ?)").run(timestamp);
  db.prepare("INSERT INTO tags (id, name, normalized_name, created_at) VALUES (1, 'Fixture', 'fixture', ?)").run(timestamp);
  db.prepare("INSERT INTO entry_tags (entry_id, tag_id, added_at) VALUES (1, 1, ?)").run(timestamp);
  db.prepare("INSERT INTO entry_snapshots (id, entry_id, captured_at, status, sha256, storage_path, media_type, byte_size, created_at) VALUES (7, 1, ?, 'ready', 'abc123', 'snapshots/fixture.png', 'image/png', 42, ?)").run(timestamp, timestamp);
  db.prepare("INSERT INTO summary_jobs (id, entry_id, status, model, reasoning_effort, input_sha256, input_fields_json, policy_snapshot_json, requested_by, requested_at) VALUES (1, 1, 'queued', 'gpt-5.6-luna', 'max', 'input-hash', '[]', '{}', 'test', ?)").run(timestamp);
  db.close();
}

test("database path resolution prefers explicit input, then environment, then the project data directory", () => {
  const directory = temporaryDirectory();
  const repositoryDataDirectory = path.resolve(__dirname, "..", "data");
  try {
    const explicit = path.join(directory, "explicit.sqlite3");
    const fromEnv = path.join(directory, "from-env.sqlite3");
    assert.equal(resolveDatabasePath(explicit, { env: { WEB_BOOKMARK_HUB_DB: fromEnv } }), explicit);
    assert.equal(resolveDatabasePath(undefined, { env: { WEB_BOOKMARK_HUB_DB: fromEnv } }), fromEnv);
    assert.equal(resolveDatabasePath(undefined, { env: {} }), path.join(repositoryDataDirectory, "registry.sqlite3"));
    assert.equal(
      resolveDatabasePath(undefined, { platform: "win32", repositoryRoot: "C:\\Project", env: {} }),
      "C:\\Project\\data\\registry.sqlite3"
    );
    assert.equal(
      resolveDatabasePath(undefined, { platform: "linux", repositoryRoot: "/project", env: {} }),
      "/project/data/registry.sqlite3"
    );
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("opening a registry creates versioned schema, foreign keys, and append-only comments", () => {
  const directory = temporaryDirectory();
  let registry;
  try {
    const dbPath = path.join(directory, "data", "registry.sqlite3");
    registry = openRegistry({ dbPath });
    assert.equal(registry.dbPath, dbPath);
    assert.equal(registry.dataDir, getApplicationDataDir(dbPath));
    assert.equal(registry.db.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
    assert.equal(registry.db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
    const names = registry.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name);
    assert.deepEqual(names.filter((name) => !name.startsWith("sqlite_")).sort(), ["ai_summary_attempts", "api_clients", "capture_policy_defaults", "capture_policy_rule_tags", "capture_policy_rules", "capture_request_items", "capture_requests", "entries", "entry_comments", "entry_revisions", "entry_tags", "entry_visual_assets", "file_cleanup_queue", "folders", "registry_meta", "summaries", "summary_jobs", "tags"]);
    assert.equal(registry.db.prepare("SELECT value FROM registry_meta WHERE key = 'schema_id'").get().value, "web-bookmark-hub/registry/v18");
    registry.db.prepare("INSERT INTO entries (url_original, url_canonical, kind, kind_source, provider, source_domain, saved_at, record_created_at, record_updated_at) VALUES (?, ?, 'page', 'derived', 'generic-web', 'example.test', ?, ?, ?)").run("https://example.test/a", "https://example.test/a", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    assert.equal(registry.db.prepare("SELECT content_focus FROM entries WHERE id = 1").get().content_focus, "text");
    registry.db.prepare("INSERT INTO entries (url_original, url_canonical, kind, kind_source, provider, source_domain, saved_at, record_created_at, record_updated_at) VALUES (?, ?, 'page', 'derived', 'generic-web', 'example.test', ?, ?, ?)").run("https://example.test/b", "https://example.test/b", "2026-01-02T00:00:00.000Z", "2026-01-02T00:00:00.000Z", "2026-01-02T00:00:00.000Z");
    assert.equal(registry.db.prepare("SELECT count(*) AS count FROM entries").get().count, 2);
    registry.db.prepare("INSERT INTO entry_comments (entry_id, body, created_at) VALUES (1, 'synthetic', ?)").run("2026-01-01T00:00:00.000Z");
    assert.throws(() => registry.db.exec("UPDATE entry_comments SET body = 'changed' WHERE id = 1"), /append-only/);
    assert.throws(() => registry.db.exec("DELETE FROM entry_comments WHERE id = 1"), /append-only/);
    registry.db.prepare(`
      INSERT INTO entry_revisions (
        entry_id, revision_number, action, actor_type, changes_json, created_at
      ) VALUES (1, 1, 'created', 'system', '{}', ?)
    `).run("2026-01-01T00:00:00.000Z");
    assert.throws(() => registry.db.exec("DELETE FROM entry_revisions WHERE entry_id = 1"), /append-only/);
    registry.db.exec("DELETE FROM entries WHERE id = 1");
    assert.equal(registry.db.prepare("SELECT COUNT(*) AS count FROM entry_comments WHERE entry_id = 1").get().count, 0);
    assert.equal(registry.db.prepare("SELECT COUNT(*) AS count FROM entry_revisions WHERE entry_id = 1").get().count, 0);
  } finally { closeAndRemove(registry, directory); }
});

test("a valid v1 registry migrates atomically to v4 without changing existing data or snapshot paths", () => {
  const directory = temporaryDirectory();
  let registry;
  try {
    const dbPath = path.join(directory, "v1.sqlite3");
    createV1Fixture(dbPath);
    registry = openRegistry({ dbPath });
    const { db } = registry;
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 18);
    const migratedEntry = db.prepare("SELECT content_focus, folder_id, created_via FROM entries WHERE id = 1").get();
    assert.equal(migratedEntry.content_focus, "text");
    assert.equal(migratedEntry.created_via, "legacy");
    assert.equal(db.prepare("SELECT count(*) AS count FROM entry_comments").get().count, 1);
    assert.equal(db.prepare("SELECT count(*) AS count FROM entry_tags").get().count, 1);
    assert.equal(db.prepare("SELECT count(*) AS count FROM summary_jobs").get().count, 1);
    assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'entry_snapshots'").get().count, 0);
    const asset = db.prepare("SELECT id, entry_id, source_kind, storage_kind, status, sha256, storage_path, media_type, byte_size, position, is_cover FROM entry_visual_assets WHERE id = 7").get();
    assert.equal(asset.id, 7);
    assert.equal(asset.entry_id, 1);
    assert.equal(asset.source_kind, "page_snapshot");
    assert.equal(asset.storage_kind, "local");
    assert.equal(asset.status, "ready");
    assert.equal(asset.sha256, "abc123");
    assert.equal(asset.storage_path, "snapshots/fixture.png");
    assert.equal(asset.media_type, "image/png");
    assert.equal(asset.byte_size, 42);
    assert.equal(asset.position, 7);
    assert.equal(asset.is_cover, 0);
    const revision = db.prepare("SELECT revision_number, action, actor_type FROM entry_revisions WHERE entry_id = 1").get();
    assert.deepEqual({ ...revision }, { revision_number: 1, action: "created", actor_type: "system" });
  } finally { closeAndRemove(registry, directory); }
});

test("a malformed v1 registry fails closed without a partial migration", () => {
  const directory = temporaryDirectory();
  try {
    const dbPath = path.join(directory, "malformed-v1.sqlite3");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE registry_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO registry_meta VALUES ('schema_id', 'web-bookmark-hub/registry/v1'); PRAGMA user_version = 1;");
    db.close();
    assert.throws(() => openRegistry({ dbPath }), (error) => error.code === "DATABASE_SCHEMA_INVALID");
    const after = new DatabaseSync(dbPath);
    assert.equal(after.prepare("PRAGMA user_version").get().user_version, 1);
    assert.equal(after.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'folders'").get().count, 0);
    after.close();
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("a failed v1 migration rolls back v2 DDL and retains the readable v1 version", () => {
  const directory = temporaryDirectory();
  try {
    const dbPath = path.join(directory, "rollback-v1.sqlite3");
    createV1Fixture(dbPath);
    const before = new DatabaseSync(dbPath);
    before.exec("CREATE TABLE folders (id INTEGER PRIMARY KEY)");
    before.close();
    assert.throws(() => openRegistry({ dbPath }), (error) => error.code === "DATABASE_MIGRATION_FAILED");
    const after = new DatabaseSync(dbPath);
    assert.equal(after.prepare("PRAGMA user_version").get().user_version, 1);
    assert.equal(after.prepare("PRAGMA table_info(entries)").all().some((column) => column.name === "content_focus"), false);
    assert.equal(after.prepare("SELECT count(*) AS count FROM entry_snapshots WHERE id = 7").get().count, 1);
    after.close();
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("future schema versions fail closed and only the ignored project data directory is accepted", () => {
  const directory = temporaryDirectory();
  const repositoryDataDirectory = path.resolve(__dirname, "..", "data");
  let registry;
  try {
    const dbPath = path.join(directory, "newer.sqlite3");
    const db = new DatabaseSync(dbPath);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    db.close();
    assert.throws(() => openRegistry({ dbPath }), (error) => error.code === "DATABASE_VERSION_UNSUPPORTED");
    assert.throws(() => assertPathOutsideRepository(path.join(process.cwd(), "registry.sqlite3")), (error) => error.code === "DATA_PATH_IN_REPOSITORY");
    assert.equal(
      assertRegistryDataPath(path.join(repositoryDataDirectory, "registry.sqlite3")),
      path.join(repositoryDataDirectory, "registry.sqlite3")
    );
    assert.throws(
      () => assertRegistryDataPath(path.join(process.cwd(), "registry.sqlite3")),
      (error) => error.code === "REGISTRY_DATA_PATH_INVALID"
    );
  } finally { closeAndRemove(registry, directory); }
});

test("a claimed current version with missing schema fails closed", () => {
  const directory = temporaryDirectory();
  try {
    const dbPath = path.join(directory, "malformed.sqlite3");
    const db = new DatabaseSync(dbPath);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.close();
    assert.throws(
      () => openRegistry({ dbPath }),
      (error) => error.code === "DATABASE_SCHEMA_INVALID"
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a path routed through a link into the repository is rejected", (context) => {
  const directory = temporaryDirectory();
  const linkPath = path.join(directory, "repo-link");
  try {
    try {
      fs.symlinkSync(path.resolve(__dirname, ".."), linkPath, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      context.skip(`directory links are unavailable: ${error.code || error.message}`);
      return;
    }
    assert.throws(
      () => assertPathOutsideRepository(path.join(linkPath, "linked.sqlite3")),
      (error) => error.code === "DATA_PATH_IN_REPOSITORY"
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("the configured project-relative default opens only under an isolated repository data directory", () => {
  const directory = temporaryDirectory();
  const repositoryRoot = path.join(directory, "isolated-project");
  let registry;
  try {
    registry = openRegistry({ repositoryRoot, env: {} });
    assert.equal(registry.dbPath, path.join(repositoryRoot, "data", "registry.sqlite3"));
    assert.equal(registry.dataDir, path.join(repositoryRoot, "data", "registry.sqlite3.data"));
    assert.equal(fs.existsSync(registry.dbPath), true);
  } finally {
    closeAndRemove(registry, directory);
  }
});

test("a project data link cannot route registry files outside the project", (context) => {
  const directory = temporaryDirectory();
  const repositoryRoot = path.join(directory, "repository");
  const dataDirectory = path.join(repositoryRoot, "data");
  const outsideDirectory = path.join(directory, "outside");
  const linkPath = path.join(dataDirectory, "escape");
  try {
    fs.mkdirSync(dataDirectory, { recursive: true });
    fs.mkdirSync(outsideDirectory, { recursive: true });
    try {
      fs.symlinkSync(outsideDirectory, linkPath, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      context.skip(`directory links are unavailable: ${error.code || error.message}`);
      return;
    }
    assert.throws(
      () => assertRegistryDataPath(path.join(linkPath, "registry.sqlite3"), { repositoryRoot }),
      (error) => error.code === "REGISTRY_DATA_PATH_INVALID"
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
