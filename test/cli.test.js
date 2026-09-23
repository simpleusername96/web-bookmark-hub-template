"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const CLI_PATH = path.resolve(__dirname, "..", "registry-cli.js");
const { formatHuman, main } = require("../registry-cli.js");
const { openRegistry } = require("../registry/database.js");
const { addEntry, archiveEntry, getEntry } = require("../registry/entries.js");
const TINY_PNG = Buffer.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82,
  0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137
]);

test("explicit cleanup applies its limit once and invalid limits remove nothing", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wbh-cli-cleanup-"));
  const dbPath = path.join(directory, "registry.sqlite3");
  let registry = openRegistry({ dbPath });
  try {
    const assetDirectory = path.join(registry.dataDir, "assets");
    fs.mkdirSync(assetDirectory, { recursive: true });
    for (const [index, name] of ["one.bin", "two.bin", "three.bin"].entries()) {
      fs.writeFileSync(path.join(assetDirectory, name), String(index));
      registry.db.prepare(`
        INSERT INTO file_cleanup_queue (storage_path, reason, enqueued_at, attempts)
        VALUES (?, 'test_cleanup', ?, 0)
      `).run(`assets/${name}`, `2026-09-08T00:00:0${index}.000Z`);
    }
  } finally {
    registry.close();
  }

  try {
    assert.deepEqual(runJson(["db", "reconcile-cleanup", "--limit", "1"], { dbPath }).data, {
      attempted: 1, removed: 1, missing: 0, failed: 0, pending: 2
    });
    assert.equal(fs.existsSync(path.join(`${dbPath}.data`, "assets", "one.bin")), false);
    const invalid = runJson(["db", "reconcile-cleanup", "--limit", "0"], { dbPath, expectedStatus: 1 });
    assert.equal(invalid.error.code, "VALIDATION_ERROR");
    assert.equal(fs.existsSync(path.join(`${dbPath}.data`, "assets", "two.bin")), true);
    assert.equal(fs.existsSync(path.join(`${dbPath}.data`, "assets", "three.bin")), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("CLI JSON output follows parsed Boolean flags and preserves parse-error output", async () => {
  for (const [argv, json] of [
    [["help", "--json=false"], false],
    [["help", "--json", "--json=false"], false],
    [["help", "--json=false", "-j"], true],
    [["help", "--", "--json"], false]
  ]) {
    let output = "";
    const exitCode = await main(argv, { stdout: { write: (text) => { output += text; } } });
    assert.equal(exitCode, 0);
    assert.equal(output.startsWith("{"), json);
    if (json) assert.equal(JSON.parse(output).ok, true);
    else assert.match(output, /registry-cli\.js/);
  }
  let failure = "";
  assert.equal(await main(["help", "--json", "--db"], {
    stdout: { write: (text) => { failure += text; } }
  }), 1);
  assert.equal(JSON.parse(failure).error.code, "CLI_OPTION_VALUE_REQUIRED");
});

test("CLI add returns archived canonical reuse without changing authored fields", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wbh-cli-archived-"));
  const dbPath = path.join(directory, "registry.sqlite3");
  let registry = openRegistry({ dbPath });
  try {
    const entry = addEntry(registry, { url: "https://example.test/archived", title: "Original" }).entry;
    archiveEntry(registry, entry.id);
    const before = getEntry(registry, entry.id, { includeArchived: true });
    registry.close();
    registry = null;
    let output = "";
    const exitCode = await main(["add", entry.url_canonical, "--db", dbPath, "--json",
      "--title", "Replacement", "--tag", "new-tag", "--comment", "New comment"], {
      stdout: { write: (text) => { output += text; } }
    });
    assert.equal(exitCode, 0, output);
    const result = JSON.parse(output).data;
    assert.equal(result.outcome_code, "already_saved");
    assert.deepEqual(result.entry, before);
    registry = openRegistry({ dbPath });
    assert.deepEqual(getEntry(registry, entry.id, { includeArchived: true }), before);
    assert.equal(registry.db.prepare("SELECT COUNT(*) AS count FROM entry_comments").get().count, 0);
  } finally {
    registry?.close();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("human add output distinguishes canonical reuse without legacy duplicate fields", () => {
  const entry = { id: 4, kind: "page", provider: "generic-web" };
  assert.equal(formatHuman("add", { entry, outcome_code: "created" }), "Added Entry 4 · page · generic-web");
  assert.equal(formatHuman("add", { entry, outcome_code: "already_saved" }), "Already saved as Entry 4 · page · generic-web");
});

test("registry CLI routes every MVP operation with structured JSON", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wbh-cli-"));
  const dbPath = path.join(directory, "registry.sqlite3");
  const imagePath = path.join(directory, "preview.png");
  fs.writeFileSync(imagePath, TINY_PNG);

  try {
    const initialized = runJson(["--json", "init"], { dbPath });
    assert.equal(initialized.data.schema_version, 18);
    assert.deepEqual(runJson(["db", "reconcile-cleanup", "--limit", "10"], { dbPath }).data, {
      attempted: 0, removed: 0, missing: 0, failed: 0, pending: 0
    });
    const backupPath = path.join(directory, "backup", "registry-before.sqlite3");
    const backup = runJson(["db", "backup", backupPath], { dbPath }).data;
    assert.equal(backup.source_schema_version, 18);
    assert.equal(backup.backup_path, backupPath);
    assert.ok(backup.byte_size > 0);
    assert.equal(fs.existsSync(backupPath), true);

    const artFolder = runJson(["folders", "create", "--name", "Art"], { dbPath }).data;
    let artistFolder = runJson([
      "folders", "create", "--name", "Artists", "--parent-id", String(artFolder.id)
    ], { dbPath }).data;
    const inboxFolder = runJson(["folders", "create", "--name", "Inbox"], { dbPath }).data;
    assert.equal(runJson(["folders", "get", String(artistFolder.id)], { dbPath }).data.parent_id, artFolder.id);
    assert.deepEqual(
      runJson(["folders", "list", "--parent-id", String(artFolder.id)], { dbPath }).data.map((folder) => folder.id),
      [artistFolder.id]
    );
    assert.equal(runJson(["folders", "list", "--root"], { dbPath }).data.length, 2);
    assert.equal(runJson(["folders", "tree"], { dbPath }).data.find((folder) => folder.id === artFolder.id).children.length, 1);
    artistFolder = runJson([
      "folders", "move", String(artistFolder.id), "--parent-id", String(inboxFolder.id)
    ], { dbPath }).data;
    assert.equal(artistFolder.parent_id, inboxFolder.id);
    artistFolder = runJson(["folders", "move", String(artistFolder.id), "--root"], { dbPath }).data;
    assert.equal(artistFolder.parent_id, null);
    artistFolder = runJson([
      "folders", "move", String(artistFolder.id), "--parent-id", String(artFolder.id)
    ], { dbPath }).data;
    artistFolder = runJson([
      "folders", "rename", String(artistFolder.id), "--name", "Favorite Artists"
    ], { dbPath }).data;
    assert.equal(artistFolder.name, "Favorite Artists");
    const disposable = runJson(["folders", "create", "--name", "Temporary"], { dbPath }).data;
    const renamedDisposable = runJson([
      "folders", "rename", String(disposable.id), "--name", "Delete Me"
    ], { dbPath }).data;
    assert.equal(runJson(["folders", "delete", String(renamedDisposable.id)], { dbPath }).data.deleted, true);

    const created = runJson([
      "add", "https://example.test/one?utm_source=synthetic", "--title", "One",
      "--kind", "article", "--tag", "alpha", "--tag", "Alpha", "--tag", "research",
      "--comment", "Initial synthetic comment", "--metadata-json", '{"role":"fixture"}',
      "--visibility", "normal",
      "--content-focus", "visual", "--folder-id", String(artistFolder.id)
    ], { dbPath });
    const entryId = created.data.entry.id;
    assert.deepEqual(created.data.entry.tags.map((tag) => tag.normalized_name), ["alpha", "research"]);
    assert.equal(created.data.entry.folder_id, artistFolder.id);
    assert.equal(created.data.entry.content_focus, "visual");

    const duplicate = runJson(["add", "https://example.test/one?utm_medium=synthetic"], { dbPath });
    assert.equal(duplicate.data.outcome_code, "already_saved");
    assert.equal(duplicate.data.entry.id, entryId);

    const second = runJson(["add", "https://source.example.test/two"], { dbPath });
    assert.equal(second.data.entry.visibility, "private");
    assert.equal(second.data.entry.agent_access, "blocked");

    assert.equal(runJson(["get", String(entryId)], { dbPath }).data.title, "One");
    assert.equal(runJson(["list", "--tag", "alpha", "--kind", "article", "--provider", "generic-web",
      "--source-domain", "example.test", "--visibility", "normal", "--agent-access", "allowed",
      "--saved-from", "2020-01-01", "--saved-to", "2030-01-01", "--search", "One",
      "--sort", "title_desc", "--page", "1", "--page-size", "5"],
    { dbPath }).data.total, 1);
    assert.equal(runJson(["list", "--folder-id", String(artistFolder.id), "--content-focus", "visual"], { dbPath }).data.total, 1);
    assert.equal(runJson(["list", "--folder-id", String(artFolder.id), "--include-descendants"], { dbPath }).data.total, 1);
    assert.equal(runJson(["list", "--unfiled"], { dbPath }).data.total, 1);
    assert.equal(runJson(["edit", String(entryId), "--title", "Edited", "--published-at", "2026-01-01",
      "--updated-at", "2026-01-02", "--metadata-json", '{"role":"edited"}', "--content-focus", "text"], { dbPath }).data.title, "Edited");
    assert.equal(runJson(["get", String(entryId)], { dbPath }).data.content_focus, "text");
    assert.equal(runJson([
      "folders", "assign", String(second.data.entry.id), "--folder-id", String(artFolder.id)
    ], { dbPath }).data.folder.id, artFolder.id);
    assert.equal(runJson(["folders", "unassign", String(second.data.entry.id)], { dbPath }).data.folder, null);

    runJson(["comments", "add", String(entryId), "--text", "Second synthetic comment"], { dbPath });
    const comments = runJson(["comments", "list", String(entryId)], { dbPath }).data;
    assert.equal(comments.total, 2);
    assert.equal(Array.isArray(comments.items), true);
    runJson(["tags", "add", String(entryId), "--tag", "beta"], { dbPath });
    assert.equal(runJson(["tags", "list", String(entryId)], { dbPath }).data.length, 3);
    runJson(["tags", "remove", String(entryId), "--tag", "beta"], { dbPath });
    const tagStats = runJson(["stats", "tags", "--limit", "5"], { dbPath }).data;
    assert.equal(tagStats.length, 2);
    assert.equal(tagStats.every((tag) => Number.isInteger(tag.entry_count) && !("count" in tag)), true);
    const sourceStats = runJson(["stats", "sources", "--threshold", "1", "--limit", "5"], { dbPath }).data;
    assert.equal(sourceStats.length, 2);
    assert.equal(sourceStats.every((source) => Number.isInteger(source.entry_count) && !("count" in source)), true);

    const privatePolicy = runJson(["policy", "set", String(entryId), "--visibility", "private"], { dbPath });
    assert.equal(privatePolicy.data.agent_access, "blocked");
    assert.equal(privatePolicy.data.ai_processing, "disabled");
    const policy = runJson(["policy", "set", String(entryId), "--visibility", "normal"], { dbPath });
    assert.equal(policy.data.agent_access, "allowed");
    assert.equal(policy.data.ai_processing, "enabled");

    const localImage = runJson([
      "images", "add-file", String(entryId), "--file", imagePath, "--source-kind", "user_upload"
    ], { dbPath }).data;
    assert.equal(localImage.duplicate, false);
    assert.equal(localImage.asset.is_cover, true);
    assert.equal(runJson([
      "images", "add-file", String(entryId), "--file", imagePath, "--source-kind", "user_upload"
    ], { dbPath }).data.duplicate, true);
    const remoteImage = runJson([
      "images", "add-reference", String(entryId), "--url", "https://images.example.test/remote.png",
      "--source-kind", "provider_thumbnail"
    ], { dbPath }).data.asset;
    assert.equal(runJson(["images", "get", String(remoteImage.id)], { dbPath }).data.storage_kind, "remote");
    assert.equal(runJson(["images", "list", String(entryId)], { dbPath }).data.length, 2);
    assert.equal(runJson(["images", "set-cover", String(remoteImage.id)], { dbPath }).data.is_cover, true);
    assert.equal(runJson(["get", String(entryId)], { dbPath }).data.cover_image.id, remoteImage.id);
    assert.equal(runJson(["list", "--preview", "with"], { dbPath }).data.total, 1);
    assert.equal(runJson(["list", "--preview", "without"], { dbPath }).data.total, 1);
    assert.equal(runJson(["images", "clear-cover", String(entryId)], { dbPath }).data.some((image) => image.is_cover), false);
    runJson(["images", "set-cover", String(localImage.asset.id)], { dbPath });
    assert.equal(runJson(["images", "remove", String(localImage.asset.id)], { dbPath }).data.file_removed, true);
    assert.equal(runJson(["get", String(entryId)], { dbPath }).data.cover_image, null);
    assert.equal(runJson(["images", "remove", String(remoteImage.id)], { dbPath }).data.file_removed, false);
    assert.deepEqual(runJson(["images", "list", String(entryId)], { dbPath }).data, []);

    const snapshot = runJson(["snapshots", "attach", String(entryId), "--file", imagePath], { dbPath }).data;
    assert.equal(runJson(["snapshots", "list", String(entryId)], { dbPath }).data.length, 1);
    const job = runJson(["summaries", "create-job", String(entryId), "--requested-by", "cli-test"], { dbPath }).data;
    assert.equal(job.model, "gpt-6-luna");
    assert.equal(runJson(["summaries", "list-jobs", "--entry-id", String(entryId), "--status", "queued"],
      { dbPath }).data.total, 1);
    assert.equal(runJson(["snapshots", "remove", String(snapshot.id)], { dbPath }).data.removed, true);

    const captureManifestPath = path.join(directory, "capture.json");
    fs.writeFileSync(captureManifestPath, JSON.stringify({
      bucket: "must-not-become-a-folder",
      items: [{
        postUrl: "https://capture.example.test/post",
        title: "Synthetic capture",
        assets: [{ relativePath: "preview.png", sourceUrl: "https://images.example.test/capture.png" }]
      }]
    }));
    const capture = runJson([
      "captures", "import", captureManifestPath, "--folder-id", String(artFolder.id)
    ], { dbPath }).data;
    assert.equal(capture.counts.entries_created, 1);
    assert.equal(capture.counts.local_images_added, 1);
    assert.equal(runJson(["get", String(capture.items[0].entry_id)], { dbPath }).data.folder_id, artFolder.id);
    assert.equal(runJson(["folders", "list", "--root"], { dbPath }).data.some((folder) => folder.name === "must-not-become-a-folder"), false);

    const policyFailure = runJson(["summaries", "create-job", String(second.data.entry.id)], {
      dbPath,
      expectedStatus: 1
    });
    assert.equal(policyFailure.error.code, "SUMMARY_PRIVATE_ENTRY");
    const optionFailure = runJson(["list", "--not-an-option", "x"], {
      dbPath,
      expectedStatus: 1
    });
    assert.equal(optionFailure.error.code, "CLI_UNKNOWN_OPTION");
    const urlFailure = runJson(["add", "not-a-url?token=private-value"], {
      dbPath,
      expectedStatus: 1
    });
    assert.equal(urlFailure.error.code, "INVALID_URL");
    assert.equal(JSON.stringify(urlFailure).includes("private-value"), false);
    const folderFailure = runJson(["folders", "delete", String(artFolder.id)], {
      dbPath,
      expectedStatus: 1
    });
    assert.equal(folderFailure.error.code, "FOLDER_NOT_EMPTY");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("WEB_BOOKMARK_HUB_DB selects the database when --db is absent", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wbh-cli-env-"));
  const dbPath = path.join(directory, "from-env.sqlite3");
  try {
    const result = runJson(["init"], { envDbPath: dbPath });
    assert.equal(result.data.db_path, dbPath);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  }
});

function runJson(args, options = {}) {
  const expectedStatus = options.expectedStatus ?? 0;
  const cliArgs = [CLI_PATH, ...args];
  if (options.dbPath) {
    cliArgs.push("--db", options.dbPath);
  }
  if (!args.includes("--json")) {
    cliArgs.push("--json");
  }
  const env = {
    ...process.env,
    WEB_BOOKMARK_HUB_DB: options.envDbPath || ""
  };
  const result = spawnSync(process.execPath, cliArgs, {
    cwd: path.resolve(__dirname, ".."),
    encoding: "utf8",
    env
  });
  assert.equal(result.status, expectedStatus, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, expectedStatus === 0);
  assert.equal(result.stdout.includes("at "), false, "structured output must not contain a stack trace");
  return payload;
}
