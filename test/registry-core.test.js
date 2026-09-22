"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { openRegistry } = require("../registry/database");
const { addEntry, archiveEntry, editEntry, getEntry, listEntries, restoreEntry, setEntryPolicy } = require("../registry/entries");
const { addComment, listComments } = require("../registry/comments");
const { addTags, listTags, removeTags, suggestTags } = require("../registry/tags");
const { topSourceDomains, topTags } = require("../registry/insights");
const { createFolder } = require("../registry/folders");

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wbh-core-"));
  return { directory, registry: openRegistry({ dbPath: path.join(directory, "registry.sqlite3") }) };
}
function dispose(subject) { subject.registry.close(); fs.rmSync(subject.directory, { recursive: true, force: true, maxRetries: 3 }); }
function add(registry, suffix, input = {}) {
  return addEntry(registry, { url: `https://example.test/${suffix}`, savedAt: `2026-01-0${input.day || 1}T00:00:00.000Z`, visibility: "normal", agentAccess: "allowed", aiProcessing: "enabled", ...input }).entry;
}

test("entries preserve original and derived URL fields while editable metadata remains user-owned", () => {
  const subject = fixture();
  try {
    const created = addEntry(subject.registry, { url: " https://www.example.test/path?utm_source=x&b=2&a=1 ", title: "Original", typedMetadata: { author: "Synthetic", score: 1 }, savedAt: "2026-01-01" }).entry;
    const edited = editEntry(subject.registry, created.id, { title: "Edited", typedMetadata: { note: "replacement" }, publishedAt: "2025-12-01" });
    assert.equal(edited.url_original, "https://www.example.test/path?utm_source=x&b=2&a=1");
    assert.equal(edited.url_canonical, "https://www.example.test/path?a=1&b=2");
    assert.equal(edited.provider, "generic-web");
    assert.equal(edited.source_domain, "example.test");
    assert.deepEqual(edited.typed_metadata, { note: "replacement" });
    assert.equal(getEntry(subject.registry, created.id).title, "Edited");
  } finally { dispose(subject); }
});

test("exact and canonical repeats reuse one Entry without mutating it", () => {
  const subject = fixture();
  try {
    const first = add(subject.registry, "same?a=1&utm_campaign=x", { day: 1, title: "one" });
    const exact = addEntry(subject.registry, { url: "https://example.test/same?a=1&utm_campaign=x", savedAt: "2026-01-02", visibility: "normal", agentAccess: "allowed", aiProcessing: "enabled" });
    const canonical = addEntry(subject.registry, { url: "https://example.test/same?utm_source=y&a=1", savedAt: "2026-01-03", visibility: "normal", agentAccess: "allowed", aiProcessing: "enabled" });
    assert.equal(exact.outcome_code, "already_saved");
    assert.equal(canonical.outcome_code, "already_saved");
    assert.equal(exact.entry.id, first.id);
    assert.equal(canonical.entry.id, first.id);
    assert.equal(exact.entry.title, "one");
    assert.equal(listEntries(subject.registry).total, 1);
  } finally { dispose(subject); }
});

