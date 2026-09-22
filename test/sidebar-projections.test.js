"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { openRegistry } = require("../registry/database.js");
const { addEntry, archiveEntry } = require("../registry/entries.js");
const { createFolder, getFolder } = require("../registry/folders.js");
const { getSidebarFolderTree, listSidebarUrlGroups } = require("../registry/sidebar-projections.js");

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wbh-sidebar-"));
  return { directory, registry: openRegistry({ dbPath: path.join(directory, "registry.sqlite3") }) };
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

test("sidebar projections hide zero-match branches while retaining navigation alternatives", () => {
  const subject = fixture();
  try {
    const parent = createFolder(subject.registry, { name: "Parent" });
    const normalFolder = createFolder(subject.registry, { name: "Normal", parentId: parent.id });
    const privateFolder = createFolder(subject.registry, { name: "Private", parentId: parent.id });
    add(subject.registry, "https://alpha.test/normal", { folderId: normalFolder.id, title: "Visible needle" });
    add(subject.registry, "https://beta.test/private", {
      folderId: privateFolder.id,
      title: "Hidden needle",
      visibility: "private"
    });

    const normalTree = getSidebarFolderTree(subject.registry, { visibility: "normal" });
    assert.deepEqual(normalTree[0].children.map((folder) => folder.name), ["Normal"]);
    assert.equal(normalTree[0].children[0].entry_count, 1);

    const selectedEmptyTree = getSidebarFolderTree(subject.registry, {
      visibility: "normal",
      folderId: privateFolder.id
    });
    assert.deepEqual(selectedEmptyTree[0].children.map((folder) => folder.name), ["Normal", "Private"]);
    assert.equal(selectedEmptyTree[0].children.find((folder) => folder.id === privateFolder.id).entry_count, 0);

    const normalGroups = listSidebarUrlGroups(subject.registry, { visibility: "normal" });
    assert.deepEqual(normalGroups.map((group) => group.label), ["alpha.test"]);

    const folderScopedGroups = listSidebarUrlGroups(subject.registry, {
      visibility: "normal",
      folderId: normalFolder.id
    });
    assert.deepEqual(folderScopedGroups.map((group) => group.label), ["alpha.test"]);
  } finally {
    dispose(subject);
  }
});

test("sidebar projections use the full matching set rather than one result page", () => {
  const subject = fixture();
  try {
    const folder = createFolder(subject.registry, { name: "Many" });
    for (let index = 0; index < 125; index += 1) {
      add(subject.registry, `https://many.test/items/${index}`, {
        folderId: folder.id,
        title: `Needle ${index}`
      });
    }
    const tree = getSidebarFolderTree(subject.registry, { search: "Needle" });
    assert.equal(tree[0].entry_count, 125);
    assert.equal(listSidebarUrlGroups(subject.registry, { search: "Needle" })[0].entry_count, 125);
  } finally {
    dispose(subject);
  }
});

test("folder and sidebar projections exclude archived-only Entries", () => {
  const subject = fixture();
  try {
    const folder = createFolder(subject.registry, { name: "Archived" });
    const entry = add(subject.registry, "https://archived.test/item", { folderId: folder.id });
    archiveEntry(subject.registry, entry.id);
    assert.equal(getFolder(subject.registry, folder.id).entry_count, 0);
    const tree = getSidebarFolderTree(subject.registry);
    assert.equal(tree.length, 1);
    assert.equal(tree[0].id, folder.id);
    assert.equal(tree[0].entry_count, 0);
    assert.equal(tree[0].entry_count_direct, 0);
    assert.equal(tree[0].entry_count_total, 0);
    assert.deepEqual(tree[0].children, []);
    assert.deepEqual(listSidebarUrlGroups(subject.registry), []);
  } finally {
    dispose(subject);
  }
});


test("Folder sidebar counts include visible descendants while preserving direct counts", () => {
  const subject = fixture();
  try {
    const parent = createFolder(subject.registry, { name: "Parent totals" });
    const child = createFolder(subject.registry, { name: "Child totals", parentId: parent.id });
    add(subject.registry, "https://totals.test/parent", { folderId: parent.id });
    add(subject.registry, "https://totals.test/child-a", { folderId: child.id });
    add(subject.registry, "https://totals.test/child-b", { folderId: child.id });
    const projected = getSidebarFolderTree(subject.registry);
    const parentNode = projected.find((node) => node.id === parent.id);
    assert.equal(parentNode.entry_count_direct, 1);
    assert.equal(parentNode.entry_count_total, 3);
    assert.equal(parentNode.entry_count, 3);
    assert.equal(parentNode.children[0].entry_count_total, 2);
  } finally {
    dispose(subject);
  }
});
