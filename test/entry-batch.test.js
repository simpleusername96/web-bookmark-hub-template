"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { openRegistry } = require("../registry/database.js");
const { batchEntries, batchEntriesMatching, selectionSnapshot } = require("../registry/entry-batch.js");
const { addEntry, editEntry, getEntry, listEntryRevisions } = require("../registry/entries.js");
const { createFolder } = require("../registry/folders.js");

function fixture() {
  const registry = openRegistry({ dbPath: ":memory:" });
  const first = addEntry(registry, { url: "https://example.test/a", visibility: "normal" }).entry;
  const second = addEntry(registry, { url: "https://example.test/b", visibility: "normal" }).entry;
  return { registry, first, second };
}

test("batch operations edit explicit active Entries atomically with revisions", async () => {
  const subject = fixture();
  try {
    const folder = createFolder(subject.registry, { name: "Synthetic" });
    const folderResult = await batchEntries(subject.registry, {
      entry_ids: [subject.first.id, subject.second.id],
      operation: "set_folder",
      value: { folder_id: folder.id },
      reason: "Synthetic batch"
    }, { actor: { type: "user", id: "test" } });
    assert.deepEqual([folderResult.matched, folderResult.changed], [2, 2]);
    assert.equal(getEntry(subject.registry, subject.first.id).folder_id, folder.id);

    const tagResult = await batchEntries(subject.registry, {
      entry_ids: [subject.first.id, subject.second.id],
      operation: "add_tags",
      value: { tags: ["Research"] }
    });
    assert.equal(tagResult.changed, 2);
    assert.deepEqual(getEntry(subject.registry, subject.second.id).tags.map((tag) => tag.normalized_name), ["research"]);
    assert.equal(listEntryRevisions(subject.registry, subject.first.id).length, 3);

    const policyResult = await batchEntries(subject.registry, {
      entry_ids: [subject.first.id, subject.second.id],
      operation: "set_policy",
      value: { visibility: "private", agent_access: "blocked", ai_processing: "disabled" }
    });
    assert.equal(policyResult.changed, 2);
    assert.equal(getEntry(subject.registry, subject.first.id).visibility, "private");

    const kindResult = await batchEntries(subject.registry, {
      entry_ids: [subject.first.id, subject.second.id],
      operation: "set_kind",
      value: { kind: "research" }
    });
    assert.equal(kindResult.changed, 2);
    assert.equal(getEntry(subject.registry, subject.first.id).kind, "research");
  } finally {
    subject.registry.close();
  }
});

test("batch validation rolls back every earlier mutation", async () => {
  const subject = fixture();
  try {
    await assert.rejects(batchEntries(subject.registry, {
      entry_ids: [subject.first.id, subject.second.id],
      operation: "set_content_focus",
      value: { content_focus: "unsupported" }
    }), { code: "VALIDATION_ERROR" });
    assert.equal(getEntry(subject.registry, subject.first.id).content_focus, "text");
    assert.equal(getEntry(subject.registry, subject.second.id).content_focus, "text");
    await assert.rejects(batchEntries(subject.registry, {
      entry_ids: [subject.first.id, subject.second.id],
      operation: "set_kind",
      value: { kind: "paper" }
    }), { code: "INVALID_KIND" });
    assert.equal(getEntry(subject.registry, subject.first.id).kind, "page");
    await assert.rejects(batchEntries(subject.registry, {
      entry_ids: [subject.first.id, 999], operation: "delete", value: {}
    }), { code: "ENTRY_NOT_FOUND" });
    assert.equal(getEntry(subject.registry, subject.first.id).deleted_at, null);
  } finally {
    subject.registry.close();
  }
});

test("batch delete permanently removes every selected Entry", async () => {
  const subject = fixture();
  try {
    const result = await batchEntries(subject.registry, {
      entry_ids: [subject.first.id, subject.second.id], operation: "delete", value: {}
    });
    assert.deepEqual([result.matched, result.changed, result.deleted], [2, 2, 2]);
    assert.equal(subject.registry.db.prepare("SELECT COUNT(*) AS count FROM entries").get().count, 0);
  } finally {
    subject.registry.close();
  }
});

test("query batch updates every matching Entry beyond the explicit selection limit and rejects stale counts", async () => {
  const subject = fixture();
  try {
    for (let index = 0; index < 101; index += 1) {
      addEntry(subject.registry, { url: `https://bulk.example.test/item/${index}`, title: `Bulk ${index}`, visibility: "normal" });
    }
    let snapshot = selectionSnapshot(subject.registry, { search: "bulk.example.test" });
    const result = await batchEntriesMatching(subject.registry, {
      filters: { search: "bulk.example.test" },
      expected_count: snapshot.expected_count,
      expected_digest: snapshot.expected_digest,
      operation: "set_policy",
      value: { visibility: "private" }
    });
    assert.deepEqual([result.matched, result.changed, result.entries], [101, 101, undefined]);
    assert.equal(subject.registry.db.prepare("SELECT COUNT(*) AS count FROM entries WHERE source_domain = 'bulk.example.test' AND visibility = 'private'").get().count, 101);

    await assert.rejects(batchEntriesMatching(subject.registry, {
      filters: { search: "bulk.example.test" },
      expected_count: 100,
      expected_digest: snapshot.expected_digest,
      operation: "set_kind",
      value: { kind: "research" }
    }), { code: "BATCH_QUERY_CHANGED" });
    assert.equal(subject.registry.db.prepare("SELECT COUNT(*) AS count FROM entries WHERE source_domain = 'bulk.example.test' AND kind = 'research'").get().count, 0);

    snapshot = selectionSnapshot(subject.registry, { search: "bulk.example.test" });
    const deleteResult = await batchEntriesMatching(subject.registry, {
      filters: { search: "bulk.example.test" },
      expected_count: snapshot.expected_count,
      expected_digest: snapshot.expected_digest,
      operation: "delete",
      value: {}
    });
    assert.deepEqual([deleteResult.matched, deleteResult.changed, deleteResult.deleted], [101, 101, 101]);
    assert.equal(subject.registry.db.prepare("SELECT COUNT(*) AS count FROM entries WHERE source_domain = 'bulk.example.test'").get().count, 0);
  } finally {
    subject.registry.close();
  }
});

test("query batch rejects same-count membership replacement and ignores presentation order", async () => {
  const subject = fixture();
  try {
    editEntry(subject.registry, subject.first.id, { title: "Selected" });
    editEntry(subject.registry, subject.second.id, { title: "Outside" });
    const snapshot = selectionSnapshot(subject.registry, { search: "selected" });
    assert.deepEqual(selectionSnapshot(subject.registry, { search: "selected", sort: "oldest" }), snapshot);
    editEntry(subject.registry, subject.first.id, { title: "Outside" });
    editEntry(subject.registry, subject.second.id, { title: "Selected" });
    await assert.rejects(batchEntriesMatching(subject.registry, {
      filters: { search: "selected" },
      expected_count: snapshot.expected_count,
      expected_digest: snapshot.expected_digest,
      operation: "set_kind",
      value: { kind: "research" }
    }), { code: "BATCH_QUERY_CHANGED" });
    assert.equal(getEntry(subject.registry, subject.second.id).kind, "page");
  } finally {
    subject.registry.close();
  }
});
