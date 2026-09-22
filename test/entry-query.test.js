"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { addComment } = require("../registry/comments.js");
const { openRegistry } = require("../registry/database.js");
const { addEntry, getEntry } = require("../registry/entries.js");
const { listEntries } = require("../registry/entry-query.js");
const { createFolder } = require("../registry/folders.js");
const { addTags } = require("../registry/tags.js");
const { addRemoteImageReference, clearCover } = require("../registry/visual-assets.js");

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wbh-entry-query-"));
  return {
    directory,
    registry: openRegistry({ dbPath: path.join(directory, "registry.sqlite3") })
  };
}

function dispose(subject) {
  subject.registry.close();
  fs.rmSync(subject.directory, { recursive: true, force: true, maxRetries: 3 });
}

function add(registry, url, input = {}) {
  return addEntry(registry, {
    url,
    savedAt: "2026-01-01T00:00:00.000Z",
    visibility: "normal",
    agentAccess: "allowed",
    aiProcessing: "enabled",
    ...input
  }).entry;
}

test("search covers accepted Entry, user-tag, and Note fields", () => {
  const subject = fixture();
  try {
    const title = add(subject.registry, "https://alpha.example.test/posts/one", { title: "Blue Orchard" });
    const original = add(subject.registry, "https://beta.example.test/original-needle?utm_source=removed");
    const canonical = add(subject.registry, "https://gamma.example.test/path?kept=canonical-needle&utm_source=x");
    const tag = add(subject.registry, "https://delta.example.test/four");
    addTags(subject.registry, tag.id, ["그림자료"]);

    const note = add(subject.registry, "https://epsilon.example.test/five", {
      typedMetadata: { secret: "metadata-needle" }
    });
    addComment(subject.registry, note.id, "Comment-Needle with 100%_literal text");
    addRemoteImageReference(subject.registry, note.id, "https://cdn.example.test/asset-needle.jpg", {
      sourceKind: "browser_selected"
    });

    assert.deepEqual(listEntries(subject.registry, { search: "blue orchard" }).items.map((item) => item.id), [title.id]);
    assert.deepEqual(listEntries(subject.registry, { search: "original-needle" }).items.map((item) => item.id), [original.id]);
    assert.deepEqual(listEntries(subject.registry, { search: "canonical-needle" }).items.map((item) => item.id), [canonical.id]);
    assert.deepEqual(listEntries(subject.registry, { search: "generic-web" }).items.map((item) => item.id), [note.id, tag.id, canonical.id, original.id, title.id]);
    assert.deepEqual(listEntries(subject.registry, { search: "delta.example.test" }).items.map((item) => item.id), [tag.id]);
    assert.deepEqual(listEntries(subject.registry, { search: "그림자료" }).items.map((item) => item.id), [tag.id]);
    assert.equal(listEntries(subject.registry, { search: "metadata-needle" }).total, 0);
    assert.deepEqual(listEntries(subject.registry, { search: "comment-needle" }).items.map((item) => item.id), [note.id]);
    assert.deepEqual(listEntries(subject.registry, { search: "100%_LITERAL" }).items.map((item) => item.id), [note.id]);
    assert.equal(listEntries(subject.registry, { search: "asset-needle" }).total, 0);
  } finally {
    dispose(subject);
  }
});

test("search treats SQL wildcard characters as literal text", () => {
  const subject = fixture();
  try {
    const percent = add(subject.registry, "https://example.test/percent", { title: "100% complete" });
    const underscore = add(subject.registry, "https://example.test/underscore", { title: "under_score" });
    const backslash = add(subject.registry, "https://example.test/backslash", { title: "folder\\name" });
    add(subject.registry, "https://example.test/control", { title: "underXscore 1000 complete" });

    assert.deepEqual(listEntries(subject.registry, { search: "%" }).items.map((item) => item.id), [percent.id]);
    assert.deepEqual(listEntries(subject.registry, { search: "_" }).items.map((item) => item.id), [underscore.id]);
    assert.deepEqual(listEntries(subject.registry, { search: "\\" }).items.map((item) => item.id), [backslash.id]);
  } finally {
    dispose(subject);
  }
});

