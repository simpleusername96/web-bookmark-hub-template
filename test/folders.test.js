"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { openRegistry } = require("../registry/database.js");
const { addEntry, archiveEntry, getEntry } = require("../registry/entries.js");
const { addTags, listTags } = require("../registry/tags.js");
const {
  assignEntryToFolder,
  createFolder,
  deleteFolder,
  descendantFolderIds,
  getFolder,
  getFolderForEntry,
  getFolderTree,
  listFolders,
  moveFolder,
  renameFolder,
  unassignEntryFromFolder,
  updateFolder
} = require("../registry/folders.js");

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wbh-folders-"));
  return { directory, registry: openRegistry({ dbPath: path.join(directory, "registry.sqlite3") }) };
}

function dispose(subject) {
  subject.registry.close();
  fs.rmSync(subject.directory, { recursive: true, force: true, maxRetries: 3 });
}

function add(registry, suffix) {
  return addEntry(registry, {
    url: `https://example.test/${suffix}`,
    visibility: "normal",
    agentAccess: "allowed",
    aiProcessing: "enabled"
  }).entry;
}

test("archived membership blocks Folder deletion without changing active counts or placement", () => {
  const subject = fixture();
  try {
    const folder = createFolder(subject.registry, { name: "Archived members" });
    const entry = addEntry(subject.registry, { url: "https://example.test/archived-folder", folderId: folder.id }).entry;
    archiveEntry(subject.registry, entry.id);
    assert.equal(getFolder(subject.registry, folder.id).entry_count, 0);
    assert.throws(() => deleteFolder(subject.registry, folder.id), (error) => (
      error.code === "FOLDER_NOT_EMPTY" && error.details.entryCount === 1
    ));
    assert.equal(getEntry(subject.registry, entry.id, { includeArchived: true }).folder_id, folder.id);
    assert.equal(getFolder(subject.registry, folder.id).entry_count, 0);
  } finally {
    dispose(subject);
  }
});

test("Folders normalize names, remain unique among siblings, and list deterministically", () => {
  const subject = fixture();
  try {
    const archive = createFolder(subject.registry, { name: "  Ａrchive\tNotes  " });
    const zeta = createFolder(subject.registry, { name: "Zeta" });
    assert.deepEqual(
      listFolders(subject.registry).map((folder) => [folder.name, folder.normalized_name]),
      [["Archive Notes", "archive notes"], ["Zeta", "zeta"]]
    );
    assert.throws(
      () => createFolder(subject.registry, { name: "archive  notes" }),
      (error) => error.code === "FOLDER_NAME_CONFLICT"
    );
    assert.throws(
      () => createFolder(subject.registry, { name: "child", parentId: 9999 }),
      (error) => error.code === "FOLDER_NOT_FOUND"
    );
    assert.equal(getFolder(subject.registry, archive.id).entry_count, 0);
    assert.equal(zeta.parent_id, null);
  } finally {
    dispose(subject);
  }
});

test("Folder hierarchy supports tree, rename, moves, and cycle refusal", () => {
  const subject = fixture();
  try {
    const root = createFolder(subject.registry, { name: "Root" });
    const beta = createFolder(subject.registry, { name: "Beta", parentId: root.id });
    const alpha = createFolder(subject.registry, { name: "Alpha", parentId: root.id });
    const leaf = createFolder(subject.registry, { name: "Leaf", parentId: alpha.id });
    assert.deepEqual(descendantFolderIds(subject.registry, root.id), [alpha.id, beta.id, leaf.id]);
    assert.deepEqual(descendantFolderIds(subject.registry, alpha.id), [leaf.id]);
    assert.deepEqual(
      getFolderTree(subject.registry, { rootId: root.id }).children.map((folder) => folder.id),
      [alpha.id, beta.id]
    );
    assert.throws(
      () => moveFolder(subject.registry, root.id, root.id),
      (error) => error.code === "FOLDER_CYCLE"
    );
    assert.throws(
      () => moveFolder(subject.registry, root.id, leaf.id),
      (error) => error.code === "FOLDER_CYCLE"
    );
    assert.throws(
      () => renameFolder(subject.registry, beta.id, " alpha "),
      (error) => error.code === "FOLDER_NAME_CONFLICT"
    );
    assert.equal(renameFolder(subject.registry, beta.id, "Projects").name, "Projects");
    assert.equal(moveFolder(subject.registry, beta.id, null).parent_id, null);
    assert.deepEqual(listFolders(subject.registry, { parentId: root.id }).map((folder) => folder.id), [alpha.id]);
  } finally {
    dispose(subject);
  }
});

