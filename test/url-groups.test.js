"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { openRegistry } = require("../registry/database.js");
const { addEntry, archiveEntry, listEntries } = require("../registry/entries.js");
const { createFolder } = require("../registry/folders.js");
const { addTags } = require("../registry/tags.js");
const { listUrlGroups } = require("../registry/url-groups.js");
const { addRemoteImageReference } = require("../registry/visual-assets.js");

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wbh-url-groups-"));
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

function flatten(groups) {
  return groups.flatMap((group) => [group, ...flatten(group.children)]);
}

function byLabel(groups, label) {
  return flatten(groups).find((group) => group.label === label);
}

test("domain roots ignore transport noise while preserving meaningful authority and path distinctions", () => {
  const subject = fixture();
  try {
    add(subject.registry, "http://www.a.com./images/a1?utm_source=synthetic#fragment");
    add(subject.registry, "https://a.com/images/a2?fbclid=synthetic");
    add(subject.registry, "https://media.a.com/only");
    add(subject.registry, "https://a.com:8443/only");
    add(subject.registry, "https://encoded.test/Case%2FPath/a");
    add(subject.registry, "https://encoded.test/Case%2FPath/b");
    add(subject.registry, "https://encoded.test/case%2FPath/only");

    const groups = listUrlGroups(subject.registry);
    assert.deepEqual(groups.map((group) => group.label), ["a.com", "a.com:8443", "encoded.test", "media.a.com"]);
    assert.equal(byLabel(groups, "a.com").entry_count, 2);
    assert.equal(byLabel(groups, "a.com/images").entry_count, 2);
    assert.equal(byLabel(groups, "encoded.test/Case%2FPath").entry_count, 2);
    assert.equal(byLabel(groups, "encoded.test/case%2FPath"), undefined);
    assert.equal(byLabel(groups, "media.a.com").entry_count, 1);
    assert.equal(byLabel(groups, "a.com:8443").entry_count, 1);
  } finally {
    dispose(subject);
  }
});

test("deepest useful clusters stay flat and query shapes expose names without values", () => {
  const subject = fixture();
  try {
    const cat = add(subject.registry, "https://tree.test/images/animals/cat");
    const dog = add(subject.registry, "https://tree.test/images/animals/dog");
    add(subject.registry, "https://tree.test/images/people/alice");
    add(subject.registry, "https://tree.test/images/people/bob");
    const videoOne = add(subject.registry, "https://video.test/watch?v=private-one&utm_source=x");
    const videoTwo = add(subject.registry, "https://video.test/watch?v=private-two");
    const listOne = add(subject.registry, "https://video.test/watch?list=hidden-one");
    const listTwo = add(subject.registry, "https://video.test/watch?list=hidden-two");
    add(subject.registry, "https://video.test/search?z=secret&a=first");
    add(subject.registry, "https://video.test/search?a=second&z=private");
    const duplicateOne = add(subject.registry, "https://duplicate.test/item?view=secret");
    const duplicateTwo = add(subject.registry, "https://duplicate.test/item?view=secret");
    assert.equal(duplicateTwo.id, duplicateOne.id);

    const groups = listUrlGroups(subject.registry);
    const tree = byLabel(groups, "tree.test");
    assert.deepEqual(tree.children.map((group) => group.label), [
      "tree.test/images/animals",
      "tree.test/images/people"
    ]);
    assert.equal(byLabel(groups, "tree.test/images"), undefined);
    assert.deepEqual(listEntries(subject.registry, { urlGroupId: tree.children[0].id }).items.map((item) => item.id), [dog.id, cat.id]);

    const video = byLabel(groups, "video.test");
    assert.deepEqual(video.children.map((group) => group.label), [
      "video.test/search?a=*&z=*",
      "video.test/watch?list=*",
      "video.test/watch?v=*"
    ]);
    assert.equal(byLabel(groups, "video.test/watch"), undefined);
    assert.deepEqual(
      listEntries(subject.registry, { urlGroupId: byLabel(groups, "video.test/watch?v=*").id }).items.map((item) => item.id),
      [videoTwo.id, videoOne.id]
    );
    assert.deepEqual(
      listEntries(subject.registry, { urlGroupId: byLabel(groups, "video.test/watch?list=*").id }).items.map((item) => item.id),
      [listTwo.id, listOne.id]
    );
    assert.ok(byLabel(groups, "video.test/search?a=*&z=*"));
    assert.equal(JSON.stringify(groups).includes("private-one"), false);
    assert.equal(JSON.stringify(groups).includes("hidden-one"), false);

    const duplicateQuery = byLabel(groups, "duplicate.test/item?view=*");
    assert.equal(duplicateQuery, undefined);
  } finally {
    dispose(subject);
  }
});

