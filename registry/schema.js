"use strict";

const { RegistryError } = require("./errors");
const { ENTRY_KINDS } = require("./constants.js");

const SCHEMA_VERSION = 17;
const SCHEMA_ID = "web-bookmark-hub/registry/v17";
const V16_SCHEMA_ID = "web-bookmark-hub/registry/v16";
const V15_SCHEMA_ID = "web-bookmark-hub/registry/v15";
const V14_SCHEMA_ID = "web-bookmark-hub/registry/v14";
const V13_SCHEMA_ID = "web-bookmark-hub/registry/v13";
const V12_SCHEMA_ID = "web-bookmark-hub/registry/v12";
const V11_SCHEMA_ID = "web-bookmark-hub/registry/v11";
const V10_SCHEMA_ID = "web-bookmark-hub/registry/v10";
const V9_SCHEMA_ID = "web-bookmark-hub/registry/v9";
const V8_SCHEMA_ID = "web-bookmark-hub/registry/v8";
const V7_SCHEMA_ID = "web-bookmark-hub/registry/v7";
const V6_SCHEMA_ID = "web-bookmark-hub/registry/v6";
const V5_SCHEMA_ID = "web-bookmark-hub/registry/v5";
const V4_SCHEMA_ID = "web-bookmark-hub/registry/v4";
const V3_SCHEMA_ID = "web-bookmark-hub/registry/v3";
const V2_SCHEMA_ID = "web-bookmark-hub/registry/v2";
const V1_SCHEMA_ID = "web-bookmark-hub/registry/v1";
const V1_REQUIRED_COLUMNS = Object.freeze({
  registry_meta: ["key", "value"],
  entries: [
    "id", "url_original", "url_canonical", "title", "kind", "kind_source", "provider",
    "source_domain", "typed_metadata_json", "saved_at", "published_at", "updated_at",
    "visibility", "agent_access", "ai_processing", "record_created_at", "record_updated_at"
  ],
  entry_comments: ["id", "entry_id", "body", "created_at"],
  tags: ["id", "name", "normalized_name", "created_at"],
  entry_tags: ["entry_id", "tag_id", "added_at"],
  entry_snapshots: [
    "id", "entry_id", "captured_at", "status", "sha256", "storage_path", "media_type",
    "byte_size", "created_at"
  ],
  summary_jobs: [
    "id", "entry_id", "status", "model", "reasoning_effort", "input_sha256",
    "input_fields_json", "policy_snapshot_json", "requested_by", "requested_at",
    "completed_at", "failure_code"
  ],
  summaries: [
    "id", "entry_id", "job_id", "summary_text", "model", "reasoning_effort",
    "input_sha256", "created_at"
  ]
});

const V2_REQUIRED_COLUMNS = Object.freeze({
  registry_meta: V1_REQUIRED_COLUMNS.registry_meta,
  entries: [...V1_REQUIRED_COLUMNS.entries, "folder_id", "content_focus"],
  entry_comments: V1_REQUIRED_COLUMNS.entry_comments,
  tags: V1_REQUIRED_COLUMNS.tags,
  entry_tags: V1_REQUIRED_COLUMNS.entry_tags,
  summary_jobs: V1_REQUIRED_COLUMNS.summary_jobs,
  summaries: V1_REQUIRED_COLUMNS.summaries,
  folders: ["id", "parent_id", "name", "normalized_name", "created_at", "updated_at"],
  entry_visual_assets: [
    "id", "entry_id", "source_kind", "source_url", "storage_kind", "captured_at", "status",
    "sha256", "storage_path", "media_type", "byte_size", "position", "is_cover", "created_at", "updated_at"
  ],
});

const V3_REQUIRED_COLUMNS = Object.freeze({
  ...V2_REQUIRED_COLUMNS,
  entries: [
    ...V2_REQUIRED_COLUMNS.entries,
    "created_via", "capture_adapter", "capture_request_id", "capture_item_index"
  ],
  capture_requests: [
    "id", "requester_scope", "client_request_id", "payload_sha256", "channel",
    "adapter", "state", "item_count", "requested_at", "completed_at"
  ],
  capture_request_items: [
    "request_id", "item_index", "outcome_code", "entry_id", "details_json", "recorded_at"
  ],
  api_clients: [
    "id", "token_sha256", "extension_id", "label", "created_at", "last_used_at", "revoked_at"
  ],
});

const V4_REQUIRED_COLUMNS = Object.freeze({
  ...V3_REQUIRED_COLUMNS,
  entries: [...V3_REQUIRED_COLUMNS.entries, "deleted_at"],
  entry_revisions: [
    "id", "entry_id", "revision_number", "action", "actor_type", "actor_id",
    "changes_json", "reason", "created_at"
  ],
  capture_policy_defaults: [
    "id", "visibility", "agent_access", "ai_processing", "created_at", "updated_at"
  ],
  capture_policy_rules: [
    "id", "hostname", "path_prefix", "visibility", "agent_access", "ai_processing",
    "enabled", "position", "created_at", "updated_at"
  ],
});

const V7_REQUIRED_COLUMNS = Object.freeze({
  ...V4_REQUIRED_COLUMNS,
  entries: [...V4_REQUIRED_COLUMNS.entries, "title_origin"],
});

const V9_REQUIRED_COLUMNS = Object.freeze({
  ...V7_REQUIRED_COLUMNS,
  capture_policy_defaults: [
    ...V7_REQUIRED_COLUMNS.capture_policy_defaults,
    "selected_image_storage"
  ],
  capture_policy_rules: [...V7_REQUIRED_COLUMNS.capture_policy_rules, "kind"],
});

const V10_REQUIRED_COLUMNS = Object.freeze({
  ...V9_REQUIRED_COLUMNS,
  file_cleanup_queue: ["storage_path", "reason", "enqueued_at", "attempts", "failure_code"]
});

const V11_REQUIRED_COLUMNS = Object.freeze({
  ...V10_REQUIRED_COLUMNS,
  entry_link_health: [
    "entry_id", "checked_at", "status", "http_status", "final_url", "redirect_count", "failure_code"
  ]
});

const V13_REQUIRED_COLUMNS = Object.freeze({
  ...V10_REQUIRED_COLUMNS,
  capture_policy_rule_tags: ["rule_id", "tag_id", "position"]
});

const V16_REQUIRED_COLUMNS = Object.freeze({
  ...V13_REQUIRED_COLUMNS,
  capture_policy_rules: [...V13_REQUIRED_COLUMNS.capture_policy_rules, "capture_mode"]
});
const REQUIRED_COLUMNS = Object.freeze({
  ...V16_REQUIRED_COLUMNS,
  ai_summary_attempts: [
    "id", "entry_id", "source", "started_at", "completed_at", "status", "error_code",
    "total_ms", "evidence_ms", "media_ms", "model_ms", "input_tokens",
    "cached_input_tokens", "output_tokens", "legacy_job_id"
  ]
});

const V1_REQUIRED_INDEXES = Object.freeze([
  "entries_saved_at_id_idx",
  "entries_kind_idx",
  "entries_provider_idx",
  "entries_source_domain_idx",
  "entries_visibility_agent_access_idx",
  "entry_comments_entry_id_created_at_idx",
  "entry_tags_tag_id_entry_id_idx",
  "entry_snapshots_entry_id_idx",
  "summary_jobs_entry_id_requested_at_idx",
]);

const V2_REQUIRED_INDEXES = Object.freeze([
  "entries_saved_at_id_idx",
  "entries_kind_idx",
  "entries_provider_idx",
  "entries_source_domain_idx",
  "entries_visibility_agent_access_idx",
  "entry_comments_entry_id_created_at_idx",
  "entry_tags_tag_id_entry_id_idx",
  "summary_jobs_entry_id_requested_at_idx",
  "folders_root_normalized_name_uq",
  "folders_sibling_normalized_name_uq",
  "folders_parent_id_name_idx",
  "entries_folder_id_idx",
  "entries_content_focus_idx",
  "entry_visual_assets_entry_id_position_idx",
  "entry_visual_assets_one_cover_uq",
]);

const V3_REQUIRED_INDEXES = Object.freeze([
  ...V2_REQUIRED_INDEXES,
  "entries_capture_item_uq",
  "capture_requests_scope_uuid_uq",
  "capture_request_items_entry_id_idx",
  "api_clients_token_sha256_uq",
  "api_clients_extension_id_idx",
]);

const V4_REQUIRED_INDEXES = Object.freeze([
  ...V3_REQUIRED_INDEXES,
  "entries_active_saved_at_id_idx",
  "entry_revisions_entry_revision_uq",
  "entry_revisions_entry_created_at_idx",
  "capture_policy_rules_match_idx",
  "capture_policy_rules_position_idx",
]);

