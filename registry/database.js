"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const {
  assertPathOutsideRepository,
  assertRegistryDataPath,
  getApplicationDataDir,
  isPathWithin,
  resolveDatabasePath,
  resolvePathThroughExistingAncestors,
} = require("./data-paths");
const { SCHEMA_VERSION, initializeSchema, validateSchema } = require("./schema");
const { reconcileFileCleanup } = require("./file-cleanup.js");

function openRegistry(options = {}) {
  const dbPath = resolveDatabasePath(options.dbPath, options);
  const dataDir = getApplicationDataDir(dbPath);
  if (dbPath !== ":memory:") {
    assertRegistryDataPath(dbPath, options);
    assertRegistryDataPath(dataDir, options);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA busy_timeout = 5000");
    if (dbPath !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
    initializeSchema(db, withTransaction);
  } catch (error) {
    db.close();
    throw error;
  }

  const registry = { db, dbPath, dataDir, close: () => db.close() };
  if (dbPath !== ":memory:" && options.reconcileCleanup !== false) reconcileFileCleanup(registry);
  return registry;
}

function withTransaction(db, fn) {
  if (db.isTransaction) {
    const savepoint = `wbh_nested_${nextSavepointId++}`;
    db.exec(`SAVEPOINT ${savepoint}`);
    try {
      const result = fn();
      db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      try {
        db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      } catch { /* Preserve the original failure. */ }
      throw error;
    }
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* Transaction may already be closed. */ }
    throw error;
  }
}

let nextSavepointId = 1;

module.exports = {
  SCHEMA_VERSION,
  assertPathOutsideRepository,
  assertRegistryDataPath,
  getApplicationDataDir,
  openRegistry,
  resolveDatabasePath,
  isPathWithin,
  resolvePathThroughExistingAncestors,
  validateSchema,
  withTransaction,
};
