"use strict";

const { RegistryError } = require("./errors.js");
const { getEntry } = require("./entries.js");
const { enqueueFileCleanup, normalizeStoragePath, reconcileFileCleanup } = require("./file-cleanup.js");

async function deleteEntry(registry, entryIdValue, options = {}) {
  return deleteEntries(registry, [entryIdValue], options);
}

async function deleteEntries(registry, entryIdValues, options = {}) {
  const entryIds = normalizeEntryIds(entryIdValues, { max: options.maxIds });
  if (registry.db.isTransaction) {
    throw new RegistryError("ENTRY_DELETE_BUSY", "Entry deletion requires an idle registry transaction.");
  }
  const placeholders = entryIds.map(() => "?").join(", ");
  let localAssets;
  try {
    registry.db.exec("BEGIN IMMEDIATE");
    if (typeof options.precondition === "function") options.precondition();
    entryIds.forEach((id) => getEntry(registry, id, { includeArchived: true }));
    localAssets = registry.db.prepare(`
      SELECT id, storage_path
      FROM entry_visual_assets
      WHERE entry_id IN (${placeholders}) AND storage_kind = 'local'
      ORDER BY id
    `).all(...entryIds).map((row) => ({
      id: Number(row.id),
      storagePath: normalizeStoragePath(registry, row.storage_path)
    }));
    for (const asset of localAssets) {
      enqueueFileCleanup(registry, asset.storagePath, "entry_delete", { clock: options.clock || Date });
    }
    registry.db.prepare(`
      UPDATE capture_request_items
      SET entry_id = NULL, outcome_code = 'deleted', details_json = '{}'
      WHERE entry_id IN (${placeholders})
    `).run(...entryIds);
    const deleted = registry.db.prepare(`DELETE FROM entries WHERE id IN (${placeholders})`).run(...entryIds);
    if (Number(deleted.changes) !== entryIds.length) {
      throw new RegistryError("ENTRY_NOT_FOUND", "One or more Entries were not found.");
    }
    if (typeof options.beforeCommit === "function") options.beforeCommit();
    registry.db.exec("COMMIT");
  } catch (error) {
    if (registry.db.isTransaction) {
      try { registry.db.exec("ROLLBACK"); } catch { /* recovery continues */ }
    }
    if (error instanceof RegistryError) throw error;
    throw new RegistryError("ENTRY_DELETE_FAILED", "Entries could not be deleted safely.");
  }
  if (typeof options.afterCommit === "function") options.afterCommit();
  const cleanup = localAssets.length
    ? reconcileFileCleanup(registry, {
        storagePaths: localAssets.map((asset) => asset.storagePath),
        limit: localAssets.length,
        afterUnlink: options.afterUnlink
      })
    : { removed: 0, missing: 0, failed: 0 };
  return {
    deleted: entryIds.length,
    entry_ids: entryIds,
    files_removed: cleanup.removed,
    files_missing: cleanup.missing,
    files_pending: cleanup.failed
  };
}

function normalizeEntryIds(value, options = {}) {
  const requestedMax = Number(options.max);
  const max = Number.isSafeInteger(requestedMax) && requestedMax > 0 ? requestedMax : 100;
  if (!Array.isArray(value) || value.length < 1 || value.length > max) {
    throw new RegistryError("VALIDATION_ERROR", `entry_ids must contain 1 to ${max} IDs.`, { field: "entry_ids" });
  }
  const ids = value.map((item) => Number(item));
  if (ids.some((id) => !Number.isSafeInteger(id) || id < 1) || new Set(ids).size !== ids.length) {
    throw new RegistryError("VALIDATION_ERROR", "entry_ids must contain unique positive integers.", { field: "entry_ids" });
  }
  return ids;
}

module.exports = { deleteEntry, deleteEntries, normalizeEntryIds };
