"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const { assertPathOutsideRepository, resolveDatabasePath } = require("./database.js");
const { RegistryError } = require("./errors.js");

function backupDatabase(targetPath, { dbPath, env = process.env } = {}) {
  const source = resolveDatabasePath(dbPath, { env });
  const target = path.resolve(String(targetPath));
  assertPathOutsideRepository(target);
  if (source === ":memory:" || !fs.existsSync(source)) {
    throw new RegistryError("DATABASE_NOT_FOUND", "Registry database could not be read.");
  }
  if (path.resolve(source) === target) throw new RegistryError("DATABASE_BACKUP_TARGET_INVALID", "Backup target must differ from the Registry database.");
  if (fs.existsSync(target)) throw new RegistryError("DATABASE_BACKUP_EXISTS", "Backup target already exists.");
  fs.mkdirSync(path.dirname(target), { recursive: true });

  const db = new DatabaseSync(source);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.prepare("VACUUM INTO ?").run(target);
    const userVersion = Number(db.prepare("PRAGMA user_version").get().user_version);
    return {
      backup_path: target,
      byte_size: fs.statSync(target).size,
      source_schema_version: userVersion
    };
  } finally {
    db.close();
  }
}

module.exports = { backupDatabase };
