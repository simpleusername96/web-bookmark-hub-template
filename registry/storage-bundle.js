"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const { backupDatabase } = require("./database-backup.js");
const {
  assertPathOutsideRepository,
  getApplicationDataDir,
  resolveDatabasePath
} = require("./database.js");
const { RegistryError } = require("./errors.js");

const BUNDLE_FORMAT = "web-bookmark-hub/backup-bundle/v1";
const MANIFEST_NAME = "manifest.json";

function backupStorageBundle(targetDirectory, { dbPath, env = process.env, afterFileCopied } = {}) {
  const sourceDb = resolveDatabasePath(dbPath, { env });
  assertDatabaseOffline(sourceDb);
  const target = resolveNewExternalDirectory(targetDirectory, "BACKUP_BUNDLE_EXISTS");
  const staging = stagingPath(target);
  fs.mkdirSync(staging, { recursive: true });
  try {
    const backupPath = path.join(staging, "registry.sqlite3");
    const database = backupDatabase(backupPath, { dbPath: sourceDb, env });
    if (typeof afterFileCopied === "function") afterFileCopied("registry.sqlite3");
    const sourceData = getApplicationDataDir(sourceDb);
    const targetData = path.join(staging, "registry.sqlite3.data");
    if (fs.existsSync(sourceData)) copyTree(sourceData, targetData, { afterFileCopied });
    else fs.mkdirSync(targetData, { recursive: true });

    const files = inventoryFiles(staging);
    const manifest = {
      format: BUNDLE_FORMAT,
      schema_version: database.source_schema_version,
      files
    };
    fs.writeFileSync(path.join(staging, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx"
    });
    verifyStorageBundle(staging, { allowStaging: true });
    fs.renameSync(staging, target);
    return { bundle_path: target, schema_version: manifest.schema_version, files: files.length };
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true, maxRetries: 3 });
    throw error;
  }
}

function verifyStorageBundle(bundleDirectory, { allowStaging = false } = {}) {
  const root = path.resolve(String(bundleDirectory));
  if (!allowStaging) assertPathOutsideRepository(root);
  const manifestPath = path.join(root, MANIFEST_NAME);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    throw new RegistryError("BACKUP_BUNDLE_MANIFEST_INVALID", "Backup bundle manifest is missing or invalid.");
  }
  validateManifest(manifest);
  const actualPaths = inventoryFiles(root).map((item) => item.path);
  const expectedPaths = manifest.files.map((item) => item.path);
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw new RegistryError("BACKUP_BUNDLE_FILE_SET_MISMATCH", "Backup bundle files do not match the manifest.");
  }
  for (const expected of manifest.files) {
    const filePath = safeBundlePath(root, expected.path);
    const stat = fs.statSync(filePath);
    if (stat.size !== expected.size || sha256File(filePath) !== expected.sha256) {
      throw new RegistryError("BACKUP_BUNDLE_FILE_CHANGED", "Backup bundle file verification failed.");
    }
  }
  const databasePath = path.join(root, "registry.sqlite3");
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const integrity = database.prepare("PRAGMA quick_check").get().quick_check;
    const schemaVersion = Number(database.prepare("PRAGMA user_version").get().user_version);
    if (integrity !== "ok" || schemaVersion !== manifest.schema_version) {
      throw new RegistryError("BACKUP_BUNDLE_DATABASE_INVALID", "Backup bundle database verification failed.");
    }
  } finally {
    database.close();
  }
  return { valid: true, schema_version: manifest.schema_version, files: manifest.files.length };
}

function restoreStorageBundle(bundleDirectory, targetDirectory, options = {}) {
  const source = path.resolve(String(bundleDirectory));
  assertPathOutsideRepository(source);
  const verification = verifyStorageBundle(source);
  const target = resolveNewExternalDirectory(targetDirectory, "RESTORE_TARGET_EXISTS");
  const staging = stagingPath(target);
  try {
    copyTree(source, staging, { afterFileCopied: options.afterFileCopied });
    verifyStorageBundle(staging, { allowStaging: true });
    fs.renameSync(staging, target);
    return {
      restore_path: target,
      db_path: path.join(target, "registry.sqlite3"),
      data_dir: path.join(target, "registry.sqlite3.data"),
      schema_version: verification.schema_version,
      files: verification.files
    };
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true, maxRetries: 3 });
    throw error;
  }
}