test("entry lists apply every filter and stable saved-date pagination", () => {
  const subject = fixture();
  try {
    const a = add(subject.registry, "article", { day: 1, kind: "article", title: "a" });
    addTags(subject.registry, a.id, ["Research", "foo  bar"]);
    const b = add(subject.registry, "video", { day: 2, kind: "video", title: "b", visibility: "private", agentAccess: "metadata_only" });
    const c = addEntry(subject.registry, { url: "https://source.example.test/repo", savedAt: "2026-01-03", kind: "code", visibility: "normal", agentAccess: "blocked", aiProcessing: "manual" }).entry;
    assert.deepEqual(listEntries(subject.registry, { savedFrom: "2026-01-02", savedTo: "2026-01-02" }).items.map(x => x.id), [b.id]);
    assert.deepEqual(listEntries(subject.registry, { tag: "research" }).items.map(x => x.id), [a.id]);
    assert.deepEqual(listEntries(subject.registry, { tag: "FOO BAR" }).items.map(x => x.id), [a.id]);
    assert.deepEqual(listEntries(subject.registry, { kind: "video" }).items.map(x => x.id), [b.id]);
    assert.deepEqual(listEntries(subject.registry, { provider: "GENERIC-WEB" }).items.map(x => x.id), [c.id, b.id, a.id]);
    assert.deepEqual(listEntries(subject.registry, { sourceDomain: "WWW.source.example.test." }).items.map(x => x.id), [c.id]);
    assert.deepEqual(listEntries(subject.registry, { visibility: "private" }).items.map(x => x.id), [b.id]);
    assert.deepEqual(listEntries(subject.registry, { agentAccess: "blocked" }).items.map(x => x.id), [b.id]);
    const first = listEntries(subject.registry, { page: 1, pageSize: 2 }); const second = listEntries(subject.registry, { page: 2, pageSize: 2 });
    assert.deepEqual(first.items.map(x => x.id), [c.id, b.id]); assert.deepEqual(second.items.map(x => x.id), [a.id]);
  } finally { dispose(subject); }
});

test("content focus and Folder filters stay independent from URL classification and tags", () => {
  const subject = fixture();
  try {
    const root = createFolder(subject.registry, { name: "Artists" });
    const child = createFolder(subject.registry, { name: "Example Artist", parentId: root.id });
    const text = addEntry(subject.registry, {
      url: "https://example.test/shared/text",
      title: "Text reference",
      folderId: root.id
    }).entry;
    const visual = addEntry(subject.registry, {
      url: "https://example.test/shared/visual",
      title: "Visual reference",
      contentFocus: "visual",
      folderId: child.id
    }).entry;
    addTags(subject.registry, visual.id, ["art"]);

    assert.equal(text.content_focus, "text");
    assert.equal(text.folder.id, root.id);
    assert.equal(visual.content_focus, "visual");
    assert.equal(visual.folder.id, child.id);
    assert.equal(visual.provider, text.provider);
    assert.notEqual(visual.url_canonical, text.url_canonical);
    assert.deepEqual(listEntries(subject.registry, { contentFocus: "visual" }).items.map((item) => item.id), [visual.id]);
    assert.deepEqual(listEntries(subject.registry, { folderId: root.id }).items.map((item) => item.id), [text.id]);
    assert.deepEqual(
      listEntries(subject.registry, { folderId: root.id, includeDescendants: true }).items.map((item) => item.id),
      [visual.id, text.id]
    );
    assert.deepEqual(listEntries(subject.registry, { unfiled: true }).items, []);
    assert.equal(editEntry(subject.registry, visual.id, { contentFocus: "text" }).content_focus, "text");
    assert.equal(getEntry(subject.registry, visual.id).tags[0].normalized_name, "art");
  } finally {
    dispose(subject);
  }
});

test("date inputs reject ambiguous and impossible calendar values", () => {
  const subject = fixture();
  try {
    assert.throws(
      () => addEntry(subject.registry, { url: "https://example.test/date", savedAt: "02/03/2026" }),
      (error) => error.code === "VALIDATION_ERROR"
    );
    assert.throws(
      () => addEntry(subject.registry, { url: "https://example.test/date", savedAt: "2026-02-30" }),
      (error) => error.code === "VALIDATION_ERROR"
    );
  } finally {
    dispose(subject);
  }
});