test("sort modes are deterministic and title falls back to original URL", () => {
  const subject = fixture();
  try {
    const zulu = add(subject.registry, "https://example.test/zulu", { title: "Zulu", savedAt: "2026-01-01T00:00:00.000Z" });
    const alphaOlder = add(subject.registry, "https://example.test/alpha-older", { title: "alpha", savedAt: "2026-01-02T00:00:00.000Z" });
    const alphaNewer = add(subject.registry, "https://example.test/alpha-newer", { title: "Alpha", savedAt: "2026-01-02T00:00:00.000Z" });
    const fallback = add(subject.registry, "https://example.test/00-no-title", { savedAt: "2026-01-03T00:00:00.000Z" });

    assert.deepEqual(listEntries(subject.registry).items.map((item) => item.id), [fallback.id, alphaNewer.id, alphaOlder.id, zulu.id]);
    assert.deepEqual(listEntries(subject.registry, { sort: "oldest" }).items.map((item) => item.id), [zulu.id, alphaOlder.id, alphaNewer.id, fallback.id]);
    assert.deepEqual(listEntries(subject.registry, { sort: "title" }).items.map((item) => item.id), [alphaOlder.id, alphaNewer.id, fallback.id, zulu.id]);
    assert.deepEqual(listEntries(subject.registry, { sort: "title_asc" }).items.map((item) => item.id), [alphaOlder.id, alphaNewer.id, fallback.id, zulu.id]);
    assert.deepEqual(listEntries(subject.registry, { sort: "title_desc" }).items.map((item) => item.id), [zulu.id, fallback.id, alphaNewer.id, alphaOlder.id]);
    assert.equal(listEntries(subject.registry, { sort: "title" }).items[0].id, alphaOlder.id);
    assert.throws(() => listEntries(subject.registry, { sort: "popular" }), (error) => error.code === "VALIDATION_ERROR");
  } finally {
    dispose(subject);
  }
});

test("preview slices use only a renderable explicit cover and remain content-focus independent", () => {
  const subject = fixture();
  try {
    const withCover = add(subject.registry, "https://preview.example.test/with", { contentFocus: "text" });
    const withoutAsset = add(subject.registry, "https://preview.example.test/none", { contentFocus: "visual" });
    const clearedCover = add(subject.registry, "https://preview.example.test/cleared");
    const errorCover = add(subject.registry, "https://preview.example.test/error");
    addRemoteImageReference(subject.registry, withCover.id, "https://cdn.example.test/with.jpg", { makeCover: true });
    subject.registry.db.prepare("UPDATE entries SET content_focus = 'text' WHERE id = ?").run(withCover.id);
    addRemoteImageReference(subject.registry, clearedCover.id, "https://cdn.example.test/cleared.jpg", { makeCover: true });
    clearCover(subject.registry, clearedCover.id);
    const failed = addRemoteImageReference(subject.registry, errorCover.id, "https://cdn.example.test/error.jpg", { makeCover: true });
    subject.registry.db.prepare("UPDATE entry_visual_assets SET status = 'error' WHERE id = ?").run(failed.asset.id);

    assert.deepEqual(listEntries(subject.registry, { preview: "with" }).items.map((item) => item.id), [withCover.id]);
    assert.deepEqual(listEntries(subject.registry, { preview: "without", sort: "oldest" }).items.map((item) => item.id), [withoutAsset.id, clearedCover.id, errorCover.id]);
    assert.equal(listEntries(subject.registry, { preview: "with", contentFocus: "text" }).total, 1);
    assert.throws(() => listEntries(subject.registry, { preview: "sometimes" }), (error) => error.code === "VALIDATION_ERROR");
  } finally {
    dispose(subject);
  }
});

test("source and recently edited sorts are stable", () => {
  const subject = fixture();
  try {
    const zulu = add(subject.registry, "https://zulu.example.test/z", { title: "Same" });
    const alphaOlder = add(subject.registry, "https://alpha.example.test/b", { title: "Beta" });
    const alphaNewer = add(subject.registry, "https://alpha.example.test/a", { title: "Alpha" });
    subject.registry.db.prepare("UPDATE entries SET record_updated_at = ? WHERE id = ?").run("2026-01-02T00:00:00.000Z", alphaOlder.id);
    subject.registry.db.prepare("UPDATE entries SET record_updated_at = ? WHERE id = ?").run("2026-01-03T00:00:00.000Z", alphaNewer.id);
    subject.registry.db.prepare("UPDATE entries SET record_updated_at = ? WHERE id = ?").run("2026-01-01T00:00:00.000Z", zulu.id);

    assert.deepEqual(listEntries(subject.registry, { sort: "source_asc" }).items.map((item) => item.id), [alphaNewer.id, alphaOlder.id, zulu.id]);
    assert.deepEqual(listEntries(subject.registry, { sort: "source_desc" }).items.map((item) => item.id), [zulu.id, alphaOlder.id, alphaNewer.id]);
    assert.deepEqual(listEntries(subject.registry, { sort: "updated_desc" }).items.map((item) => item.id), [alphaNewer.id, alphaOlder.id, zulu.id]);
    assert.deepEqual(listEntries(subject.registry, { sort: "updated_asc" }).items.map((item) => item.id), [zulu.id, alphaOlder.id, alphaNewer.id]);
  } finally {
    dispose(subject);
  }
});