function assertDatabaseOffline(databasePath) {
  if (databasePath === ":memory:" || !fs.existsSync(databasePath)) {
    throw new RegistryError("DATABASE_NOT_FOUND", "Registry database could not be read.");
  }
  if (fs.existsSync(`${databasePath}-wal`) || fs.existsSync(`${databasePath}-shm`)) {
    throw new RegistryError("REGISTRY_MUST_BE_STOPPED", "Stop the process that owns the Registry before creating a backup bundle.");
  }
}

function resolveNewExternalDirectory(value, code) {
  const resolved = path.resolve(String(value));
  assertPathOutsideRepository(resolved);
  if (fs.existsSync(resolved)) throw new RegistryError(code, "Target directory already exists.");
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  return resolved;
}

function stagingPath(target) {
  return path.join(path.dirname(target), `.${path.basename(target)}.tmp-${randomUUID()}`);
}

function copyTree(source, target, { afterFileCopied } = {}) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) {
    throw new RegistryError("BACKUP_BUNDLE_SYMLINK_REJECTED", "Backup bundle trees cannot contain symbolic links.");
  }
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true });
    for (const name of fs.readdirSync(source).sort()) {
      copyTree(path.join(source, name), path.join(target, name), { afterFileCopied });
    }
    return;
  }
  if (!stat.isFile()) {
    throw new RegistryError("BACKUP_BUNDLE_FILE_INVALID", "Backup bundle trees may contain only files and directories.");
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  if (typeof afterFileCopied === "function") afterFileCopied(toPortablePath(target));
}

function inventoryFiles(root) {
  const result = [];
  function visit(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      if (directory === root && name === MANIFEST_NAME) continue;
      const absolute = path.join(directory, name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        throw new RegistryError("BACKUP_BUNDLE_SYMLINK_REJECTED", "Backup bundle trees cannot contain symbolic links.");
      }
      if (stat.isDirectory()) visit(absolute);
      else if (stat.isFile()) {
        result.push({
          path: toPortablePath(path.relative(root, absolute)),
          size: stat.size,
          sha256: sha256File(absolute)
        });
      } else {
        throw new RegistryError("BACKUP_BUNDLE_FILE_INVALID", "Backup bundle trees may contain only files and directories.");
      }
    }
  }
  visit(root);
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

function validateManifest(manifest) {
  if (manifest?.format !== BUNDLE_FORMAT || !Number.isSafeInteger(manifest.schema_version) ||
      !Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new RegistryError("BACKUP_BUNDLE_MANIFEST_INVALID", "Backup bundle manifest is missing or invalid.");
  }
  const paths = new Set();
  for (const file of manifest.files) {
    if (!file || typeof file.path !== "string" || !Number.isSafeInteger(file.size) || file.size < 0 ||
        !/^[0-9a-f]{64}$/.test(file.sha256) || paths.has(file.path)) {
      throw new RegistryError("BACKUP_BUNDLE_MANIFEST_INVALID", "Backup bundle manifest is missing or invalid.");
    }
    safeBundlePath("C:\\bundle-root", file.path);
    paths.add(file.path);
  }
  if (!paths.has("registry.sqlite3")) {
    throw new RegistryError("BACKUP_BUNDLE_MANIFEST_INVALID", "Backup bundle manifest is missing or invalid.");
  }
}

function safeBundlePath(root, relativePath) {
  if (relativePath.includes("\\") || path.posix.isAbsolute(relativePath) || relativePath.split("/").includes("..")) {
    throw new RegistryError("BACKUP_BUNDLE_MANIFEST_INVALID", "Backup bundle manifest is missing or invalid.");
  }
  const candidate = path.resolve(root, ...relativePath.split("/"));
  const relative = path.relative(path.resolve(root), candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    if (relativePath === "registry.sqlite3") return candidate;
    throw new RegistryError("BACKUP_BUNDLE_MANIFEST_INVALID", "Backup bundle manifest is missing or invalid.");
  }
  return candidate;
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function toPortablePath(value) {
  return value.split(path.sep).join("/");
}

module.exports = {
  BUNDLE_FORMAT,
  MANIFEST_NAME,
  assertDatabaseOffline,
  backupStorageBundle,
  restoreStorageBundle,
  verifyStorageBundle
};