const V9_REQUIRED_INDEXES = V4_REQUIRED_INDEXES;
const V10_REQUIRED_INDEXES = Object.freeze([...V9_REQUIRED_INDEXES, "file_cleanup_queue_enqueued_at_idx"]);
const V13_REQUIRED_INDEXES = Object.freeze([...V10_REQUIRED_INDEXES, "capture_policy_rule_tags_tag_idx"]);
const V16_REQUIRED_INDEXES = V13_REQUIRED_INDEXES;
const REQUIRED_INDEXES = Object.freeze([...V16_REQUIRED_INDEXES, "ai_summary_attempts_entry_id_idx"]);
const ENTRY_KIND_CHECK_SQL = ENTRY_KINDS.map((kind) => `'${kind}'`).join(",");
const V8_ENTRY_KIND_CHECK_SQL = "'article','social','video','animation','image','research','code','conversation','page'";

const ENTRY_TABLE_SQL = entryTableSql(ENTRY_KIND_CHECK_SQL, "'none','user','page','capture_caption','ai'");
const V15_ENTRY_TABLE_SQL = entryTableSql(ENTRY_KIND_CHECK_SQL, "'none','user','page','capture_caption'");
const V8_ENTRY_TABLE_SQL = entryTableSql(V8_ENTRY_KIND_CHECK_SQL);

function entryTableSql(kindCheckSql, titleOrigins = "'none','user','page','capture_caption'") {
  return `
CREATE TABLE entries (
  id INTEGER PRIMARY KEY,
  url_original TEXT NOT NULL,
  url_canonical TEXT NOT NULL,
  title TEXT,
  title_origin TEXT NOT NULL DEFAULT 'none' CHECK(title_origin IN (${titleOrigins})),
  kind TEXT NOT NULL CHECK(kind IN (${kindCheckSql})),
  kind_source TEXT NOT NULL CHECK(kind_source IN ('derived','user')),
  provider TEXT NOT NULL,
  source_domain TEXT NOT NULL,
  typed_metadata_json TEXT NOT NULL DEFAULT '{}'
    CHECK(json_valid(typed_metadata_json) AND json_type(typed_metadata_json) = 'object'),
  saved_at TEXT NOT NULL,
  published_at TEXT,
  updated_at TEXT,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK(visibility IN ('normal','private')),
  agent_access TEXT NOT NULL DEFAULT 'blocked' CHECK(agent_access IN ('blocked','metadata_only','allowed')),
  ai_processing TEXT NOT NULL DEFAULT 'disabled' CHECK(ai_processing IN ('disabled','manual','enabled')),
  folder_id INTEGER REFERENCES folders(id) ON DELETE RESTRICT,
  content_focus TEXT NOT NULL DEFAULT 'text' CHECK(content_focus IN ('text','visual')),
  created_via TEXT NOT NULL DEFAULT 'legacy' CHECK(created_via IN ('legacy','cli','web','chrome','manifest_import')),
  capture_adapter TEXT,
  capture_request_id INTEGER REFERENCES capture_requests(id) ON DELETE RESTRICT,
  capture_item_index INTEGER CHECK(capture_item_index >= 0),
  deleted_at TEXT,
  record_created_at TEXT NOT NULL,
  record_updated_at TEXT NOT NULL,
  CHECK(
    (capture_request_id IS NULL AND capture_item_index IS NULL)
    OR
    (capture_request_id IS NOT NULL AND capture_item_index IS NOT NULL)
  )
);
`;
}

const CAPTURE_POLICY_RULE_TABLE_SQL = `
CREATE TABLE capture_policy_rules (
  id INTEGER PRIMARY KEY,
  hostname TEXT NOT NULL,
  path_prefix TEXT NOT NULL DEFAULT '/',
  kind TEXT CHECK(kind IN (${ENTRY_KIND_CHECK_SQL})),
  visibility TEXT NOT NULL CHECK(visibility IN ('normal','private')),
  agent_access TEXT NOT NULL CHECK(agent_access IN ('blocked','metadata_only','allowed')),
  ai_processing TEXT NOT NULL CHECK(ai_processing IN ('disabled','manual','enabled')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  position INTEGER NOT NULL CHECK(position >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  capture_mode TEXT NOT NULL DEFAULT 'all' CHECK(capture_mode IN ('all','page','selected_images')),
  UNIQUE(hostname, path_prefix, capture_mode)
);
`;

