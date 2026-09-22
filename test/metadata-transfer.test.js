"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { addComment } = require("../registry/comments.js");
const { executeCli } = require("../registry/cli.js");
const { openRegistry } = require("../registry/database.js");
const { addEntry } = require("../registry/entries.js");
const { createFolder } = require("../registry/folders.js");
const {
  METADATA_FORMAT,
  buildOwnerMetadata,
  exportOwnerMetadata,
  importOwnerMetadata,
  validateOwnerMetadata
} = require("../registry/metadata-transfer.js");
const { addTags } = require("../registry/tags.js");
const { addLocalImage, addRemoteImageReference } = require("../registry/visual-assets.js");

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

test("owner metadata round trip preserves included fields and excludes runtime state", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wbh-metadata-transfer-"));
  const source = openRegistry({ dbPath: path.join(directory, "source", "registry.sqlite3") });
  const target = openRegistry({ dbPath: path.join(directory, "target", "registry.sqlite3") });
  const exportPath = path.join(directory, "owner-metadata.json");
  try {
    const root = createFolder(source, { name: "연구" }, { clock: at("2026-01-01T00:00:00.000Z") });
    const child = createFolder(source, { name: "읽을 것", parentId: root.id }, { clock: at("2026-01-02T00:00:00.000Z") });
    const entry = addEntry(source, {
      url: "https://synthetic.example.test/article?id=7",
      title: "소유자 제목",
      kind: "research",
      typedMetadata: { language: "ko", venue: "Synthetic" },
      savedAt: "2026-02-01T01:02:03.000Z",
      publishedAt: "2026-01-15T00:00:00.000Z",
      updatedAt: "2026-01-20T00:00:00.000Z",
      visibility: "private",
      agentAccess: "blocked",
      aiProcessing: "disabled",
      contentFocus: "visual",
      folderId: child.id
    }).entry;
    addTags(source, entry.id, ["자료", "검토"], { clock: at("2026-02-01T01:02:04.000Z") });
    addComment(source, entry.id, "내 메모", { clock: at("2026-02-02T00:00:00.000Z") });
    addRemoteImageReference(source, entry.id, "https://images.example.test/remote.png", {
      sourceKind: "provider_thumbnail",
      capturedAt: "2026-02-03T00:00:00.000Z",
      makeCover: true,
      clock: at("2026-02-03T00:00:00.000Z")
    });
    const localSource = path.join(directory, "local-source.png");
    fs.writeFileSync(localSource, PNG);
    const local = await addLocalImage(source, entry.id, localSource, {
      sourceKind: "browser_selected",
      sourceUrl: "https://images.example.test/selected.png",
      capturedAt: "2026-02-04T00:00:00.000Z",
      clock: at("2026-02-04T00:00:00.000Z")
    });
    source.db.prepare(`
      INSERT INTO api_clients (token_sha256, extension_id, label, created_at)
      VALUES (?, ?, ?, ?)
    `).run("a".repeat(64), "synthetic-extension", "must-not-export", "2026-02-05T00:00:00.000Z");

    exportOwnerMetadata(source, exportPath);
    const raw = fs.readFileSync(exportPath, "utf8");
    const document = JSON.parse(raw);
    assert.equal(document.format, METADATA_FORMAT);
    assert.equal(document.entries[0].visibility, "private");
    assert.equal(document.entries[0].agent_access, "blocked");
    assert.equal(document.entries[0].visual_references.length, 2);
    for (const forbidden of [local.asset.storage_path, local.asset.sha256, local.asset.file_path, "must-not-export", "synthetic-extension", "api_clients", "capture_requests", "entry_revisions", "summary_jobs"]) {
      assert.equal(raw.includes(forbidden), false);
    }
    assert.deepEqual(Object.keys(document.entries[0]).sort(), [
      "agent_access", "ai_processing", "content_focus", "folder_key", "kind", "kind_source", "notes",
      "published_at", "saved_at", "tags", "title", "typed_metadata", "updated_at", "url_original",
      "visibility", "visual_references"
    ].sort());

    const imported = importOwnerMetadata(target, exportPath);
    assert.deepEqual(imported, {
      folders_created: 2,
      folders_reused: 0,
      entries_created: 1,
      entries_already_saved: 0
    });
    assert.deepEqual(buildOwnerMetadata(target), document);

    const beforeDuplicate = buildOwnerMetadata(target);
    const duplicate = importOwnerMetadata(target, exportPath);
    assert.equal(duplicate.entries_already_saved, 1);
    assert.equal(duplicate.entries_created, 0);
    assert.deepEqual(buildOwnerMetadata(target), beforeDuplicate);
  } finally {
    source.close();
    target.close();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("metadata validation rejects prohibited or credential-bearing fields", () => {
  const base = {
    format: METADATA_FORMAT,
    folders: [],
    entries: []
  };
  assert.deepEqual(validateOwnerMetadata(base), {
    valid: true, format: METADATA_FORMAT, folders: 0, entries: 0
  });
  assert.throws(
    () => validateOwnerMetadata({ ...base, storage_path: "private/file.png" }),
    { code: "METADATA_INVALID" }
  );
  const invalid = JSON.parse(JSON.stringify(base));
  invalid.entries.push(validEntry());
  invalid.entries[0].visual_references.push({
    source_kind: "browser_selected",
    source_url: "https://user:secret@images.example.test/a.png",
    captured_at: "2026-01-01T00:00:00.000Z",
    is_cover: true
  });
  assert.throws(() => validateOwnerMetadata(invalid), { code: "METADATA_INVALID" });
});

test("metadata CLI validates, exports, and imports the versioned document", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wbh-metadata-cli-"));
  const sourcePath = path.join(directory, "source", "registry.sqlite3");
  const targetPath = path.join(directory, "target", "registry.sqlite3");
  const exportPath = path.join(directory, "metadata.json");
  const source = openRegistry({ dbPath: sourcePath });
  addEntry(source, { url: "https://synthetic.example.test/cli" });
  source.close();
  try {
    const exported = await executeCli(["metadata", "export", exportPath, "--db", sourcePath]);
    assert.equal(exported.data.entries, 1);
    const validated = await executeCli(["metadata", "validate", exportPath]);
    assert.equal(validated.data.valid, true);
    const imported = await executeCli(["metadata", "import", exportPath, "--db", targetPath]);
    assert.equal(imported.data.entries_created, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  }
});

function validEntry() {
  return {
    url_original: "https://synthetic.example.test/valid",
    title: null,
    kind: "page",
    kind_source: "derived",
    typed_metadata: {},
    saved_at: "2026-01-01T00:00:00.000Z",
    published_at: null,
    updated_at: null,
    visibility: "normal",
    agent_access: "metadata_only",
    ai_processing: "disabled",
    content_focus: "text",
    folder_key: null,
    tags: [],
    notes: [],
    visual_references: []
  };
}

function at(timestamp) {
  return { now: () => timestamp };
}
