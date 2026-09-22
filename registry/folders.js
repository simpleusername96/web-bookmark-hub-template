"use strict";

const { RegistryError } = require("./errors.js");
const { withTransaction } = require("./database.js");
const { activeEntryPredicate } = require("./entry-status.js");
const { nowIso, positiveInteger } = require("./values.js");

const MAX_FOLDER_NAME_LENGTH = 200;

function createFolder(registry, input, { clock = Date } = {}) {
  const name = normalizeFolderName(input?.name);
  const parentId = normalizeOptionalFolderId(input?.parentId);

  return withTransaction(registry.db, () => {
    if (parentId !== null) getFolder(registry, parentId);
    assertSiblingNameAvailable(registry, parentId, name.normalizedName);
    const timestamp = nowIso(clock);
    const result = registry.db.prepare(`
      INSERT INTO folders (parent_id, name, normalized_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(parentId, name.name, name.normalizedName, timestamp, timestamp);
    return getFolder(registry, Number(result.lastInsertRowid));
  });
}

function getFolder(registry, id) {
  const folderId = folderIdValue(id);
  const row = registry.db.prepare(`
    SELECT f.*, (SELECT COUNT(*) FROM entries e WHERE e.folder_id = f.id AND ${activeEntryPredicate("e")}) AS entry_count
    FROM folders f
    WHERE f.id = ?
  `).get(folderId);
  if (!row) {
    throw new RegistryError("FOLDER_NOT_FOUND", "Folder not found.", { folderId });
  }
  return mapFolderRow(row);
}

function listFolders(registry, { parentId = null } = {}) {
  const normalizedParentId = normalizeOptionalFolderId(parentId);
  if (normalizedParentId !== null) getFolder(registry, normalizedParentId);
  return registry.db.prepare(`
    SELECT f.*, (SELECT COUNT(*) FROM entries e WHERE e.folder_id = f.id AND ${activeEntryPredicate("e")}) AS entry_count
    FROM folders f
    WHERE f.parent_id IS ?
    ORDER BY f.normalized_name ASC, f.id ASC
  `).all(normalizedParentId).map(mapFolderRow);
}

function getFolderTree(registry, { rootId } = {}) {
  if (rootId !== undefined && rootId !== null) {
    const root = getFolder(registry, rootId);
    const descendants = descendantFolderIds(registry, root.id);
    const rows = registry.db.prepare(`
      SELECT f.*, (SELECT COUNT(*) FROM entries e WHERE e.folder_id = f.id AND ${activeEntryPredicate("e")}) AS entry_count
      FROM folders f
      WHERE f.id IN (${[root.id, ...descendants].map(() => "?").join(", ")})
      ORDER BY f.normalized_name ASC, f.id ASC
    `).all(root.id, ...descendants);
    return buildTree(rows.map(mapFolderRow), root.id);
  }

  const rows = registry.db.prepare(`
    SELECT f.*, (SELECT COUNT(*) FROM entries e WHERE e.folder_id = f.id AND ${activeEntryPredicate("e")}) AS entry_count
    FROM folders f
    ORDER BY f.normalized_name ASC, f.id ASC
  `).all();
  return buildTree(rows.map(mapFolderRow));
}

function updateFolder(registry, id, input = {}, { clock = Date } = {}) {
  const folderId = folderIdValue(id);
  return withTransaction(registry.db, () => {
    const current = getFolder(registry, folderId);
    const hasName = Object.prototype.hasOwnProperty.call(input, "name");
    const hasParentId = Object.prototype.hasOwnProperty.call(input, "parentId");
    const name = hasName
      ? normalizeFolderName(input.name)
      : { name: current.name, normalizedName: current.normalized_name };
    const parentId = hasParentId ? normalizeOptionalFolderId(input.parentId) : current.parent_id;
    if (parentId === current.id) {
      throw new RegistryError("FOLDER_CYCLE", "A Folder cannot be its own parent.", { folderId: current.id, parentId });
    }
    if (parentId !== null) {
      getFolder(registry, parentId);
      if (descendantFolderIds(registry, current.id).includes(parentId)) {
        throw new RegistryError("FOLDER_CYCLE", "A Folder cannot move into one of its descendants.", {
          folderId: current.id,
          parentId
        });
      }
    }
    assertSiblingNameAvailable(registry, parentId, name.normalizedName, { exceptId: current.id });
    if (name.name === current.name && parentId === current.parent_id) return current;
    registry.db.prepare(`
      UPDATE folders SET name = ?, normalized_name = ?, parent_id = ?, updated_at = ? WHERE id = ?
    `).run(name.name, name.normalizedName, parentId, nowIso(clock), current.id);
    return getFolder(registry, current.id);
  });
}

function renameFolder(registry, id, nameInput, options = {}) {
  return updateFolder(registry, id, { name: nameInput }, options);
}

function moveFolder(registry, id, parentIdInput, options = {}) {
  return updateFolder(registry, id, { parentId: parentIdInput }, options);
}

function deleteFolder(registry, id) {
  const folderId = folderIdValue(id);
  return withTransaction(registry.db, () => {
    const folder = getFolder(registry, folderId);
    const childCount = Number(registry.db.prepare("SELECT COUNT(*) AS count FROM folders WHERE parent_id = ?").get(folder.id).count);
    const entryCount = Number(registry.db.prepare("SELECT COUNT(*) AS count FROM entries WHERE folder_id = ?").get(folder.id).count);
    if (childCount || entryCount) {
      throw new RegistryError("FOLDER_NOT_EMPTY", "Only empty Folders can be deleted.", {
        folderId: folder.id,
        childCount,
        entryCount
      });
    }
    registry.db.prepare("DELETE FROM folders WHERE id = ?").run(folder.id);
    return { id: folder.id, deleted: true };
  });
}

function assignEntryToFolder(registry, entryIdInput, folderIdInput, options = {}) {
  const entryId = positiveInteger(entryIdInput, "entry_id");
  const folderId = folderIdValue(folderIdInput);
  assertEntryExists(registry, entryId);
  getFolder(registry, folderId);
  const current = getFolderForEntry(registry, entryId);
  if (current.folder?.id === folderId) return current;
  require("./entries.js").editEntry(registry, entryId, { folderId }, options);
  return getFolderForEntry(registry, entryId);
}

function unassignEntryFromFolder(registry, entryIdInput, options = {}) {
  const entryId = positiveInteger(entryIdInput, "entry_id");
  assertEntryExists(registry, entryId);
  const current = getFolderForEntry(registry, entryId);
  if (current.folder === null) return current;
  require("./entries.js").editEntry(registry, entryId, { folderId: null }, options);
  return { entry_id: entryId, folder: null };
}

function getFolderForEntry(registry, entryIdInput) {
  const entryId = positiveInteger(entryIdInput, "entry_id");
  const row = registry.db.prepare(`
    SELECT f.*, (SELECT COUNT(*) FROM entries e WHERE e.folder_id = f.id AND ${activeEntryPredicate("e")}) AS entry_count
    FROM entries e
    LEFT JOIN folders f ON f.id = e.folder_id
    WHERE e.id = ?
  `).get(entryId);
  if (!row) {
    throw new RegistryError("ENTRY_NOT_FOUND", "Entry not found.", { entryId });
  }
  return { entry_id: entryId, folder: row.id === null ? null : mapFolderRow(row) };
}

function descendantFolderIds(registry, id) {
  const folderId = folderIdValue(id);
  getFolder(registry, folderId);
  const rows = registry.db.prepare(`
    WITH RECURSIVE descendants(id, depth) AS (
      SELECT id, 0 FROM folders WHERE id = ?
      UNION ALL
      SELECT f.id, descendants.depth + 1
      FROM folders f
      JOIN descendants ON f.parent_id = descendants.id
    )
    SELECT descendants.id
    FROM descendants
    JOIN folders f ON f.id = descendants.id
    WHERE descendants.depth > 0
    ORDER BY f.normalized_name ASC, f.id ASC
  `).all(folderId);
  return rows.map((row) => Number(row.id));
}

function normalizeFolderName(value) {
  const name = String(value ?? "").normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (!name) {
    throw new RegistryError("VALIDATION_ERROR", "folder name is required.", { field: "name" });
  }
  if (name.length > MAX_FOLDER_NAME_LENGTH) {
    throw new RegistryError("VALIDATION_ERROR", "folder name is too long.", {
      field: "name",
      maxLength: MAX_FOLDER_NAME_LENGTH
    });
  }
  return { name, normalizedName: name.toLocaleLowerCase("en-US") };
}

function normalizeOptionalFolderId(value) {
  if (value === undefined || value === null || value === "") return null;
  return folderIdValue(value);
}

function folderIdValue(value) {
  return positiveInteger(value, "folder_id");
}

function assertEntryExists(registry, entryId) {
  const row = registry.db.prepare("SELECT id FROM entries WHERE id = ?").get(entryId);
  if (!row) {
    throw new RegistryError("ENTRY_NOT_FOUND", "Entry not found.", { entryId });
  }
}

function assertSiblingNameAvailable(registry, parentId, normalizedName, { exceptId } = {}) {
  const row = registry.db.prepare(`
    SELECT id FROM folders
    WHERE parent_id IS ? AND normalized_name = ?
    ${exceptId === undefined ? "" : "AND id != ?"}
    LIMIT 1
  `).get(...(exceptId === undefined ? [parentId, normalizedName] : [parentId, normalizedName, exceptId]));
  if (row) {
    throw new RegistryError("FOLDER_NAME_CONFLICT", "A sibling Folder already uses that name.", {
      parentId,
      normalizedName
    });
  }
}

function mapFolderRow(row) {
  return {
    id: Number(row.id),
    parent_id: row.parent_id === null ? null : Number(row.parent_id),
    name: row.name,
    normalized_name: row.normalized_name,
    created_at: row.created_at,
    updated_at: row.updated_at,
    entry_count: Number(row.entry_count || 0)
  };
}

function buildTree(folders, rootId) {
  const nodes = new Map(folders.map((folder) => [folder.id, { ...folder, children: [] }]));
  const roots = [];
  for (const node of nodes.values()) {
    const parent = node.parent_id === null ? undefined : nodes.get(node.parent_id);
    if (parent) parent.children.push(node);
    else if (rootId === undefined || node.id === rootId) roots.push(node);
  }
  return rootId === undefined ? roots : roots[0] || null;
}

module.exports = {
  MAX_FOLDER_NAME_LENGTH,
  assignEntryToFolder,
  createFolder,
  deleteFolder,
  descendantFolderIds,
  getFolder,
  getFolderForEntry,
  getFolderTree,
  listFolders,
  moveFolder,
  normalizeFolderName,
  renameFolder,
  unassignEntryFromFolder,
  updateFolder
};