const CAPTURE_POLICY_RULE_TAG_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS capture_policy_rule_tags (
  rule_id INTEGER NOT NULL REFERENCES capture_policy_rules(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK(position >= 0),
  PRIMARY KEY(rule_id, tag_id)
);
`;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS registry_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO registry_meta (key, value)
VALUES ('schema_id', '${SCHEMA_ID}')
ON CONFLICT(key) DO NOTHING;

${ENTRY_TABLE_SQL}

CREATE TABLE IF NOT EXISTS entry_comments (
  id INTEGER PRIMARY KEY,
  entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS entry_comments_no_update
BEFORE UPDATE ON entry_comments
BEGIN SELECT RAISE(ABORT, 'entry comments are append-only'); END;
CREATE TRIGGER IF NOT EXISTS entry_comments_no_delete
BEFORE DELETE ON entry_comments
WHEN EXISTS (SELECT 1 FROM entries WHERE id = OLD.entry_id)
BEGIN SELECT RAISE(ABORT, 'entry comments are append-only'); END;

CREATE TRIGGER IF NOT EXISTS entries_capture_provenance_insert
BEFORE INSERT ON entries
WHEN (NEW.capture_request_id IS NULL) != (NEW.capture_item_index IS NULL)
BEGIN SELECT RAISE(ABORT, 'capture provenance must be complete'); END;
CREATE TRIGGER IF NOT EXISTS entries_capture_provenance_update
BEFORE UPDATE OF capture_request_id, capture_item_index ON entries
WHEN (NEW.capture_request_id IS NULL) != (NEW.capture_item_index IS NULL)
BEGIN SELECT RAISE(ABORT, 'capture provenance must be complete'); END;

CREATE TRIGGER IF NOT EXISTS entries_canonical_url_unique_insert
BEFORE INSERT ON entries
WHEN EXISTS (SELECT 1 FROM entries WHERE url_canonical = NEW.url_canonical)
BEGIN SELECT RAISE(ABORT, 'canonical URL already exists'); END;
CREATE TRIGGER IF NOT EXISTS entries_canonical_url_unique_update
BEFORE UPDATE OF url_canonical ON entries
WHEN EXISTS (SELECT 1 FROM entries WHERE id != OLD.id AND url_canonical = NEW.url_canonical)
BEGIN SELECT RAISE(ABORT, 'canonical URL already exists'); END;

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entry_tags (
  entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  added_at TEXT NOT NULL,
  PRIMARY KEY(entry_id, tag_id)
);

CREATE TABLE IF NOT EXISTS folders (
  id INTEGER PRIMARY KEY,
  parent_id INTEGER REFERENCES folders(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entry_visual_assets (
  id INTEGER PRIMARY KEY,
  entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('user_upload','browser_selected','provider_thumbnail','page_snapshot','imported')),
  source_url TEXT,
  storage_kind TEXT NOT NULL CHECK(storage_kind IN ('local','remote')),
  captured_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('ready','referenced','missing','error')),
  sha256 TEXT,
  storage_path TEXT,
  media_type TEXT,
  byte_size INTEGER CHECK(byte_size >= 0),
  position INTEGER NOT NULL CHECK(position >= 0),
  is_cover INTEGER NOT NULL DEFAULT 0 CHECK(is_cover IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(
    (storage_kind = 'local' AND status IN ('ready','missing','error') AND sha256 IS NOT NULL AND storage_path IS NOT NULL AND media_type IS NOT NULL AND byte_size IS NOT NULL)
    OR
    (storage_kind = 'remote' AND status IN ('referenced','error') AND source_url IS NOT NULL AND sha256 IS NULL AND storage_path IS NULL AND media_type IS NULL AND byte_size IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS capture_requests (
  id INTEGER PRIMARY KEY,
  requester_scope TEXT NOT NULL,
  client_request_id TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256) = 64),
  channel TEXT NOT NULL CHECK(channel IN ('web','chrome','manifest_import')),
  adapter TEXT,
  state TEXT NOT NULL CHECK(state IN ('processing','completed')),
  item_count INTEGER NOT NULL CHECK(item_count >= 0),
  requested_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS capture_request_items (
  request_id INTEGER NOT NULL REFERENCES capture_requests(id) ON DELETE CASCADE,
  item_index INTEGER NOT NULL CHECK(item_index >= 0),
  outcome_code TEXT NOT NULL,
  entry_id INTEGER REFERENCES entries(id) ON DELETE SET NULL,
  details_json TEXT NOT NULL DEFAULT '{}'
    CHECK(json_valid(details_json) AND json_type(details_json) = 'object'),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY(request_id, item_index)
);

CREATE TABLE IF NOT EXISTS api_clients (
  id INTEGER PRIMARY KEY,
  token_sha256 TEXT NOT NULL CHECK(length(token_sha256) = 64),
  extension_id TEXT NOT NULL,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS entry_revisions (
  id INTEGER PRIMARY KEY,
  entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  revision_number INTEGER NOT NULL CHECK(revision_number >= 1),
  action TEXT NOT NULL CHECK(action IN ('created','updated','archived','restored')),
  actor_type TEXT NOT NULL CHECK(actor_type IN ('user','agent','system')),
  actor_id TEXT,
  changes_json TEXT NOT NULL
    CHECK(json_valid(changes_json) AND json_type(changes_json) = 'object'),
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS entry_revisions_no_update
BEFORE UPDATE ON entry_revisions
BEGIN SELECT RAISE(ABORT, 'entry revisions are append-only'); END;
CREATE TRIGGER IF NOT EXISTS entry_revisions_no_delete
BEFORE DELETE ON entry_revisions
WHEN EXISTS (SELECT 1 FROM entries WHERE id = OLD.entry_id)
BEGIN SELECT RAISE(ABORT, 'entry revisions are append-only'); END;

CREATE TABLE IF NOT EXISTS capture_policy_defaults (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  visibility TEXT NOT NULL CHECK(visibility IN ('normal','private')),
  agent_access TEXT NOT NULL CHECK(agent_access IN ('blocked','metadata_only','allowed')),
  ai_processing TEXT NOT NULL CHECK(ai_processing IN ('disabled','manual','enabled')),
  selected_image_storage TEXT CHECK(selected_image_storage IN ('reference_only','local_copy')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS file_cleanup_queue (
  storage_path TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  enqueued_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  failure_code TEXT
);

INSERT INTO capture_policy_defaults (
  id, visibility, agent_access, ai_processing, created_at, updated_at
) VALUES (
  1, 'private', 'blocked', 'disabled',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
ON CONFLICT(id) DO NOTHING;

${CAPTURE_POLICY_RULE_TABLE_SQL}
${CAPTURE_POLICY_RULE_TAG_TABLE_SQL}

CREATE TABLE IF NOT EXISTS summary_jobs (
  id INTEGER PRIMARY KEY,
  entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled')),
  model TEXT NOT NULL CHECK(model = 'gpt-5.6-luna'),
  reasoning_effort TEXT NOT NULL CHECK(reasoning_effort = 'max'),
  input_sha256 TEXT NOT NULL,
  input_fields_json TEXT NOT NULL
    CHECK(json_valid(input_fields_json) AND json_type(input_fields_json) = 'array'),
  policy_snapshot_json TEXT NOT NULL
    CHECK(json_valid(policy_snapshot_json) AND json_type(policy_snapshot_json) = 'object'),
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  completed_at TEXT,
  failure_code TEXT
);

CREATE TABLE IF NOT EXISTS summaries (
  id INTEGER PRIMARY KEY,
  entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  job_id INTEGER NOT NULL UNIQUE REFERENCES summary_jobs(id) ON DELETE CASCADE,
  summary_text TEXT NOT NULL,
  model TEXT NOT NULL CHECK(model = 'gpt-5.6-luna'),
  reasoning_effort TEXT NOT NULL CHECK(reasoning_effort = 'max'),
  input_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_summary_attempts (
  id INTEGER PRIMARY KEY,
  entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK(source IN ('legacy','pipeline')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL CHECK(status IN ('running','complete','partial','failed')),
  error_code TEXT,
  total_ms INTEGER,
  evidence_ms INTEGER,
  media_ms INTEGER,
  model_ms INTEGER,
  input_tokens INTEGER,
  cached_input_tokens INTEGER,
  output_tokens INTEGER,
  legacy_job_id INTEGER UNIQUE
);

CREATE INDEX IF NOT EXISTS entries_saved_at_id_idx ON entries(saved_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS entries_kind_idx ON entries(kind);
CREATE INDEX IF NOT EXISTS entries_provider_idx ON entries(provider);
CREATE INDEX IF NOT EXISTS entries_source_domain_idx ON entries(source_domain);
CREATE INDEX IF NOT EXISTS entries_visibility_agent_access_idx ON entries(visibility, agent_access);
CREATE INDEX IF NOT EXISTS entry_comments_entry_id_created_at_idx ON entry_comments(entry_id, created_at, id);
CREATE INDEX IF NOT EXISTS entry_tags_tag_id_entry_id_idx ON entry_tags(tag_id, entry_id);
CREATE INDEX IF NOT EXISTS summary_jobs_entry_id_requested_at_idx ON summary_jobs(entry_id, requested_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS ai_summary_attempts_entry_id_idx ON ai_summary_attempts(entry_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS folders_root_normalized_name_uq ON folders(normalized_name) WHERE parent_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS folders_sibling_normalized_name_uq ON folders(parent_id, normalized_name) WHERE parent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS folders_parent_id_name_idx ON folders(parent_id, normalized_name, id);
CREATE INDEX IF NOT EXISTS entries_folder_id_idx ON entries(folder_id, saved_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS entries_content_focus_idx ON entries(content_focus, saved_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS entry_visual_assets_entry_id_position_idx ON entry_visual_assets(entry_id, position, id);
CREATE UNIQUE INDEX IF NOT EXISTS entry_visual_assets_one_cover_uq ON entry_visual_assets(entry_id) WHERE is_cover = 1;
CREATE UNIQUE INDEX IF NOT EXISTS entries_capture_item_uq ON entries(capture_request_id, capture_item_index) WHERE capture_request_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS capture_requests_scope_uuid_uq ON capture_requests(requester_scope, client_request_id);
CREATE INDEX IF NOT EXISTS capture_request_items_entry_id_idx ON capture_request_items(entry_id) WHERE entry_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS api_clients_token_sha256_uq ON api_clients(token_sha256);
CREATE INDEX IF NOT EXISTS api_clients_extension_id_idx ON api_clients(extension_id, revoked_at, id);
CREATE INDEX IF NOT EXISTS entries_active_saved_at_id_idx ON entries(saved_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS entry_revisions_entry_revision_uq ON entry_revisions(entry_id, revision_number);
CREATE INDEX IF NOT EXISTS entry_revisions_entry_created_at_idx ON entry_revisions(entry_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS capture_policy_rules_match_idx ON capture_policy_rules(hostname, path_prefix, enabled);
CREATE INDEX IF NOT EXISTS capture_policy_rules_position_idx ON capture_policy_rules(position, id);
CREATE INDEX IF NOT EXISTS capture_policy_rule_tags_tag_idx ON capture_policy_rule_tags(tag_id, rule_id);
CREATE INDEX IF NOT EXISTS file_cleanup_queue_enqueued_at_idx ON file_cleanup_queue(enqueued_at, storage_path);
`;

function initializeSchema(db, transaction) {
  if (typeof transaction !== "function") {
    throw new TypeError("initializeSchema requires a transaction runner.");
  }
  const version = Number(db.prepare("PRAGMA user_version").get().user_version);
  if (version > SCHEMA_VERSION) {
    throw new RegistryError(
      "DATABASE_VERSION_UNSUPPORTED",
      `Database schema version ${version} is newer than supported version ${SCHEMA_VERSION}.`,
      { actualVersion: version, supportedVersion: SCHEMA_VERSION },
    );
  }
  if (version === 0) {
    transaction(db, () => {
      db.exec(SCHEMA_SQL);
      validateSchema(db);
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    });
    return;
  }
  if (version === 1) {
    migrateV1ToV7(db, transaction);
    return;
  }
  if (version === 2) {
    migrateV2ToV7(db, transaction);
    return;
  }
  if (version === 3) {
    migrateV3ToV7(db, transaction);
    return;
  }
  if (version === 4) {
    migrateV4ToV7(db, transaction);
    return;
  }
  if (version === 5) {
    migrateV5ToV7(db, transaction);
    return;
  }
  if (version === 6) {
    migrateV6ToV7(db, transaction);
    return;
  }
  if (version === 7) {
    migrateV7ToV8(db, transaction);
    return;
  }
  if (version === 8) {
    migrateV8ToV9(db, transaction);
    return;
  }
  if (version === 9) {
    migrateV9ToV10(db, transaction);
    return;
  }
  if (version === 10) {
    migrateV10ToV12(db, transaction);
    return;
  }
  if (version === 11) {
    migrateV11ToV12(db, transaction);
    return;
  }
  if (version === 12) {
    migrateV12ToV13(db, transaction);
    return;
  }
  if (version === 13) {
    migrateV13ToV14(db, transaction);
    return;
  }
  if (version === 14) {
    migrateV14ToV15(db, transaction);
    return;
  }
  if (version === 15) {
    migrateV15ToV16(db, transaction);
    return;
  }
  if (version === 16) {
    migrateV16ToV17(db, transaction);
    return;
  }
  validateSchema(db);
}

function migrateV1ToV7(db, transaction) {
  try {
    transaction(db, () => {
      validateSchema(db, 1);
      db.exec("ALTER TABLE entries ADD COLUMN folder_id INTEGER REFERENCES folders(id) ON DELETE RESTRICT");
      db.exec("ALTER TABLE entries ADD COLUMN content_focus TEXT NOT NULL DEFAULT 'text' CHECK(content_focus IN ('text','visual'))");
      db.exec(`
        CREATE TABLE folders (
          id INTEGER PRIMARY KEY,
          parent_id INTEGER REFERENCES folders(id) ON DELETE RESTRICT,
          name TEXT NOT NULL,
          normalized_name TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE entry_visual_assets (
          id INTEGER PRIMARY KEY,
          entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
          source_kind TEXT NOT NULL CHECK(source_kind IN ('user_upload','browser_selected','provider_thumbnail','page_snapshot','imported')),
          source_url TEXT,
          storage_kind TEXT NOT NULL CHECK(storage_kind IN ('local','remote')),
          captured_at TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('ready','referenced','missing','error')),
          sha256 TEXT,
          storage_path TEXT,
          media_type TEXT,
          byte_size INTEGER CHECK(byte_size >= 0),
          position INTEGER NOT NULL CHECK(position >= 0),
          is_cover INTEGER NOT NULL DEFAULT 0 CHECK(is_cover IN (0,1)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          CHECK(
            (storage_kind = 'local' AND status IN ('ready','missing','error') AND sha256 IS NOT NULL AND storage_path IS NOT NULL AND media_type IS NOT NULL AND byte_size IS NOT NULL)
            OR
            (storage_kind = 'remote' AND status IN ('referenced','error') AND source_url IS NOT NULL AND sha256 IS NULL AND storage_path IS NULL AND media_type IS NULL AND byte_size IS NULL)
          )
        );
        CREATE UNIQUE INDEX folders_root_normalized_name_uq ON folders(normalized_name) WHERE parent_id IS NULL;
        CREATE UNIQUE INDEX folders_sibling_normalized_name_uq ON folders(parent_id, normalized_name) WHERE parent_id IS NOT NULL;
        CREATE INDEX folders_parent_id_name_idx ON folders(parent_id, normalized_name, id);
        CREATE INDEX entries_folder_id_idx ON entries(folder_id, saved_at DESC, id DESC);
        CREATE INDEX entries_content_focus_idx ON entries(content_focus, saved_at DESC, id DESC);
        CREATE INDEX entry_visual_assets_entry_id_position_idx ON entry_visual_assets(entry_id, position, id);
        CREATE UNIQUE INDEX entry_visual_assets_one_cover_uq ON entry_visual_assets(entry_id) WHERE is_cover = 1;
      `);
      db.prepare(`
        INSERT INTO entry_visual_assets (
          id, entry_id, source_kind, source_url, storage_kind, captured_at, status,
          sha256, storage_path, media_type, byte_size, position, is_cover, created_at, updated_at
        )
        SELECT id, entry_id, 'page_snapshot', NULL, 'local', captured_at, status,
          sha256, storage_path, media_type, byte_size, id, 0, created_at, created_at
        FROM entry_snapshots
      `).run();
      db.exec("DROP TABLE entry_snapshots");
      db.prepare("UPDATE registry_meta SET value = ? WHERE key = 'schema_id'").run(V2_SCHEMA_ID);
      db.exec("PRAGMA user_version = 2");
      validateSchema(db, 2);
      applyV2ToV3(db);
      applyV3ToV4(db);
      applyV4ToV5(db);
      applyV5ToV6(db);
    });
    migrateV6ToV7(db, transaction);
  } catch (error) {
    if (error instanceof RegistryError) throw error;
    throw new RegistryError("DATABASE_MIGRATION_FAILED", "Database schema migration failed.");
  }
}

function migrateV2ToV7(db, transaction) {
  try {
    transaction(db, () => {
      applyV2ToV3(db);
      applyV3ToV4(db);
      applyV4ToV5(db);
      applyV5ToV6(db);
    });
    migrateV6ToV7(db, transaction);
  } catch (error) {
    if (error instanceof RegistryError) throw error;
    throw new RegistryError("DATABASE_MIGRATION_FAILED", "Database schema migration failed.");
  }
}

function applyV2ToV3(db) {
  validateSchema(db, 2);
  db.exec("ALTER TABLE entries ADD COLUMN created_via TEXT NOT NULL DEFAULT 'legacy' CHECK(created_via IN ('legacy','cli','web','chrome','manifest_import'))");
  db.exec("ALTER TABLE entries ADD COLUMN capture_adapter TEXT");
  db.exec("ALTER TABLE entries ADD COLUMN capture_request_id INTEGER REFERENCES capture_requests(id) ON DELETE RESTRICT");
  db.exec("ALTER TABLE entries ADD COLUMN capture_item_index INTEGER CHECK(capture_item_index >= 0)");
  db.exec(`
    CREATE TABLE capture_requests (
      id INTEGER PRIMARY KEY,
      requester_scope TEXT NOT NULL,
      client_request_id TEXT NOT NULL,
      payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256) = 64),
      channel TEXT NOT NULL CHECK(channel IN ('web','chrome','manifest_import')),
      adapter TEXT,
      state TEXT NOT NULL CHECK(state IN ('processing','completed')),
      item_count INTEGER NOT NULL CHECK(item_count >= 0),
      requested_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE TABLE capture_request_items (
      request_id INTEGER NOT NULL REFERENCES capture_requests(id) ON DELETE CASCADE,
      item_index INTEGER NOT NULL CHECK(item_index >= 0),
      outcome_code TEXT NOT NULL,
      entry_id INTEGER REFERENCES entries(id) ON DELETE RESTRICT,
      details_json TEXT NOT NULL DEFAULT '{}'
        CHECK(json_valid(details_json) AND json_type(details_json) = 'object'),
      recorded_at TEXT NOT NULL,
      PRIMARY KEY(request_id, item_index)
    );
    CREATE TABLE api_clients (
      id INTEGER PRIMARY KEY,
      token_sha256 TEXT NOT NULL CHECK(length(token_sha256) = 64),
      extension_id TEXT NOT NULL,
      label TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT,
      revoked_at TEXT
    );
    CREATE TRIGGER entries_capture_provenance_insert
    BEFORE INSERT ON entries
    WHEN (NEW.capture_request_id IS NULL) != (NEW.capture_item_index IS NULL)
    BEGIN SELECT RAISE(ABORT, 'capture provenance must be complete'); END;
    CREATE TRIGGER entries_capture_provenance_update
    BEFORE UPDATE OF capture_request_id, capture_item_index ON entries
    WHEN (NEW.capture_request_id IS NULL) != (NEW.capture_item_index IS NULL)
    BEGIN SELECT RAISE(ABORT, 'capture provenance must be complete'); END;
    CREATE UNIQUE INDEX entries_capture_item_uq ON entries(capture_request_id, capture_item_index) WHERE capture_request_id IS NOT NULL;
    CREATE UNIQUE INDEX capture_requests_scope_uuid_uq ON capture_requests(requester_scope, client_request_id);
    CREATE INDEX capture_request_items_entry_id_idx ON capture_request_items(entry_id) WHERE entry_id IS NOT NULL;
    CREATE UNIQUE INDEX api_clients_token_sha256_uq ON api_clients(token_sha256);
    CREATE INDEX api_clients_extension_id_idx ON api_clients(extension_id, revoked_at, id);
  `);
  db.prepare("UPDATE registry_meta SET value = ? WHERE key = 'schema_id'").run(V3_SCHEMA_ID);
  db.exec("PRAGMA user_version = 3");
  validateSchema(db, 3);
}

function migrateV3ToV7(db, transaction) {
  try {
    transaction(db, () => {
      applyV3ToV4(db);
      applyV4ToV5(db);
      applyV5ToV6(db);
    });
    migrateV6ToV7(db, transaction);
  } catch (error) {
    if (error instanceof RegistryError) throw error;
    throw new RegistryError("DATABASE_MIGRATION_FAILED", "Database schema migration failed.");
  }
}

function applyV3ToV4(db) {
  validateSchema(db, 3);
  db.exec("ALTER TABLE entries ADD COLUMN deleted_at TEXT");
  db.exec(`
    CREATE TABLE entry_revisions (
      id INTEGER PRIMARY KEY,
      entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE RESTRICT,
      revision_number INTEGER NOT NULL CHECK(revision_number >= 1),
      action TEXT NOT NULL CHECK(action IN ('created','updated','archived','restored')),
      actor_type TEXT NOT NULL CHECK(actor_type IN ('user','agent','system')),
      actor_id TEXT,
      changes_json TEXT NOT NULL
        CHECK(json_valid(changes_json) AND json_type(changes_json) = 'object'),
      reason TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TRIGGER entry_revisions_no_update
    BEFORE UPDATE ON entry_revisions
    BEGIN SELECT RAISE(ABORT, 'entry revisions are append-only'); END;
    CREATE TRIGGER entry_revisions_no_delete
    BEFORE DELETE ON entry_revisions
    BEGIN SELECT RAISE(ABORT, 'entry revisions are append-only'); END;
    CREATE TABLE capture_policy_defaults (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      visibility TEXT NOT NULL CHECK(visibility IN ('normal','private')),
      agent_access TEXT NOT NULL CHECK(agent_access IN ('blocked','metadata_only','allowed')),
      ai_processing TEXT NOT NULL CHECK(ai_processing IN ('disabled','manual','enabled')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE capture_policy_rules (
      id INTEGER PRIMARY KEY,
      hostname TEXT NOT NULL,
      path_prefix TEXT NOT NULL DEFAULT '/',
      visibility TEXT NOT NULL CHECK(visibility IN ('normal','private')),
      agent_access TEXT NOT NULL CHECK(agent_access IN ('blocked','metadata_only','allowed')),
      ai_processing TEXT NOT NULL CHECK(ai_processing IN ('disabled','manual','enabled')),
      enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
      position INTEGER NOT NULL CHECK(position >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(hostname, path_prefix)
    );
    CREATE INDEX entries_active_saved_at_id_idx ON entries(saved_at DESC, id DESC) WHERE deleted_at IS NULL;
    CREATE UNIQUE INDEX entry_revisions_entry_revision_uq ON entry_revisions(entry_id, revision_number);
    CREATE INDEX entry_revisions_entry_created_at_idx ON entry_revisions(entry_id, created_at DESC, id DESC);
    CREATE INDEX capture_policy_rules_match_idx ON capture_policy_rules(hostname, path_prefix, enabled);
    CREATE INDEX capture_policy_rules_position_idx ON capture_policy_rules(position, id);
  `);
  const timestamp = new Date().toISOString();
  db.prepare(`
    INSERT INTO capture_policy_defaults (
      id, visibility, agent_access, ai_processing, created_at, updated_at
    ) VALUES (1, 'private', 'blocked', 'disabled', ?, ?)
  `).run(timestamp, timestamp);
  db.prepare(`
    INSERT INTO entry_revisions (
      entry_id, revision_number, action, actor_type, actor_id, changes_json, reason, created_at
    )
    SELECT id, 1, 'created', 'system', 'schema-v4-migration',
      json_object(
        'baseline', json_object(
          'before', NULL,
          'after', json_object(
            'url', url_original,
            'title', title,
            'kind', kind,
            'visibility', visibility,
            'agent_access', agent_access,
            'ai_processing', ai_processing,
            'folder_id', folder_id,
            'content_focus', content_focus
          )
        )
      ),
      'Baseline created during schema v4 migration.', record_updated_at
    FROM entries
    ORDER BY id ASC
  `).run();
  db.prepare("UPDATE registry_meta SET value = ? WHERE key = 'schema_id'").run(V4_SCHEMA_ID);
  db.exec("PRAGMA user_version = 4");
  validateSchema(db, 4);
}

function migrateV4ToV7(db, transaction) {
  try {
    transaction(db, () => {
      applyV4ToV5(db);
      applyV5ToV6(db);
    });
    migrateV6ToV7(db, transaction);
  } catch (error) {
    if (error instanceof RegistryError) throw error;
    throw new RegistryError("DATABASE_MIGRATION_FAILED", "Database schema migration failed.");
  }
}

function applyV4ToV5(db) {
  validateSchema(db, 4);
  db.exec("ALTER TABLE entries ADD COLUMN title_origin TEXT NOT NULL DEFAULT 'none' CHECK(title_origin IN ('none','user','page','capture_caption'))");
  db.prepare(`
    UPDATE entries
    SET title_origin = CASE
      WHEN title IS NULL OR trim(title) = '' THEN 'none'
      WHEN capture_adapter = 'current-tab' THEN 'page'
      WHEN capture_adapter IN ('pinterest-pin-grid','x-media')
        AND NOT EXISTS (
          SELECT 1 FROM entry_revisions r
          WHERE r.entry_id = entries.id AND r.revision_number > 1
            AND json_type(r.changes_json, '$.title') IS NOT NULL
        ) THEN 'capture_caption'
      ELSE 'user'
    END
  `).run();
  db.exec(`
    CREATE TRIGGER entries_canonical_url_unique_insert
    BEFORE INSERT ON entries
    WHEN EXISTS (SELECT 1 FROM entries WHERE url_canonical = NEW.url_canonical)
    BEGIN SELECT RAISE(ABORT, 'canonical URL already exists'); END;
    CREATE TRIGGER entries_canonical_url_unique_update
    BEFORE UPDATE OF url_canonical ON entries
    WHEN EXISTS (SELECT 1 FROM entries WHERE id != OLD.id AND url_canonical = NEW.url_canonical)
    BEGIN SELECT RAISE(ABORT, 'canonical URL already exists'); END;
  `);
  db.prepare("UPDATE registry_meta SET value = ? WHERE key = 'schema_id'").run(V5_SCHEMA_ID);
  db.exec("PRAGMA user_version = 5");
  validateSchema(db, 5);
}

function migrateV5ToV7(db, transaction) {
  try {
    transaction(db, () => {
      applyV5ToV6(db);
    });
    migrateV6ToV7(db, transaction);
  } catch (error) {
    if (error instanceof RegistryError) throw error;
    throw new RegistryError("DATABASE_MIGRATION_FAILED", "Database schema migration failed.");
  }
}

function applyV5ToV6(db) {
  validateSchema(db, 5);
  db.exec(`
    DROP TRIGGER entry_comments_no_delete;
    DROP TRIGGER entry_revisions_no_delete;

    ALTER TABLE entry_revisions RENAME TO entry_revisions_v5;
    CREATE TABLE entry_revisions (
      id INTEGER PRIMARY KEY,
      entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
      revision_number INTEGER NOT NULL CHECK(revision_number >= 1),
      action TEXT NOT NULL CHECK(action IN ('created','updated','archived','restored')),
      actor_type TEXT NOT NULL CHECK(actor_type IN ('user','agent','system')),
      actor_id TEXT,
      changes_json TEXT NOT NULL
        CHECK(json_valid(changes_json) AND json_type(changes_json) = 'object'),
      reason TEXT,
      created_at TEXT NOT NULL
    );
    INSERT INTO entry_revisions (
      id, entry_id, revision_number, action, actor_type, actor_id,
      changes_json, reason, created_at
    )
    SELECT id, entry_id, revision_number, action, actor_type, actor_id,
      changes_json, reason, created_at
    FROM entry_revisions_v5;
    DROP TABLE entry_revisions_v5;
    CREATE UNIQUE INDEX entry_revisions_entry_revision_uq ON entry_revisions(entry_id, revision_number);
    CREATE INDEX entry_revisions_entry_created_at_idx ON entry_revisions(entry_id, created_at DESC, id DESC);

    ALTER TABLE capture_request_items RENAME TO capture_request_items_v5;
    CREATE TABLE capture_request_items (
      request_id INTEGER NOT NULL REFERENCES capture_requests(id) ON DELETE CASCADE,
      item_index INTEGER NOT NULL CHECK(item_index >= 0),
      outcome_code TEXT NOT NULL,
      entry_id INTEGER REFERENCES entries(id) ON DELETE SET NULL,
      details_json TEXT NOT NULL DEFAULT '{}'
        CHECK(json_valid(details_json) AND json_type(details_json) = 'object'),
      recorded_at TEXT NOT NULL,
      PRIMARY KEY(request_id, item_index)
    );
    INSERT INTO capture_request_items (
      request_id, item_index, outcome_code, entry_id, details_json, recorded_at
    )
    SELECT request_id, item_index, outcome_code, entry_id, details_json, recorded_at
    FROM capture_request_items_v5;
    DROP TABLE capture_request_items_v5;
    CREATE INDEX capture_request_items_entry_id_idx ON capture_request_items(entry_id) WHERE entry_id IS NOT NULL;

    CREATE TRIGGER entry_comments_no_delete
    BEFORE DELETE ON entry_comments
    WHEN EXISTS (SELECT 1 FROM entries WHERE id = OLD.entry_id)
    BEGIN SELECT RAISE(ABORT, 'entry comments are append-only'); END;
    CREATE TRIGGER entry_revisions_no_delete
    BEFORE DELETE ON entry_revisions
    WHEN EXISTS (SELECT 1 FROM entries WHERE id = OLD.entry_id)
    BEGIN SELECT RAISE(ABORT, 'entry revisions are append-only'); END;
    CREATE TRIGGER entry_revisions_no_update
    BEFORE UPDATE ON entry_revisions
    BEGIN SELECT RAISE(ABORT, 'entry revisions are append-only'); END;
  `);
  db.prepare("UPDATE registry_meta SET value = ? WHERE key = 'schema_id'").run(V6_SCHEMA_ID);
  db.exec("PRAGMA user_version = 6");
  validateSchema(db, 6);
}

function migrateV6ToV7(db, transaction) {
  let foreignKeysDisabled = false;
  try {
    validateSchema(db, 6);
    db.exec("PRAGMA foreign_keys = OFF");
    foreignKeysDisabled = true;
    transaction(db, () => applyV6ToV7(db));
  } catch (error) {
    if (error instanceof RegistryError) throw error;
    throw new RegistryError("DATABASE_MIGRATION_FAILED", "Database schema migration failed.");
  } finally {
    db.exec("PRAGMA legacy_alter_table = OFF");
    if (foreignKeysDisabled) db.exec("PRAGMA foreign_keys = ON");
  }
  migrateV7ToV8(db, transaction);
}

function applyV6ToV7(db) {
  db.exec(`
    PRAGMA legacy_alter_table = ON;
    DROP TRIGGER entries_capture_provenance_insert;
    DROP TRIGGER entries_capture_provenance_update;
    DROP TRIGGER entries_canonical_url_unique_insert;
    DROP TRIGGER entries_canonical_url_unique_update;
    ALTER TABLE entries RENAME TO entries_v6;
    ${V8_ENTRY_TABLE_SQL}
    INSERT INTO entries (
      id, url_original, url_canonical, title, title_origin, kind, kind_source,
      provider, source_domain, typed_metadata_json, saved_at, published_at, updated_at,
      visibility, agent_access, ai_processing, folder_id, content_focus, created_via,
      capture_adapter, capture_request_id, capture_item_index, deleted_at,
      record_created_at, record_updated_at
    )
    SELECT
      id, url_original, url_canonical, title, title_origin,
      CASE kind
        WHEN 'paper' THEN 'research'
        WHEN 'repository' THEN 'code'
        WHEN 'session' THEN 'conversation'
        ELSE kind
      END,
      kind_source, provider, source_domain, typed_metadata_json, saved_at,
      published_at, updated_at, visibility, agent_access, ai_processing,
      folder_id, content_focus, created_via, capture_adapter, capture_request_id,
      capture_item_index, deleted_at, record_created_at, record_updated_at
    FROM entries_v6;
    DROP TABLE entries_v6;

    CREATE INDEX entries_saved_at_id_idx ON entries(saved_at DESC, id DESC);
    CREATE INDEX entries_kind_idx ON entries(kind);
    CREATE INDEX entries_provider_idx ON entries(provider);
    CREATE INDEX entries_source_domain_idx ON entries(source_domain);
    CREATE INDEX entries_visibility_agent_access_idx ON entries(visibility, agent_access);
    CREATE INDEX entries_folder_id_idx ON entries(folder_id, saved_at DESC, id DESC);
    CREATE INDEX entries_content_focus_idx ON entries(content_focus, saved_at DESC, id DESC);
    CREATE UNIQUE INDEX entries_capture_item_uq ON entries(capture_request_id, capture_item_index) WHERE capture_request_id IS NOT NULL;
    CREATE INDEX entries_active_saved_at_id_idx ON entries(saved_at DESC, id DESC) WHERE deleted_at IS NULL;

    CREATE TRIGGER entries_capture_provenance_insert
    BEFORE INSERT ON entries
    WHEN (NEW.capture_request_id IS NULL) != (NEW.capture_item_index IS NULL)
    BEGIN SELECT RAISE(ABORT, 'capture provenance must be complete'); END;
    CREATE TRIGGER entries_capture_provenance_update
    BEFORE UPDATE OF capture_request_id, capture_item_index ON entries
    WHEN (NEW.capture_request_id IS NULL) != (NEW.capture_item_index IS NULL)
    BEGIN SELECT RAISE(ABORT, 'capture provenance must be complete'); END;
    CREATE TRIGGER entries_canonical_url_unique_insert
    BEFORE INSERT ON entries
    WHEN EXISTS (SELECT 1 FROM entries WHERE url_canonical = NEW.url_canonical)
    BEGIN SELECT RAISE(ABORT, 'canonical URL already exists'); END;
    CREATE TRIGGER entries_canonical_url_unique_update
    BEFORE UPDATE OF url_canonical ON entries
    WHEN EXISTS (SELECT 1 FROM entries WHERE id != OLD.id AND url_canonical = NEW.url_canonical)
    BEGIN SELECT RAISE(ABORT, 'canonical URL already exists'); END;
  `);
  const foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeyViolations.length) {
    throw new RegistryError("DATABASE_MIGRATION_FAILED", "Database schema migration failed foreign-key validation.");
  }
  db.prepare("UPDATE registry_meta SET value = ? WHERE key = 'schema_id'").run(V7_SCHEMA_ID);
  db.exec("PRAGMA user_version = 7");
  validateSchema(db, 7);
}