test("single-member path groups disappear, malformed URLs fail closed, and asset URLs never organize Entries", () => {
  const subject = fixture();
  try {
    const first = add(subject.registry, "https://corpus.test/solo/a");
    const second = add(subject.registry, "https://corpus.test/solo/b");
    addRemoteImageReference(subject.registry, first.id, "https://cdn.private.test/assets/selected.jpg", {
      sourceKind: "browser_selected"
    });
    createFolder(subject.registry, { name: "Untouched" });

    const schemaBefore = subject.registry.db.prepare(`
      SELECT type, name, sql FROM sqlite_schema ORDER BY type, name
    `).all().map((row) => [row.type, row.name, row.sql]);
    const foldersBefore = Number(subject.registry.db.prepare("SELECT COUNT(*) AS count FROM folders").get().count);
    const firstGroups = listUrlGroups(subject.registry);
    assert.ok(byLabel(firstGroups, "corpus.test/solo"));
    assert.equal(byLabel(firstGroups, "cdn.private.test"), undefined);

    archiveEntry(subject.registry, second.id);
    const reduced = listUrlGroups(subject.registry);
    assert.equal(byLabel(reduced, "corpus.test/solo"), undefined);
    assert.equal(byLabel(reduced, "corpus.test").entry_count, 1);

    subject.registry.db.prepare("UPDATE entries SET url_canonical = ? WHERE id = ?")
      .run("not-an-http-url", first.id);
    assert.equal(byLabel(listUrlGroups(subject.registry), "corpus.test"), undefined);

    const schemaAfter = subject.registry.db.prepare(`
      SELECT type, name, sql FROM sqlite_schema ORDER BY type, name
    `).all().map((row) => [row.type, row.name, row.sql]);
    assert.deepEqual(schemaAfter, schemaBefore);
    assert.equal(Number(subject.registry.db.prepare("SELECT COUNT(*) AS count FROM folders").get().count), foldersBefore);
  } finally {
    dispose(subject);
  }
});

test("path ladders collapse to one deepest supported child cluster per Entry", () => {
  const subject = fixture();
  try {
    const shallow = add(subject.registry, "https://ladder.test/a");
    const middle = add(subject.registry, "https://ladder.test/a/b");
    const deep = add(subject.registry, "https://ladder.test/a/b/c");
    const root = byLabel(listUrlGroups(subject.registry), "ladder.test");
    assert.deepEqual(root.children.map((group) => group.label), ["ladder.test/a/b"]);
    assert.equal(byLabel(root.children, "ladder.test/a"), undefined);
    assert.deepEqual(
      listEntries(subject.registry, { urlGroupId: root.children[0].id }).items.map((entry) => entry.id),
      [deep.id, middle.id]
    );
    assert.ok(!root.children.some((group) => listEntries(subject.registry, { urlGroupId: group.id }).items.some((entry) => entry.id === shallow.id)));
  } finally {
    dispose(subject);
  }
});

test("URL Group filtering composes with Registry filters and remains deterministic", () => {
  const subject = fixture();
  try {
    const folder = createFolder(subject.registry, { name: "Chosen" });
    const first = add(subject.registry, "https://combo.test/images/one", {
      title: "Needle Alpha",
      folderId: folder.id,
      savedAt: "2026-01-02T00:00:00.000Z"
    });
    const second = add(subject.registry, "https://combo.test/images/two", {
      title: "Needle Beta",
      folderId: folder.id,
      savedAt: "2026-01-03T00:00:00.000Z"
    });
    const privateEntry = add(subject.registry, "https://combo.test/images/three", {
      title: "Needle Private",
      visibility: "private",
      agentAccess: "blocked",
      savedAt: "2026-01-04T00:00:00.000Z"
    });
    addTags(subject.registry, first.id, ["chosen"]);
    addTags(subject.registry, second.id, ["chosen"]);

    const firstProjection = listUrlGroups(subject.registry);
    const secondProjection = listUrlGroups(subject.registry);
    assert.deepEqual(secondProjection, firstProjection);
    assert.ok(flatten(firstProjection).every((group) => /^[A-Za-z0-9_-]{43}$/.test(group.id)));

    const root = byLabel(firstProjection, "combo.test");
    const images = byLabel(firstProjection, "combo.test/images");
    assert.deepEqual(listEntries(subject.registry, { urlGroupId: root.id }).items.map((item) => item.id), [privateEntry.id, second.id, first.id]);
    assert.deepEqual(listEntries(subject.registry, { urlGroupId: images.id }).items.map((item) => item.id), [privateEntry.id, second.id, first.id]);

    const filtered = listEntries(subject.registry, {
      urlGroupId: images.id,
      folderId: folder.id,
      tag: "chosen",
      visibility: "normal",
      savedFrom: "2026-01-01",
      savedTo: "2026-01-31",
      search: "needle",
      sort: "oldest"
    });
    assert.deepEqual(filtered.items.map((item) => item.id), [first.id, second.id]);
    assert.throws(
      () => listEntries(subject.registry, { urlGroupId: "stale-group-id" }),
      (error) => error.code === "URL_GROUP_NOT_FOUND"
    );
  } finally {
    dispose(subject);
  }
});
