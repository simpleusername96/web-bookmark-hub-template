"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { executeCli, helpText } = require("../registry/cli.js");
const { openRegistry } = require("../registry/database.js");
const { addEntry, getEntry } = require("../registry/entries.js");
const {
  backupStorageBundle,
  restoreStorageBundle,
  verifyStorageBundle
} = require("../registry/storage-bundle.js");
const { addLocalImage, auditLocalVisualAssets, listVisualAssets } = require("../registry/visual-assets.js");

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

test("complete backup bundle verifies and restores a Registry with local previews", async () => {
  const subject = await createSubject();
  let restored;
  try {
    assert.throws(
      () => backupStorageBundle(subject.bundlePath, { dbPath: subject.dbPath }),
      { code: "REGISTRY_MUST_BE_STOPPED" }
    );
    subject.registry.close();
    subject.registry = null;

    const backup = backupStorageBundle(subject.bundlePath, { dbPath: subject.dbPath });
    assert.equal(backup.files, 2);
    assert.deepEqual(verifyStorageBundle(subject.bundlePath), {
      valid: true,
      schema_version: backup.schema_version,
      files: 2
    });
    const restore = restoreStorageBundle(subject.bundlePath, subject.restorePath);
    restored = openRegistry({ dbPath: restore.db_path });
    assert.equal(getEntry(restored, subject.entryId).title, "Bundle entry");
    assert.equal(listVisualAssets(restored, subject.entryId).length, 1);
    assert.deepEqual(await auditLocalVisualAssets(restored), {
      total: 1,
      verified: 1,
      missing: 0,
      hash_mismatch: 0,
      size_mismatch: 0,
      media_type_mismatch: 0
    });
  } finally {
    if (subject.registry) subject.registry.close();
    if (restored) restored.close();
    fs.rmSync(subject.directory, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("bundle verification rejects missing, extra, and changed files", async () => {
  const subject = await createSubject();
  try {
    subject.registry.close();
    subject.registry = null;
    backupStorageBundle(subject.bundlePath, { dbPath: subject.dbPath });
    const cases = ["missing", "extra", "changed"];
    for (const name of cases) {
      const copy = path.join(subject.directory, name);
      fs.cpSync(subject.bundlePath, copy, { recursive: true, errorOnExist: true });
      const preview = firstPreview(copy);
      if (name === "missing") fs.unlinkSync(preview);
      if (name === "extra") fs.writeFileSync(path.join(copy, "extra.txt"), "extra");
      if (name === "changed") fs.appendFileSync(preview, "changed");
      assert.throws(
        () => verifyStorageBundle(copy),
        { code: name === "changed" ? "BACKUP_BUNDLE_FILE_CHANGED" : "BACKUP_BUNDLE_FILE_SET_MISMATCH" }
      );
    }
  } finally {
    if (subject.registry) subject.registry.close();
    fs.rmSync(subject.directory, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("interrupted bundle creation and restore leave no final target", async () => {
  const subject = await createSubject();
  try {
    subject.registry.close();
    subject.registry = null;
    assert.throws(
      () => backupStorageBundle(subject.bundlePath, {
        dbPath: subject.dbPath,
        afterFileCopied: () => { throw new Error("synthetic interruption"); }
      }),
      /synthetic interruption/
    );
    assert.equal(fs.existsSync(subject.bundlePath), false);
    assert.equal(fs.readdirSync(subject.directory).some((name) => name.startsWith(".bundle.tmp-")), false);

    backupStorageBundle(subject.bundlePath, { dbPath: subject.dbPath });
    assert.throws(
      () => restoreStorageBundle(subject.bundlePath, subject.restorePath, {
        afterFileCopied: () => { throw new Error("synthetic restore interruption"); }
      }),
      /synthetic restore interruption/
    );
    assert.equal(fs.existsSync(subject.restorePath), false);
    assert.equal(fs.readdirSync(subject.directory).some((name) => name.startsWith(".restored.tmp-")), false);
  } finally {
    if (subject.registry) subject.registry.close();
    fs.rmSync(subject.directory, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("backup help distinguishes a SQLite-only copy from a complete bundle", () => {
  const help = helpText();
  assert.match(help, /db backup creates a SQLite-only copy/);
  assert.match(help, /db backup-bundle for a complete backup/);
});

test("database CLI routes complete bundle backup, verification, and restore", async () => {
  const subject = await createSubject();
  try {
    subject.registry.close();
    subject.registry = null;
    const backup = await executeCli(["db", "backup-bundle", subject.bundlePath, "--db", subject.dbPath]);
    assert.equal(backup.command, "db backup-bundle");
    const verified = await executeCli(["db", "verify-backup-bundle", subject.bundlePath]);
    assert.equal(verified.data.valid, true);
    const restored = await executeCli(["db", "restore-bundle", subject.bundlePath, "--to", subject.restorePath]);
    assert.equal(restored.data.db_path, path.join(subject.restorePath, "registry.sqlite3"));
  } finally {
    if (subject.registry) subject.registry.close();
    fs.rmSync(subject.directory, { recursive: true, force: true, maxRetries: 3 });
  }
});

async function createSubject() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wbh-storage-bundle-"));
  const dbPath = path.join(directory, "source", "registry.sqlite3");
  const registry = openRegistry({ dbPath });
  const entry = addEntry(registry, {
    url: "https://synthetic.example.test/bundle",
    title: "Bundle entry"
  }).entry;
  const imagePath = path.join(directory, "preview.png");
  fs.writeFileSync(imagePath, PNG);
  await addLocalImage(registry, entry.id, imagePath);
  return {
    directory,
    dbPath,
    registry,
    entryId: entry.id,
    bundlePath: path.join(directory, "bundle"),
    restorePath: path.join(directory, "restored")
  };
}

function firstPreview(bundlePath) {
  const manifest = JSON.parse(fs.readFileSync(path.join(bundlePath, "manifest.json"), "utf8"));
  const item = manifest.files.find((file) => file.path.startsWith("registry.sqlite3.data/"));
  return path.join(bundlePath, ...item.path.split("/"));
}