function migrateV7ToV8(db, transaction) {
  try {
    transaction(db, () => {
      validateSchema(db, 7);
      db.exec("ALTER TABLE capture_policy_defaults ADD COLUMN selected_image_storage TEXT CHECK(selected_image_storage IN ('reference_only','local_copy'))");
      db.exec("ALTER TABLE capture_policy_rules ADD COLUMN kind TEXT CHECK(kind IN ('article','social','video','animation','image','research','code','conversation','page'))");
      db.prepare("UPDATE registry_meta SET value = ? WHERE key = 'schema_id'").run(V8_SCHEMA_ID);
      db.exec("PRAGMA user_version = 8");
      validateSchema(db, 8);
    });
  } catch (error) {
    if (error instanceof RegistryError) throw error;
    throw new RegistryError("DATABASE_MIGRATION_FAILED", "Database schema migration failed.");
  }
  migrateV8ToV9(db, transaction);
}

function migrateV8ToV9(db, transaction) {
  let foreignKeysDisabled = false;
  try {
    validateSchema(db, 8);
    db.exec("PRAGMA foreign_keys = OFF");
    foreignKeysDisabled = true;
    transaction(db, () => applyV8ToV9(db));
  } catch (error) {
    if (error instanceof RegistryError) throw error;
    throw new RegistryError("DATABASE_MIGRATION_FAILED", "Database schema migration failed.");
  } finally {
    db.exec("PRAGMA legacy_alter_table = OFF");
    if (foreignKeysDisabled) db.exec("PRAGMA foreign_keys = ON");
  }
  migrateV9ToV10(db, transaction);
}

