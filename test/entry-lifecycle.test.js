"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { openRegistry } = require("../registry/database.js");
const {
  addEntry,
  archiveEntry,
  editEntry,
  getEntry,
  listEntries,
  listEntryRevisions,
  restoreEntry
} = require("../registry/entries.js");
const { assignEntryToFolder, createFolder } = require("../registry/folders.js");
const { addTags, removeTags } = require("../registry/tags.js");

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wbh-entry-lifecycle-"));
  const registry = openRegistry({ dbPath: path.join(directory, "registry.sqlite3") });
  return {
    registry,
    dispose() {
      registry.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  };
}

test("Entry edit records field-level history and refreshes URL-derived fields", () => {
  const state = fixture();
  try {
    const created = addEntry(state.registry, {
      url: "https://example.test/old",
      title: "Before"
    }, { clock: () => new Date("2026-03-01T00:00:00.000Z") }).entry;
    const updated = editEntry(state.registry, created.id, {
      url: "https://other.test/new?utm_source=ignored",
      title: "After",
      visibility: "normal",
      agentAccess: "metadata_only",
      aiProcessing: "manual"
    }, {
      actor: { type: "user", id: "web-session" },
      reason: "User edited the card.",
      clock: () => new Date("2026-03-02T00:00:00.000Z")
    });
    assert.equal(updated.source_domain, "other.test");
    assert.equal(updated.url_canonical, "https://other.test/new");
    assert.equal(updated.visibility, "normal");
    const revisions = listEntryRevisions(state.registry, created.id);
    assert.deepEqual(revisions.map((revision) => revision.revision_number), [2, 1]);
    assert.equal(revisions[0].action, "updated");
    assert.equal(revisions[0].actor_id, "web-session");
    assert.deepEqual(revisions[0].changes.title, { before: "Before", after: "After" });
    assert.deepEqual(revisions[0].changes.url, {
      before: "https://example.test/old",
      after: "https://other.test/new?utm_source=ignored"
    });
  } finally {
    state.dispose();
  }
});

test("archive hides an Entry from normal reads and restore retains monotonic history", () => {
  const state = fixture();
  try {
    const created = addEntry(state.registry, { url: "https://example.test/archive" }).entry;
    const archived = archiveEntry(state.registry, created.id, {
      clock: () => new Date("2026-03-03T00:00:00.000Z")
    });
    assert.equal(archived.deleted_at, "2026-03-03T00:00:00.000Z");
    assert.throws(() => getEntry(state.registry, created.id), (error) => error.code === "ENTRY_NOT_FOUND");
    assert.equal(listEntries(state.registry).total, 0);
    assert.equal(listEntries(state.registry, { includeArchived: true }).total, 1);
    const restored = restoreEntry(state.registry, created.id, {
      clock: () => new Date("2026-03-04T00:00:00.000Z")
    });
    assert.equal(restored.deleted_at, null);
    assert.deepEqual(
      listEntryRevisions(state.registry, created.id).map((revision) => revision.action),
      ["restored", "archived", "created"]
    );
  } finally {
    state.dispose();
  }
});

test("URL replacement rejects another active Entry and rolls back the attempted revision", () => {
  const state = fixture();
  try {
    const first = addEntry(state.registry, { url: "https://example.test/first" }).entry;
    const second = addEntry(state.registry, { url: "https://example.test/second" }).entry;
    assert.throws(
      () => editEntry(state.registry, second.id, { url: first.url_original }),
      (error) => error.code === "ENTRY_URL_CONFLICT"
    );
    assert.equal(getEntry(state.registry, second.id).url_original, "https://example.test/second");
    assert.equal(listEntryRevisions(state.registry, second.id).length, 1);
  } finally {
    state.dispose();
  }
});

test("saved time remains imported while record times and revisions use the local clock", () => {
  const state = fixture();
  try {
    const created = addEntry(state.registry, {
      url: "https://example.test/imported",
      savedAt: "2020-01-02T03:04:05.000Z"
    }, { clock: () => new Date("2026-09-03T01:02:03.000Z") }).entry;
    assert.equal(created.saved_at, "2020-01-02T03:04:05.000Z");
    assert.equal(created.record_created_at, "2026-09-03T01:02:03.000Z");
    assert.equal(created.record_updated_at, "2026-09-03T01:02:03.000Z");
    assert.equal(listEntryRevisions(state.registry, created.id)[0].created_at, "2026-09-03T01:02:03.000Z");
  } finally {
    state.dispose();
  }
});

test("public tag and folder changes create one revision and no-op calls create none", () => {
  const state = fixture();
  try {
    const created = addEntry(state.registry, { url: "https://example.test/history" }).entry;
    const folder = createFolder(state.registry, { name: "History" });
    addTags(state.registry, created.id, ["Research"], { clock: () => new Date("2026-09-03T02:00:00.000Z") });
    addTags(state.registry, created.id, ["research"], { clock: () => new Date("2026-09-03T02:01:00.000Z") });
    assignEntryToFolder(state.registry, created.id, folder.id, { clock: () => new Date("2026-09-03T02:02:00.000Z") });
    assignEntryToFolder(state.registry, created.id, folder.id, { clock: () => new Date("2026-09-03T02:03:00.000Z") });
    removeTags(state.registry, created.id, ["Research"], { clock: () => new Date("2026-09-03T02:04:00.000Z") });
    removeTags(state.registry, created.id, ["missing"], { clock: () => new Date("2026-09-03T02:05:00.000Z") });
    const revisions = listEntryRevisions(state.registry, created.id);
    assert.equal(revisions.length, 4);
    assert.deepEqual(revisions.slice(0, 3).map((revision) => revision.created_at), [
      "2026-09-03T02:04:00.000Z",
      "2026-09-03T02:02:00.000Z",
      "2026-09-03T02:00:00.000Z"
    ]);
    assert.deepEqual(Object.keys(revisions[0].changes), ["tags"]);
    assert.deepEqual(Object.keys(revisions[1].changes), ["folder_id"]);
    assert.deepEqual(Object.keys(revisions[2].changes), ["tags"]);
  } finally {
    state.dispose();
  }
});
