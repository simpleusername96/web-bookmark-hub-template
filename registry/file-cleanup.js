"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { RegistryError } = require("./errors.js");
const { isPathWithin, resolvePathThroughExistingAncestors } = require("./data-paths.js");
const { nowIso } = require("./values.js");

const DEFAULT_RECONCILE_LIMIT = 100;

function enqueueFileCleanup(registry, storagePath, reason, { clock = Date } = {}) {
  if (!registry.db.isTransaction) {
    throw new RegistryError("FILE_CLEANUP_TRANSACTION_REQUIRED", "File cleanup must be queued inside a database transaction.");
  }
  const normalizedPath = normalizeStoragePath(registry, storagePath);
  const normalizedReason = normalizeCode(reason, "reason");
  registry.db.prepare(`
    INSERT INTO file_cleanup_queue (storage_path, reason, enqueued_at, attempts, failure_code)
    VALUES (?, ?, ?, 0, NULL)
    ON CONFLICT(storage_path) DO NOTHING
  `).run(normalizedPath, normalizedReason, nowIso(clock));
  return normalizedPath;
}

function reconcileFileCleanup(registry, options = {}) {
  const limit = normalizeLimit(options.limit);
  const requestedPaths = options.storagePaths
    ? [...new Set(options.storagePaths.map((value) => normalizeStoragePath(registry, value)))]
    : null;
  const where = requestedPaths?.length
    ? `WHERE storage_path IN (${requestedPaths.map(() => "?").join(", ")})`
    : "";
  const rows = registry.db.prepare(`
    SELECT storage_path FROM file_cleanup_queue
    ${where}
    ORDER BY enqueued_at ASC, storage_path ASC
    LIMIT ?
  `).all(...(requestedPaths || []), limit);
  const report = { attempted: rows.length, removed: 0, missing: 0, failed: 0, pending: 0 };
  for (const row of rows) {
    try {
      const filePath = resolveStoragePath(registry, row.storage_path);
      try {
        assertCleanupParent(registry, filePath);
        fs.unlinkSync(filePath);
        report.removed += 1;
        if (typeof options.afterUnlink === "function") options.afterUnlink(row.storage_path);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        report.missing += 1;
      }
      registry.db.prepare("DELETE FROM file_cleanup_queue WHERE storage_path = ?").run(row.storage_path);
      removeEmptyParent(registry, filePath);
    } catch (error) {
      report.failed += 1;
      registry.db.prepare(`
        UPDATE file_cleanup_queue
        SET attempts = attempts + 1, failure_code = ?
        WHERE storage_path = ?
      `).run(cleanupFailureCode(error), row.storage_path);
    }
  }
  report.pending = Number(registry.db.prepare("SELECT COUNT(*) AS count FROM file_cleanup_queue").get().count);
  return report;
}

function normalizeStoragePath(registry, value) {
  const raw = String(value || "").replace(/\\/g, "/");
  if (!raw || path.posix.isAbsolute(raw) || raw.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new RegistryError("VISUAL_ASSET_PATH_INVALID", "Visual asset storage path is invalid.");
  }
  resolveStoragePath(registry, raw);
  return raw;
}

function resolveStoragePath(registry, storagePath) {
  const root = path.resolve(registry.dataDir);
  const candidate = path.resolve(root, ...String(storagePath).split("/"));
  if (candidate === root || !isPathWithin(root, candidate)) {
    throw new RegistryError("VISUAL_ASSET_PATH_INVALID", "Visual asset storage path is invalid.");
  }
  return candidate;
}

function removeEmptyParent(registry, filePath) {
  const root = path.resolve(registry.dataDir);
  const directory = path.dirname(filePath);
  if (directory !== root && isPathWithin(root, directory)) {
    try {
      assertCleanupParent(registry, filePath);
      fs.rmdirSync(directory);
    } catch { /* Non-empty or unsafe directories remain. */ }
  }
}

function assertCleanupParent(registry, filePath) {
  const lexicalRoot = path.resolve(registry.dataDir);
  for (let parent = path.dirname(filePath); ; parent = path.dirname(parent)) {
    try {
      if (fs.lstatSync(parent).isSymbolicLink() && !fs.existsSync(parent)) {
        throw new RegistryError("VISUAL_ASSET_PATH_INVALID", "Visual asset cleanup crosses an unresolved directory link.");
      }
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
    }
    if (parent === lexicalRoot || parent === path.dirname(parent)) break;
  }
  const root = resolvePathThroughExistingAncestors(registry.dataDir);
  const parent = resolvePathThroughExistingAncestors(path.dirname(filePath));
  if (!isPathWithin(root, parent)) {
    throw new RegistryError("VISUAL_ASSET_PATH_INVALID", "Visual asset cleanup leaves the data directory.");
  }
}

function cleanupFailureCode(error) {
  const code = String(error?.code || "FILE_REMOVE_FAILED").toUpperCase();
  return /^[A-Z0-9_]{1,64}$/.test(code) ? code : "FILE_REMOVE_FAILED";
}

function normalizeCode(value, field) {
  const code = String(value || "").trim();
  if (!/^[a-z0-9_]{1,64}$/.test(code)) {
    throw new RegistryError("VALIDATION_ERROR", `${field} is invalid.`, { field });
  }
  return code;
}

function normalizeLimit(value) {
  const limit = value === undefined ? DEFAULT_RECONCILE_LIMIT : Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new RegistryError("VALIDATION_ERROR", "cleanup limit must be between 1 and 1000.", { field: "limit" });
  }
  return limit;
}

module.exports = {
  DEFAULT_RECONCILE_LIMIT,
  enqueueFileCleanup,
  normalizeStoragePath,
  reconcileFileCleanup,
  resolveStoragePath
};