function applyV8ToV9(db) {
  db.exec(`
    PRAGMA legacy_alter_table = ON;

    INSERT INTO entry_revisions (
      entry_id, revision_number, action, actor_type, actor_id,
      changes_json, reason, created_at
    )
    SELECT
      e.id,
      COALESCE((SELECT MAX(r.revision_number) FROM entry_revisions r WHERE r.entry_id = e.id), 0) + 1,
      'updated',
      'system',
      'schema-v9',
      json_object(
        'kind', json_object(
          'before', e.kind,
          'after', CASE e.kind
            WHEN 'social' THEN 'post'
            WHEN 'conversation' THEN 'post'
            WHEN 'animation' THEN 'image'
          END
        )
      ),
      'Consolidated legacy Content type during schema v9 migration.',
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM entries e
    WHERE e.kind IN ('social','conversation','animation');

    DROP TRIGGER entries_capture_provenance_insert;
    DROP TRIGGER entries_capture_provenance_update;
    DROP TRIGGER entries_canonical_url_unique_insert;
    DROP TRIGGER entries_canonical_url_unique_update;
    ALTER TABLE entries RENAME TO entries_v8;
    ${V15_ENTRY_TABLE_SQL}
    INSERT INTO entries (
      id, url_original, url_canonical, title, title_origin, kind, kind_source,
      provider, source_domain, typed_metadata_json, saved_at, published_at, updated_at,
      visibility, agent_access, ai_processing, folder_id, content_focus, created_via,
      capture_adapter, capture_request_id, capture_item_index, deleted_at,
      record_created_at, record_updated_at
    )
    SELECT
      id, url_original, url_canonical, title, title_origin,
      CASE kind
        WHEN 'social' THEN 'post'
        WHEN 'conversation' THEN 'post'
        WHEN 'animation' THEN 'image'
        ELSE kind
      END,
      kind_source, provider, source_domain, typed_metadata_json, saved_at,
      published_at, updated_at, visibility, agent_access, ai_processing,
      folder_id, content_focus, created_via, capture_adapter, capture_request_id,
      capture_item_index, deleted_at, record_created_at, record_updated_at
    FROM entries_v8;
    DROP TABLE entries_v8;

    CREATE INDEX entries_saved_at_id_idx ON entries(saved_at DESC, id DESC);
    CREATE INDEX entries_kind_idx ON entries(kind);
    CREATE INDEX entries_provider_idx ON entries(provider);
    CREATE INDEX entries_source_domain_idx ON entries(source_domain);
    CREATE INDEX entries_visibility_agent_access_idx ON entries(visibility, agent_access);
    CREATE INDEX entries_folder_id_idx ON entries(folder_id, saved_at DESC, id DESC);
    CREATE INDEX entries_content_focus_idx ON entries(content_focus, saved_at DESC, id DESC);
    CREATE UNIQUE INDEX entries_capture_item_uq ON entries(capture_request_id, capture_item_index) WHERE capture_request_id IS NOT NULL;
    CREATE INDEX entries_active_saved_at_id_idx ON entries(saved_at DESC, id DESC) WHERE deleted_at IS NULL;

    CREATE TRIGGER entries_capture_provenance_insert
    BEFORE INSERT ON entries
    WHEN (NEW.capture_request_id IS NULL) != (NEW.capture_item_index IS NULL)
    BEGIN SELECT RAISE(ABORT, 'capture provenance must be complete'); END;
    CREATE TRIGGER entries_capture_provenance_update
    BEFORE UPDATE OF capture_request_id, capture_item_index ON entries
    WHEN (NEW.capture_request_id IS NULL) != (NEW.capture_item_index IS NULL)
    BEGIN SELECT RAISE(ABORT, 'capture provenance must be complete'); END;
    CREATE TRIGGER entries_canonical_url_unique_insert
    BEFORE INSERT ON entries
    WHEN EXISTS (SELECT 1 FROM entries WHERE url_canonical = NEW.url_canonical)
    BEGIN SELECT RAISE(ABORT, 'canonical URL already exists'); END;
    CREATE TRIGGER entries_canonical_url_unique_update
    BEFORE UPDATE OF url_canonical ON entries
    WHEN EXISTS (SELECT 1 FROM entries WHERE id != OLD.id AND url_canonical = NEW.url_canonical)
    BEGIN SELECT RAISE(ABORT, 'canonical URL already exists'); END;

    ALTER TABLE capture_policy_rules RENAME TO capture_policy_rules_v8;
    ${CAPTURE_POLICY_RULE_TABLE_SQL}
    INSERT INTO capture_policy_rules (
      id, hostname, path_prefix, kind, visibility, agent_access, ai_processing,
      enabled, position, created_at, updated_at
    )
    SELECT
      id, hostname, path_prefix,
      CASE kind
        WHEN 'social' THEN 'post'
        WHEN 'conversation' THEN 'post'
        WHEN 'animation' THEN 'image'
        ELSE kind
      END,
      visibility, agent_access, ai_processing, enabled, position, created_at, updated_at
    FROM capture_policy_rules_v8;
    DROP TABLE capture_policy_rules_v8;
    CREATE INDEX capture_policy_rules_match_idx ON capture_policy_rules(hostname, path_prefix, enabled);
    CREATE INDEX capture_policy_rules_position_idx ON capture_policy_rules(position, id);
  `);
  const foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeyViolations.length) {
    throw new RegistryError("DATABASE_MIGRATION_FAILED", "Database schema migration failed foreign-key validation.");
  }
  db.prepare("UPDATE registry_meta SET value = ? WHERE key = 'schema_id'").run(V9_SCHEMA_ID);
  db.exec("PRAGMA user_version = 9");
  validateSchema(db, 9);
}