test("comments append, tags normalize/add/remove, insights order ties, and policy mirrors follow visibility", () => {
  const subject = fixture();
  try {
    const one = add(subject.registry, "one", { day: 1 }); const two = add(subject.registry, "two", { day: 2 }); const three = add(subject.registry, "three", { day: 3 });
    addComment(subject.registry, one.id, "first"); addComment(subject.registry, one.id, "second");
    assert.deepEqual(listComments(subject.registry, one.id).items.map(x => x.body), ["first", "second"]);
    assert.throws(() => subject.registry.db.exec("UPDATE entry_comments SET body = 'no' WHERE entry_id = 1"), /append-only/);
    addTags(subject.registry, one.id, [" Research ", "alpha", "research"]); addTags(subject.registry, two.id, ["alpha", "Beta"]); addTags(subject.registry, three.id, ["Beta"]);
    assert.deepEqual(listTags(subject.registry, one.id).map(x => x.normalized_name), ["alpha", "research"]);
    assert.deepEqual(removeTags(subject.registry, one.id, ["RESEARCH"]).removed, ["Research"]);
    assert.deepEqual(topTags(subject.registry).map(x => x.normalized_name), ["alpha", "beta"]);
    for (const domain of ["a.example.test", "b.example.test"]) {
      for (let index = 1; index <= 3; index += 1) {
        addEntry(subject.registry, { url: `https://${domain}/${index}`, savedAt: "2026-01-04", visibility: "normal", agentAccess: "allowed", aiProcessing: "enabled" });
      }
    }
    assert.deepEqual(topSourceDomains(subject.registry), [
      { source_domain: "a.example.test", entry_count: 3 },
      { source_domain: "b.example.test", entry_count: 3 },
      { source_domain: "example.test", entry_count: 3 }
    ]);
    const policy = setEntryPolicy(subject.registry, one.id, { visibility: "private", agentAccess: "metadata_only", aiProcessing: "manual" });
    assert.deepEqual([policy.visibility, policy.agent_access, policy.ai_processing], ["private", "blocked", "disabled"]);
  } finally { dispose(subject); }
});

test("insight counts exclude archived Entries and include restored Entries", () => {
  const subject = fixture();
  try {
    const active = add(subject.registry, "active");
    const archived = add(subject.registry, "archived");
    addTags(subject.registry, active.id, ["Shared"]);
    addTags(subject.registry, archived.id, ["Shared", "Archived only"]);
    archiveEntry(subject.registry, archived.id);
    assert.deepEqual(topTags(subject.registry), [{
      id: active.tags?.[0]?.id || listTags(subject.registry, active.id)[0].id,
      name: "Shared",
      normalized_name: "shared",
      entry_count: 1
    }]);
    assert.deepEqual(topSourceDomains(subject.registry, { threshold: 1 }), [
      { source_domain: "example.test", entry_count: 1 }
    ]);
    restoreEntry(subject.registry, archived.id);
    assert.deepEqual(topTags(subject.registry).map((tag) => [tag.normalized_name, tag.entry_count]), [
      ["shared", 2], ["archived only", 1]
    ]);
  } finally { dispose(subject); }
});

test("tag suggestions rank prefix before substring, then usage and name, with exclusions and bounds", () => {
  const subject = fixture();
  try {
    const one = add(subject.registry, "suggest-one");
    const two = add(subject.registry, "suggest-two");
    const three = add(subject.registry, "suggest-three");
    addTags(subject.registry, one.id, ["Alpha", "Alphabet", "Graph", "연구 자료"]);
    addTags(subject.registry, two.id, ["Alpha", "Alpine", "Graph", "연구 자료"]);
    addTags(subject.registry, three.id, ["Alpine", "Paragraph", "연구 노트"]);
    assert.deepEqual(suggestTags(subject.registry, { query: "AL", limit: 8 }).map((tag) => tag.normalized_name), [
      "alpha", "alpine", "alphabet"
    ]);
    assert.deepEqual(suggestTags(subject.registry, { query: "ph", exclude: ["ALPHA"] }).map((tag) => tag.normalized_name), [
      "graph", "alphabet", "paragraph"
    ]);
    assert.deepEqual(suggestTags(subject.registry, { query: "연구" }).map((tag) => tag.normalized_name), [
      "연구 자료", "연구 노트"
    ]);
    assert.deepEqual(suggestTags(subject.registry, { query: "" }), []);
    assert.throws(() => suggestTags(subject.registry, { query: "a", limit: 9 }), { code: "VALIDATION_ERROR" });
  } finally {
    dispose(subject);
  }
});