test("Folder updates validate the final name and parent before one atomic change", () => {
  const subject = fixture();
  try {
    const first = createFolder(subject.registry, { name: "First" });
    const second = createFolder(subject.registry, { name: "Second" });
    const target = createFolder(subject.registry, { name: "Target", parentId: first.id });
    const child = createFolder(subject.registry, { name: "Child", parentId: target.id });
    createFolder(subject.registry, { name: "Shared", parentId: first.id });
    const conflict = createFolder(subject.registry, { name: "Conflict", parentId: second.id });

    assert.throws(
      () => updateFolder(subject.registry, target.id, { name: "Changed", parentId: 9999 }),
      (error) => error.code === "FOLDER_NOT_FOUND"
    );
    assert.deepEqual([getFolder(subject.registry, target.id).name, getFolder(subject.registry, target.id).parent_id], ["Target", first.id]);
    assert.throws(
      () => updateFolder(subject.registry, target.id, { name: "Changed", parentId: child.id }),
      (error) => error.code === "FOLDER_CYCLE"
    );
    assert.deepEqual([getFolder(subject.registry, target.id).name, getFolder(subject.registry, target.id).parent_id], ["Target", first.id]);
    assert.throws(
      () => updateFolder(subject.registry, target.id, { name: conflict.name, parentId: second.id }),
      (error) => error.code === "FOLDER_NAME_CONFLICT"
    );
    assert.deepEqual([getFolder(subject.registry, target.id).name, getFolder(subject.registry, target.id).parent_id], ["Target", first.id]);

    const updated = updateFolder(subject.registry, target.id, { name: " Shared ", parentId: second.id });
    assert.deepEqual([updated.name, updated.parent_id], ["Shared", second.id]);
  } finally {
    dispose(subject);
  }
});

test("Entry assignment is one-folder-only and remains independent from tags", () => {
  const subject = fixture();
  try {
    const first = createFolder(subject.registry, { name: "First" });
    const second = createFolder(subject.registry, { name: "Second" });
    const entry = add(subject.registry, "tagged");
    addTags(subject.registry, entry.id, ["research", "context"]);
    const assigned = assignEntryToFolder(subject.registry, entry.id, first.id);
    assert.equal(assigned.folder.id, first.id);
    assert.deepEqual(listTags(subject.registry, entry.id).map((tag) => tag.normalized_name), ["context", "research"]);
    assert.equal(assignEntryToFolder(subject.registry, entry.id, second.id).folder.id, second.id);
    assert.equal(getFolderForEntry(subject.registry, entry.id).folder.id, second.id);
    assert.deepEqual(unassignEntryFromFolder(subject.registry, entry.id), { entry_id: entry.id, folder: null });
    assert.equal(getFolderForEntry(subject.registry, entry.id).folder, null);
    assert.deepEqual(listTags(subject.registry, entry.id).map((tag) => tag.normalized_name), ["context", "research"]);
    assert.throws(
      () => assignEntryToFolder(subject.registry, 9999, first.id),
      (error) => error.code === "ENTRY_NOT_FOUND"
    );
  } finally {
    dispose(subject);
  }
});

test("Deleting a non-empty Folder fails without altering entries or descendants", () => {
  const subject = fixture();
  try {
    const root = createFolder(subject.registry, { name: "Root" });
    const child = createFolder(subject.registry, { name: "Child", parentId: root.id });
    const entry = add(subject.registry, "inside");
    assignEntryToFolder(subject.registry, entry.id, child.id);
    assert.throws(
      () => deleteFolder(subject.registry, root.id),
      (error) => error.code === "FOLDER_NOT_EMPTY" && error.details.childCount === 1 && error.details.entryCount === 0
    );
    assert.throws(
      () => deleteFolder(subject.registry, child.id),
      (error) => error.code === "FOLDER_NOT_EMPTY" && error.details.entryCount === 1
    );
    assert.equal(getFolder(subject.registry, child.id).parent_id, root.id);
    assert.equal(getFolderForEntry(subject.registry, entry.id).folder.id, child.id);
    unassignEntryFromFolder(subject.registry, entry.id);
    assert.deepEqual(deleteFolder(subject.registry, child.id), { id: child.id, deleted: true });
    assert.deepEqual(deleteFolder(subject.registry, root.id), { id: root.id, deleted: true });
  } finally {
    dispose(subject);
  }
});