function migrateV9ToV10(db, transaction) {
  try {
    transaction(db, () => {
      validateSchema(db, 9);
      db.exec(`
        CREATE TABLE IF NOT EXISTS file_cleanup_queue (
          storage_path TEXT PRIMARY KEY,
          reason TEXT NOT NULL,
          enqueued_at TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
          failure_code TEXT
        );
        CREATE INDEX IF NOT EXISTS file_cleanup_queue_enqueued_at_idx ON file_cleanup_queue(enqueued_at, storage_path);
      `);
      db.prepare("UPDATE registry_meta SET value = ? WHERE key = 'schema_id'").run(V10_SCHEMA_ID);
      db.exec("PRAGMA user_version = 10");
      validateSchema(db, 10);
    });
  } catch (error) {
    if (error instanceof RegistryError) throw error;
    throw new RegistryError("DATABASE_MIGRATION_FAILED", "Database schema migration failed.");
  }
  migrateV10ToV12(db, transaction);
}

function migrateV10ToV12(db, transaction) {
  try {
    transaction(db, () => {
      validateSchema(db, 10);
      db.prepare("UPDATE registry_meta SET value = ? WHERE key = 'schema_id'").run(V12_SCHEMA_ID);
      db.exec("PRAGMA user_version = 12");
      validateSchema(db, 12);
    });
  } catch (error) {
    if (error instanceof RegistryError) throw error;
    throw new RegistryError("DATABASE_MIGRATION_FAILED", "Database schema migration failed.");
  }
  migrateV12ToV13(db, transaction);
}