test("combined filters retain pagination and hydrate all page tags", () => {
  const subject = fixture();
  try {
    const folder = createFolder(subject.registry, { name: "Research" });
    const first = add(subject.registry, "https://example.test/match-one", {
      title: "Needle One",
      folderId: folder.id,
      savedAt: "2026-01-02T00:00:00.000Z"
    });
    const second = add(subject.registry, "https://example.test/match-two", {
      title: "Needle Two",
      folderId: folder.id,
      savedAt: "2026-01-03T00:00:00.000Z"
    });
    addTags(subject.registry, first.id, ["research", "alpha"]);
    addTags(subject.registry, second.id, ["research", "beta"]);
    add(subject.registry, "https://example.test/match-private", {
      title: "Needle Private",
      folderId: folder.id,
      visibility: "private",
      agentAccess: "blocked",
      savedAt: "2026-01-04T00:00:00.000Z"
    });

    addComment(subject.registry, first.id, "note-only needle");
    addComment(subject.registry, first.id, "note-only needle repeated");
    addComment(subject.registry, second.id, "NOTE-ONLY NEEDLE");
    const filteredPage = listEntries(subject.registry, {
      folderId: folder.id,
      tag: "research",
      visibility: "normal",
      savedFrom: "2026-01-01",
      savedTo: "2026-01-31",
      search: "note-only needle",
      sort: "oldest",
      page: 1,
      pageSize: 2
    });

    assert.deepEqual(filteredPage.items.map((item) => item.id), [first.id, second.id]);
    assert.deepEqual(filteredPage.items.map((item) => item.tags.map((tag) => tag.normalized_name)), [
      ["alpha", "research"],
      ["beta", "research"]
    ]);
    assert.equal(filteredPage.total, 2);
    assert.deepEqual(getEntry(subject.registry, first.id).tags.map((tag) => tag.normalized_name), ["alpha", "research"]);
  } finally {
    dispose(subject);
  }
});

test("Entry reads expose only the latest completed summary result", () => {
  const subject = fixture();
  try {
    const summarized = add(subject.registry, "https://example.test/summarized");
    const queuedOnly = add(subject.registry, "https://example.test/queued-only");
    const insertJob = subject.registry.db.prepare(`
      INSERT INTO summary_jobs (
        entry_id, status, model, reasoning_effort, input_sha256, input_fields_json,
        policy_snapshot_json, requested_by, requested_at, completed_at
      ) VALUES (?, ?, 'gpt-5.6-luna', 'max', ?, '[]', '{}', 'test', ?, ?)
    `);
    const olderJob = insertJob.run(summarized.id, "completed", "older-input", "2026-01-02T00:00:00.000Z", "2026-01-02T00:00:00.000Z");
    const newerJob = insertJob.run(summarized.id, "completed", "newer-input", "2026-01-03T00:00:00.000Z", "2026-01-03T00:00:00.000Z");
    const queuedJob = insertJob.run(queuedOnly.id, "queued", "queued-input", "2026-01-04T00:00:00.000Z", null);
    const insertSummary = subject.registry.db.prepare(`
      INSERT INTO summaries (
        entry_id, job_id, summary_text, model, reasoning_effort, input_sha256, created_at
      ) VALUES (?, ?, ?, 'gpt-5.6-luna', 'max', ?, ?)
    `);
    insertSummary.run(summarized.id, Number(olderJob.lastInsertRowid), "Older summary", "older-input", "2026-01-02T00:00:00.000Z");
    const newerSummary = insertSummary.run(summarized.id, Number(newerJob.lastInsertRowid), "Newest summary", "newer-input", "2026-01-03T00:00:00.000Z");
    insertSummary.run(queuedOnly.id, Number(queuedJob.lastInsertRowid), "Incomplete summary", "queued-input", "2026-01-04T00:00:00.000Z");

    assert.deepEqual(getEntry(subject.registry, summarized.id).latest_summary, {
      id: Number(newerSummary.lastInsertRowid),
      text: "Newest summary",
      model: "gpt-5.6-luna",
      reasoning_effort: "max",
      input_sha256: "newer-input",
      created_at: "2026-01-03T00:00:00.000Z"
    });
    const listed = listEntries(subject.registry, { sort: "oldest" }).items;
    assert.equal(listed.find((entry) => entry.id === summarized.id).latest_summary.text, "Newest summary");
    assert.equal(listed.find((entry) => entry.id === queuedOnly.id).latest_summary, null);
  } finally {
    dispose(subject);
  }
});