function migrateV11ToV12(db, transaction) {
  try {
    transaction(db, () => {
      validateSchema(db, 11);
      db.exec("DROP TABLE entry_link_health");
      db.prepare("UPDATE registry_meta SET value = ? WHERE key = 'schema_id'").run(V12_SCHEMA_ID);
      db.exec("PRAGMA user_version = 12");
      validateSchema(db, 12);
    });
  } catch (error) {
    if (error instanceof RegistryError) throw error;
    throw new RegistryError("DATABASE_MIGRATION_FAILED", "Database schema migration failed.");
  }
  migrateV12ToV13(db, transaction);
}

function migrateV12ToV13(db, transaction) {
  try {
    transaction(db, () => {
      validateSchema(db, 12);
      db.exec(CAPTURE_POLICY_RULE_TAG_TABLE_SQL);
      db.exec("CREATE INDEX IF NOT EXISTS capture_policy_rule_tags_tag_idx ON capture_policy_rule_tags(tag_id, rule_id)");
      db.prepare("UPDATE registry_meta SET value = ? WHERE key = 'schema_id'").run(V13_SCHEMA_ID);
      db.exec("PRAGMA user_version = 13");
      validateSchema(db, 13);
    });
  } catch (error) {
    if (error instanceof RegistryError) throw error;
    throw new RegistryError("DATABASE_MIGRATION_FAILED", "Database schema migration failed.");
  }
  migrateV13ToV14(db, transaction);
}

function migrateV13ToV14(db, transaction) {
  try {
    transaction(db, () => {
      validateSchema(db, 13);
      const tags = db.prepare("SELECT * FROM capture_policy_rule_tags").all();
      db.exec("DROP TABLE capture_policy_rule_tags");
      db.exec("ALTER TABLE capture_policy_rules RENAME TO capture_policy_rules_v13");
      db.exec(CAPTURE_POLICY_RULE_TABLE_SQL);
      db.exec(`INSERT INTO capture_policy_rules (
        id, hostname, path_prefix, kind, visibility, agent_access, ai_processing,
        enabled, position, created_at, updated_at
      ) SELECT id, hostname, path_prefix, kind, visibility, agent_access, ai_processing,
        enabled, position, created_at, updated_at FROM capture_policy_rules_v13`);
      db.exec("DROP TABLE capture_policy_rules_v13");
      db.exec("CREATE INDEX capture_policy_rules_match_idx ON capture_policy_rules(hostname, path_prefix, enabled)");
      db.exec("CREATE INDEX capture_policy_rules_position_idx ON capture_policy_rules(position, id)");
      db.exec(CAPTURE_POLICY_RULE_TAG_TABLE_SQL);
      const insertTag = db.prepare("INSERT INTO capture_policy_rule_tags (rule_id, tag_id, position) VALUES (?, ?, ?)");
      for (const tag of tags) insertTag.run(tag.rule_id, tag.tag_id, tag.position);
      db.exec("CREATE INDEX capture_policy_rule_tags_tag_idx ON capture_policy_rule_tags(tag_id, rule_id)");
      db.prepare("UPDATE registry_meta SET value = ? WHERE key = 'schema_id'").run(V14_SCHEMA_ID);
      db.exec("PRAGMA user_version = 14");
      validateSchema(db, 14);
    });
  } catch (error) {
    if (error instanceof RegistryError) throw error;
    throw new RegistryError("DATABASE_MIGRATION_FAILED", "Database schema migration failed.");
  }
  migrateV14ToV15(db, transaction);
}

function migrateV14ToV15(db, transaction) {
  try {
    transaction(db, () => {
      validateSchema(db, 14);
      db.exec(`
        UPDATE entries
        SET agent_access = CASE visibility WHEN 'normal' THEN 'allowed' ELSE 'blocked' END,
            ai_processing = CASE visibility WHEN 'normal' THEN 'enabled' ELSE 'disabled' END;
        UPDATE capture_policy_defaults
        SET agent_access = CASE visibility WHEN 'normal' THEN 'allowed' ELSE 'blocked' END,
            ai_processing = CASE visibility WHEN 'normal' THEN 'enabled' ELSE 'disabled' END;
        UPDATE capture_policy_rules
        SET agent_access = CASE visibility WHEN 'normal' THEN 'allowed' ELSE 'blocked' END,
            ai_processing = CASE visibility WHEN 'normal' THEN 'enabled' ELSE 'disabled' END;
      `);
      db.prepare("UPDATE registry_meta SET value = ? WHERE key = 'schema_id'").run(V15_SCHEMA_ID);
      db.exec("PRAGMA user_version = 15");
      validateSchema(db, 15);
    });
  } catch (error) {
    if (error instanceof RegistryError) throw error;
    throw new RegistryError("DATABASE_MIGRATION_FAILED", "Database schema migration failed.");
  }
  migrateV15ToV16(db, transaction);
}

function migrateV15ToV16(db, transaction) {
  let foreignKeysDisabled = false;
  try {
    validateSchema(db, 15);
    const columns = db.prepare("PRAGMA table_info(entries)").all().map((row) => row.name).join(", ");
    const objects = db.prepare(`
      SELECT sql FROM sqlite_master
      WHERE tbl_name = 'entries' AND type IN ('index','trigger') AND sql IS NOT NULL
    `).all();
    db.exec("PRAGMA foreign_keys = OFF");
    foreignKeysDisabled = true;
    transaction(db, () => {
      db.exec("PRAGMA legacy_alter_table = ON");
      db.exec("ALTER TABLE entries RENAME TO entries_v15");
      db.exec(ENTRY_TABLE_SQL);
      db.exec(`INSERT INTO entries (${columns}) SELECT ${columns} FROM entries_v15`);
      db.exec("DROP TABLE entries_v15");
      for (const object of objects) db.exec(object.sql);
      db.prepare("UPDATE registry_meta SET value = ? WHERE key = 'schema_id'").run(V16_SCHEMA_ID);
      db.exec("PRAGMA user_version = 16");
      validateSchema(db, 16);
      if (db.prepare("PRAGMA foreign_key_check").all().length) {
        throw new RegistryError("DATABASE_MIGRATION_FAILED", "Database foreign keys failed after migration.");
      }
    });
  } catch (error) {
    if (error instanceof RegistryError) throw error;
    throw new RegistryError("DATABASE_MIGRATION_FAILED", "Database schema migration failed.");
  } finally {
    db.exec("PRAGMA legacy_alter_table = OFF");
    if (foreignKeysDisabled) db.exec("PRAGMA foreign_keys = ON");
  }
  migrateV16ToV17(db, transaction);
}

function migrateV16ToV17(db, transaction) {
  try {
    transaction(db, () => {
      validateSchema(db, 16);
      db.exec(`
        CREATE TABLE IF NOT EXISTS ai_summary_attempts (
          id INTEGER PRIMARY KEY,
          entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
          source TEXT NOT NULL CHECK(source IN ('legacy','pipeline')),
          started_at TEXT NOT NULL,
          completed_at TEXT,
          status TEXT NOT NULL CHECK(status IN ('running','complete','partial','failed')),
          error_code TEXT,
          total_ms INTEGER,
          evidence_ms INTEGER,
          media_ms INTEGER,
          model_ms INTEGER,
          input_tokens INTEGER,
          cached_input_tokens INTEGER,
          output_tokens INTEGER,
          legacy_job_id INTEGER UNIQUE
        );
        CREATE INDEX IF NOT EXISTS ai_summary_attempts_entry_id_idx ON ai_summary_attempts(entry_id, id);
        INSERT INTO ai_summary_attempts (entry_id, source, started_at, completed_at, status, error_code, legacy_job_id)
        SELECT entry_id, 'legacy', requested_at, completed_at,
          CASE WHEN status = 'completed' THEN 'complete' ELSE 'failed' END,
          failure_code, id
        FROM summary_jobs
        WHERE requested_by IN ('ai-url-summary', 'ai-url-summary-backfill');
      `);
      db.prepare("UPDATE registry_meta SET value = ? WHERE key = 'schema_id'").run(SCHEMA_ID);
      db.exec("PRAGMA user_version = 17");
      validateSchema(db);
    });
  } catch (error) {
    if (error instanceof RegistryError) throw error;
    throw new RegistryError("DATABASE_MIGRATION_FAILED", "Database schema migration failed.");
  }
}

function validateSchema(db, version = SCHEMA_VERSION) {
  const requiredColumns = version >= 14 && version <= 16 ? V16_REQUIRED_COLUMNS : version === 13 ? V13_REQUIRED_COLUMNS : version === 1
    ? V1_REQUIRED_COLUMNS
    : (version === 2 ? V2_REQUIRED_COLUMNS : (version === 3 ? V3_REQUIRED_COLUMNS : (version === 4 ? V4_REQUIRED_COLUMNS : (version >= 5 && version <= 7 ? V7_REQUIRED_COLUMNS : (version <= 9 ? V9_REQUIRED_COLUMNS : (version === 10 || version === 12 ? V10_REQUIRED_COLUMNS : (version === 11 ? V11_REQUIRED_COLUMNS : REQUIRED_COLUMNS)))))));
  for (const [table, expectedColumns] of Object.entries(requiredColumns)) {
    const actualColumns = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
    const missingColumns = expectedColumns.filter((column) => !actualColumns.includes(column));
    if (!actualColumns.length || missingColumns.length) {
      throw new RegistryError("DATABASE_SCHEMA_INVALID", "Database schema is incomplete.", {
        table,
        missingColumns: actualColumns.length ? missingColumns : expectedColumns
      });
    }
  }

  const schemaId = db.prepare("SELECT value FROM registry_meta WHERE key = 'schema_id'").get()?.value;
  const requiredTriggers = version < 3
    ? ["entry_comments_no_update", "entry_comments_no_delete"]
    : version === 3 ? [
      "entry_comments_no_update", "entry_comments_no_delete",
      "entries_capture_provenance_insert", "entries_capture_provenance_update"
    ] : version === 4 ? [
      "entry_comments_no_update", "entry_comments_no_delete",
      "entries_capture_provenance_insert", "entries_capture_provenance_update",
      "entry_revisions_no_update", "entry_revisions_no_delete"
    ] : [
      "entry_comments_no_update", "entry_comments_no_delete",
      "entries_capture_provenance_insert", "entries_capture_provenance_update",
      "entry_revisions_no_update", "entry_revisions_no_delete",
      "entries_canonical_url_unique_insert", "entries_canonical_url_unique_update"
    ];
  const triggerNames = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all().map((row) => row.name));
  const expectedSchemaId = version === 16 ? V16_SCHEMA_ID : version === 15 ? V15_SCHEMA_ID : version === 14 ? V14_SCHEMA_ID : version === 13 ? V13_SCHEMA_ID : version === 1
    ? V1_SCHEMA_ID
    : (version === 2 ? V2_SCHEMA_ID : (version === 3 ? V3_SCHEMA_ID : (version === 4 ? V4_SCHEMA_ID : (version === 5 ? V5_SCHEMA_ID : (version === 6 ? V6_SCHEMA_ID : (version === 7 ? V7_SCHEMA_ID : (version === 8 ? V8_SCHEMA_ID : (version === 9 ? V9_SCHEMA_ID : (version === 10 ? V10_SCHEMA_ID : (version === 11 ? V11_SCHEMA_ID : (version === 12 ? V12_SCHEMA_ID : SCHEMA_ID)))))))))));
  const requiredIndexes = version >= 17 ? REQUIRED_INDEXES : version >= 13 ? V16_REQUIRED_INDEXES : version === 1
    ? V1_REQUIRED_INDEXES
    : version === 2 ? V2_REQUIRED_INDEXES : version === 3 ? V3_REQUIRED_INDEXES
      : version === 4 ? V4_REQUIRED_INDEXES : version <= 9 ? V9_REQUIRED_INDEXES
        : V10_REQUIRED_INDEXES;
  const indexNames = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((row) => row.name));
  if (schemaId !== expectedSchemaId || requiredTriggers.some((name) => !triggerNames.has(name)) || requiredIndexes.some((name) => !indexNames.has(name))) {
    throw new RegistryError("DATABASE_SCHEMA_INVALID", "Database schema identity is invalid.");
  }
}

module.exports = {
  SCHEMA_SQL,
  SCHEMA_VERSION,
  initializeSchema,
  validateSchema,
};
