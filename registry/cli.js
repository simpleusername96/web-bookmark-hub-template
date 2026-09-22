const { SCHEMA_VERSION, openRegistry, withTransaction } = require("./database.js");
const { addEntry, editEntry, getEntry, listEntries, setEntryPolicy } = require("./entries.js");
const { addComment, listComments } = require("./comments.js");
const { addTags, listTags, removeTags } = require("./tags.js");
const { topSourceDomains, topTags } = require("./insights.js");
const { attachSnapshot, listSnapshots, removeSnapshot } = require("./snapshots.js");
const { createSummaryJob, listSummaryJobs } = require("./summaries.js");
const {
  assignEntryToFolder,
  createFolder,
  deleteFolder,
  getFolder,
  getFolderTree,
  listFolders,
  moveFolder,
  renameFolder,
  unassignEntryFromFolder
} = require("./folders.js");
const {
  addLocalImage,
  addRemoteImageReference,
  auditLocalVisualAssets,
  clearCover,
  getVisualAsset,
  listVisualAssets,
  removeVisualAsset,
  setCover
} = require("./visual-assets.js");
const { importCaptureManifest } = require("./capture-import.js");
const { importCaptureTree } = require("./capture-tree-import.js");
const { backupDatabase } = require("./database-backup.js");
const { backupStorageBundle, restoreStorageBundle, verifyStorageBundle } = require("./storage-bundle.js");
const { reconcileFileCleanup } = require("./file-cleanup.js");
const {
  exportOwnerMetadata,
  importOwnerMetadata,
  validateOwnerMetadataFile
} = require("./metadata-transfer.js");
const { RegistryError } = require("./errors.js");
const {
  assertAllowedOptions,
  optionValue,
  optionValues,
  parseArguments,
  requireOption,
  requirePositionals
} = require("./cli-args.js");

async function executeCli(argv, { env = process.env } = {}) {
  const parsed = parseArguments(argv);
  const command = parsed.positionals[0] || "";
  if (!command || command === "help" || optionValue(parsed.options, "help")) {
    assertAllowedOptions(parsed.options);
    return { command: "help", data: { help: helpText() } };
  }

  if (command === "db") return handleDatabase(parsed, { env });
  if (command === "metadata" && parsed.positionals[1] === "validate") {
    assertAllowedOptions(parsed.options);
    requirePositionals(parsed.positionals, 3, "registry-cli.js metadata validate <json>");
    return outcome("metadata validate", validateOwnerMetadataFile(parsed.positionals[2]));
  }

  const registry = openRegistry({ dbPath: optionValue(parsed.options, "db"), env });
  try {
    switch (command) {
      case "enrich":
        return await require("../enrichment/cli.js").handleEnrichment(registry, parsed);
      case "init":
        return handleInit(registry, parsed);
      case "add":
        return handleAdd(registry, parsed);
      case "list":
        return handleList(registry, parsed);
      case "get":
        return handleGet(registry, parsed);
      case "edit":
        return handleEdit(registry, parsed);
      case "comments":
        return handleComments(registry, parsed);
      case "tags":
        return handleTags(registry, parsed);
      case "policy":
        return handlePolicy(registry, parsed);
      case "stats":
        return handleStats(registry, parsed);
      case "snapshots":
        return await handleSnapshots(registry, parsed);
      case "summaries":
        return handleSummaries(registry, parsed);
      case "folders":
        return handleFolders(registry, parsed);
      case "images":
        return await handleImages(registry, parsed);
      case "captures":
        return await handleCaptures(registry, parsed);
      case "metadata":
        return handleMetadata(registry, parsed);
      default:
        throw new RegistryError("CLI_UNKNOWN_COMMAND", `Unknown command: ${command}.`, {
          command
        });
    }
  } finally {
    registry.close();
  }
}

function handleMetadata(registry, parsed) {
  const subcommand = parsed.positionals[1];
  if (subcommand === "export") {
    assertAllowedOptions(parsed.options);
    requirePositionals(parsed.positionals, 3, "registry-cli.js metadata export <new-json>");
    return outcome("metadata export", exportOwnerMetadata(registry, parsed.positionals[2]));
  }
  if (subcommand === "import") {
    assertAllowedOptions(parsed.options);
    requirePositionals(parsed.positionals, 3, "registry-cli.js metadata import <json>");
    return outcome("metadata import", importOwnerMetadata(registry, parsed.positionals[2]));
  }
  throw new RegistryError("CLI_UNKNOWN_COMMAND", "metadata requires validate, export, or import.");
}

function handleInit(registry, parsed) {
  assertAllowedOptions(parsed.options);
  requirePositionals(parsed.positionals, 1, "registry-cli.js init [--db <path>] [--json]");
  return outcome("init", {
    db_path: registry.dbPath,
    data_dir: registry.dataDir,
    schema_version: SCHEMA_VERSION
  });
}

function handleAdd(registry, parsed) {
  assertAllowedOptions(parsed.options, [
    "title", "kind", "tag", "comment", "visibility",
    "published-at", "updated-at", "metadata-json", "content-focus", "folder-id"
  ]);
  requirePositionals(parsed.positionals, 2, "registry-cli.js add <url> [options]");
  const input = {
    url: parsed.positionals[1],
    title: optionValue(parsed.options, "title"),
    kind: optionValue(parsed.options, "kind"),
    visibility: optionValue(parsed.options, "visibility"),
    publishedAt: optionValue(parsed.options, "published-at"),
    updatedAt: optionValue(parsed.options, "updated-at"),
    typedMetadata: optionValue(parsed.options, "metadata-json"),
    contentFocus: optionValue(parsed.options, "content-focus"),
    folderId: optionValue(parsed.options, "folder-id")
  };
  const tags = optionValues(parsed.options, "tag");
  const commentText = optionValue(parsed.options, "comment");
  let created;
  withTransaction(registry.db, () => {
    created = addEntry(registry, input);
    if (created.outcome_code === "created" && tags.length) {
      addTags(registry, created.entry.id, tags);
    }
    if (created.outcome_code === "created" && commentText !== undefined) {
      addComment(registry, created.entry.id, commentText);
    }
  });
  return outcome("add", {
    entry: getEntry(registry, created.entry.id, { includeArchived: true }),
    outcome_code: created.outcome_code
  });
}

function handleList(registry, parsed) {
  assertAllowedOptions(parsed.options, [
    "saved-from", "saved-to", "tag", "kind", "provider", "source-domain",
    "visibility", "agent-access", "content-focus", "folder-id", "include-descendants",
    "unfiled", "preview", "search", "sort", "page", "page-size"
  ]);
  requirePositionals(parsed.positionals, 1, "registry-cli.js list [filters]");
  return outcome("list", listEntries(registry, {
    savedFrom: optionValue(parsed.options, "saved-from"),
    savedTo: optionValue(parsed.options, "saved-to"),
    tag: optionValue(parsed.options, "tag"),
    kind: optionValue(parsed.options, "kind"),
    provider: optionValue(parsed.options, "provider"),
    sourceDomain: optionValue(parsed.options, "source-domain"),
    visibility: optionValue(parsed.options, "visibility"),
    agentAccess: optionValue(parsed.options, "agent-access"),
    contentFocus: optionValue(parsed.options, "content-focus"),
    preview: optionValue(parsed.options, "preview"),
    folderId: optionValue(parsed.options, "folder-id"),
    includeDescendants: optionValue(parsed.options, "include-descendants"),
    unfiled: optionValue(parsed.options, "unfiled"),
    search: optionValue(parsed.options, "search"),
    sort: optionValue(parsed.options, "sort"),
    page: optionValue(parsed.options, "page"),
    pageSize: optionValue(parsed.options, "page-size")
  }));
}

function handleGet(registry, parsed) {
  assertAllowedOptions(parsed.options);
  requirePositionals(parsed.positionals, 2, "registry-cli.js get <entry-id>");
  return outcome("get", getEntry(registry, parsed.positionals[1]));
}

function handleEdit(registry, parsed) {
  assertAllowedOptions(parsed.options, [
    "title", "clear-title", "kind", "reset-kind", "metadata-json",
    "published-at", "clear-published-at", "updated-at", "clear-updated-at", "content-focus"
  ]);
  requirePositionals(parsed.positionals, 2, "registry-cli.js edit <entry-id> [fields]");
  const changes = {};
  setNullableChange(changes, "title", parsed.options, "title", "clear-title");
  setNullableChange(changes, "publishedAt", parsed.options, "published-at", "clear-published-at");
  setNullableChange(changes, "updatedAt", parsed.options, "updated-at", "clear-updated-at");
  if (optionValue(parsed.options, "kind") !== undefined && optionValue(parsed.options, "reset-kind")) {
    throw new RegistryError("CLI_ARGUMENT_ERROR", "--kind and --reset-kind cannot be combined.");
  }
  if (optionValue(parsed.options, "kind") !== undefined) {
    changes.kind = optionValue(parsed.options, "kind");
  } else if (optionValue(parsed.options, "reset-kind")) {
    changes.kind = null;
  }
  if (optionValue(parsed.options, "metadata-json") !== undefined) {
    changes.typedMetadata = optionValue(parsed.options, "metadata-json");
  }
  if (optionValue(parsed.options, "content-focus") !== undefined) {
    changes.contentFocus = optionValue(parsed.options, "content-focus");
  }
  return outcome("edit", editEntry(registry, parsed.positionals[1], changes));
}

function handleFolders(registry, parsed) {
  const subcommand = parsed.positionals[1] || "";
  if (subcommand === "create") {
    assertAllowedOptions(parsed.options, ["name", "parent-id"]);
    requirePositionals(parsed.positionals, 2, "registry-cli.js folders create --name <name> [--parent-id <id>]");
    return outcome("folders create", createFolder(registry, {
      name: requireOption(parsed.options, "name"),
      parentId: optionValue(parsed.options, "parent-id")
    }));
  }
  if (subcommand === "get") {
    assertAllowedOptions(parsed.options);
    requirePositionals(parsed.positionals, 3, "registry-cli.js folders get <folder-id>");
    return outcome("folders get", getFolder(registry, parsed.positionals[2]));
  }
  if (subcommand === "list") {
    assertAllowedOptions(parsed.options, ["parent-id", "root"]);
    requirePositionals(parsed.positionals, 2, "registry-cli.js folders list [--parent-id <id>|--root]");
    if (optionValue(parsed.options, "parent-id") !== undefined && optionValue(parsed.options, "root")) {
      throw new RegistryError("CLI_ARGUMENT_ERROR", "--parent-id and --root cannot be combined.");
    }
    return outcome("folders list", listFolders(registry, {
      parentId: optionValue(parsed.options, "root") ? null : optionValue(parsed.options, "parent-id")
    }));
  }
  if (subcommand === "tree") {
    assertAllowedOptions(parsed.options);
    requirePositionals(parsed.positionals, 2, "registry-cli.js folders tree");
    return outcome("folders tree", getFolderTree(registry));
  }
  if (subcommand === "rename") {
    assertAllowedOptions(parsed.options, ["name"]);
    requirePositionals(parsed.positionals, 3, "registry-cli.js folders rename <folder-id> --name <name>");
    return outcome("folders rename", renameFolder(
      registry,
      parsed.positionals[2],
      requireOption(parsed.options, "name")
    ));
  }
  if (subcommand === "move") {
    assertAllowedOptions(parsed.options, ["parent-id", "root"]);
    requirePositionals(parsed.positionals, 3, "registry-cli.js folders move <folder-id> (--parent-id <id>|--root)");
    const parentId = optionValue(parsed.options, "parent-id");
    const root = optionValue(parsed.options, "root");
    if ((parentId === undefined && !root) || (parentId !== undefined && root)) {
      throw new RegistryError("CLI_ARGUMENT_ERROR", "Provide exactly one of --parent-id or --root.");
    }
    return outcome("folders move", moveFolder(registry, parsed.positionals[2], root ? null : parentId));
  }
  if (subcommand === "delete") {
    assertAllowedOptions(parsed.options);
    requirePositionals(parsed.positionals, 3, "registry-cli.js folders delete <folder-id>");
    return outcome("folders delete", deleteFolder(registry, parsed.positionals[2]));
  }
  if (subcommand === "assign") {
    assertAllowedOptions(parsed.options, ["folder-id"]);
    requirePositionals(parsed.positionals, 3, "registry-cli.js folders assign <entry-id> --folder-id <id>");
    return outcome("folders assign", assignEntryToFolder(
      registry,
      parsed.positionals[2],
      requireOption(parsed.options, "folder-id")
    ));
  }
  if (subcommand === "unassign") {
    assertAllowedOptions(parsed.options);
    requirePositionals(parsed.positionals, 3, "registry-cli.js folders unassign <entry-id>");
    return outcome("folders unassign", unassignEntryFromFolder(registry, parsed.positionals[2]));
  }
  throw new RegistryError(
    "CLI_UNKNOWN_COMMAND",
    "folders requires create, get, list, tree, rename, move, delete, assign, or unassign."
  );
}

async function handleImages(registry, parsed) {
  const subcommand = parsed.positionals[1] || "";
  if (subcommand === "audit-local") {
    assertAllowedOptions(parsed.options);
    requirePositionals(parsed.positionals, 2, "registry-cli.js images audit-local");
    return outcome("images audit-local", await auditLocalVisualAssets(registry));
  }
  if (subcommand === "add-file") {
    assertAllowedOptions(parsed.options, ["file", "source-kind", "source-url", "captured-at", "cover"]);
    requirePositionals(parsed.positionals, 3, "registry-cli.js images add-file <entry-id> --file <image> [options]");
    return outcome("images add-file", await addLocalImage(
      registry,
      parsed.positionals[2],
      requireOption(parsed.options, "file"),
      {
        sourceKind: optionValue(parsed.options, "source-kind") || "user_upload",
        sourceUrl: optionValue(parsed.options, "source-url"),
        capturedAt: optionValue(parsed.options, "captured-at"),
        makeCover: optionValue(parsed.options, "cover")
      }
    ));
  }
  if (subcommand === "add-reference") {
    assertAllowedOptions(parsed.options, ["url", "source-kind", "captured-at", "cover"]);
    requirePositionals(parsed.positionals, 3, "registry-cli.js images add-reference <entry-id> --url <image-url> [options]");
    return outcome("images add-reference", addRemoteImageReference(
      registry,
      parsed.positionals[2],
      requireOption(parsed.options, "url"),
      {
        sourceKind: optionValue(parsed.options, "source-kind") || "provider_thumbnail",
        capturedAt: optionValue(parsed.options, "captured-at"),
        makeCover: optionValue(parsed.options, "cover")
      }
    ));
  }
  if (subcommand === "get") {
    assertAllowedOptions(parsed.options);
    requirePositionals(parsed.positionals, 3, "registry-cli.js images get <image-id>");
    return outcome("images get", getVisualAsset(registry, parsed.positionals[2]));
  }
  if (subcommand === "list") {
    assertAllowedOptions(parsed.options);
    requirePositionals(parsed.positionals, 3, "registry-cli.js images list <entry-id>");
    return outcome("images list", listVisualAssets(registry, parsed.positionals[2]));
  }
  if (subcommand === "set-cover") {
    assertAllowedOptions(parsed.options);
    requirePositionals(parsed.positionals, 3, "registry-cli.js images set-cover <image-id>");
    return outcome("images set-cover", setCover(registry, parsed.positionals[2]));
  }
  if (subcommand === "clear-cover") {
    assertAllowedOptions(parsed.options);
    requirePositionals(parsed.positionals, 3, "registry-cli.js images clear-cover <entry-id>");
    return outcome("images clear-cover", clearCover(registry, parsed.positionals[2]));
  }
  if (subcommand === "remove") {
    assertAllowedOptions(parsed.options);
    requirePositionals(parsed.positionals, 3, "registry-cli.js images remove <image-id>");
    return outcome("images remove", await removeVisualAsset(registry, parsed.positionals[2]));
  }
  throw new RegistryError(
    "CLI_UNKNOWN_COMMAND",
    "images requires add-file, add-reference, get, list, set-cover, clear-cover, or remove."
  );
}

async function handleCaptures(registry, parsed) {
  if (parsed.positionals[1] === "import-tree") {
    assertAllowedOptions(parsed.options, ["report"]);
    requirePositionals(parsed.positionals, 3, "registry-cli.js captures import-tree <root-directory> [--report <json>]");
    return outcome("captures import-tree", await importCaptureTree(registry, parsed.positionals[2], {
      reportPath: optionValue(parsed.options, "report")
    }));
  }
  if (parsed.positionals[1] !== "import") {
    throw new RegistryError("CLI_UNKNOWN_COMMAND", "captures requires import or import-tree.");
  }
  assertAllowedOptions(parsed.options, ["folder-id"]);
  requirePositionals(parsed.positionals, 3, "registry-cli.js captures import <manifest-json> [--folder-id <id>]");
  return outcome("captures import", await importCaptureManifest(
    registry,
    parsed.positionals[2],
    { folderId: optionValue(parsed.options, "folder-id") }
  ));
}

function handleDatabase(parsed, { env }) {
  const subcommand = parsed.positionals[1];
  if (subcommand === "backup-bundle") {
    assertAllowedOptions(parsed.options);
    requirePositionals(parsed.positionals, 3, "registry-cli.js db backup-bundle <new-directory>");
    return outcome("db backup-bundle", backupStorageBundle(parsed.positionals[2], {
      dbPath: optionValue(parsed.options, "db"), env
    }));
  }
  if (subcommand === "verify-backup-bundle") {
    assertAllowedOptions(parsed.options);
    requirePositionals(parsed.positionals, 3, "registry-cli.js db verify-backup-bundle <directory>");
    return outcome("db verify-backup-bundle", verifyStorageBundle(parsed.positionals[2]));
  }
  if (subcommand === "restore-bundle") {
    assertAllowedOptions(parsed.options, ["to"]);
    requirePositionals(parsed.positionals, 3, "registry-cli.js db restore-bundle <bundle> --to <new-directory>");
    return outcome("db restore-bundle", restoreStorageBundle(
      parsed.positionals[2],
      requireOption(parsed.options, "to")
    ));
  }
  if (subcommand === "reconcile-cleanup") {
    assertAllowedOptions(parsed.options, ["limit"]);
    requirePositionals(parsed.positionals, 2, "registry-cli.js db reconcile-cleanup [--limit <n>]");
    const registry = openRegistry({
      dbPath: optionValue(parsed.options, "db"),
      env,
      reconcileCleanup: false
    });
    try {
      return outcome("db reconcile-cleanup", reconcileFileCleanup(registry, {
        limit: optionValue(parsed.options, "limit") === undefined ? undefined : Number(optionValue(parsed.options, "limit"))
      }));
    } finally {
      registry.close();
    }
  }
  if (subcommand !== "backup") {
    throw new RegistryError("CLI_UNKNOWN_COMMAND", "db requires backup, backup-bundle, verify-backup-bundle, restore-bundle, or reconcile-cleanup.");
  }
  assertAllowedOptions(parsed.options);
  requirePositionals(parsed.positionals, 3, "registry-cli.js db backup <backup-sqlite3>");
  return outcome("db backup", backupDatabase(parsed.positionals[2], {
    dbPath: optionValue(parsed.options, "db"),
    env
  }));
}

function handleComments(registry, parsed) {
  const subcommand = parsed.positionals[1] || "";
  if (subcommand === "add") {
    assertAllowedOptions(parsed.options, ["text"]);
    requirePositionals(parsed.positionals, 3, "registry-cli.js comments add <entry-id> --text <comment>");
    return outcome("comments add", addComment(
      registry,
      parsed.positionals[2],
      requireOption(parsed.options, "text")
    ));
  }
  if (subcommand === "list") {
    assertAllowedOptions(parsed.options, ["page", "page-size"]);
    requirePositionals(parsed.positionals, 3, "registry-cli.js comments list <entry-id> [--page <n>]");
    return outcome("comments list", listComments(registry, parsed.positionals[2], {
      page: optionValue(parsed.options, "page"),
      pageSize: optionValue(parsed.options, "page-size")
    }));
  }
  throw new RegistryError("CLI_UNKNOWN_COMMAND", "comments requires add or list.");
}

function handleTags(registry, parsed) {
  const subcommand = parsed.positionals[1] || "";
  if (subcommand === "add" || subcommand === "remove") {
    assertAllowedOptions(parsed.options, ["tag"]);
    requirePositionals(parsed.positionals, 3, `registry-cli.js tags ${subcommand} <entry-id> --tag <tag>`);
    const tags = optionValues(parsed.options, "tag");
    if (!tags.length) {
      throw new RegistryError("CLI_OPTION_REQUIRED", "At least one --tag is required.", {
        option: "tag"
      });
    }
    const data = subcommand === "add"
      ? addTags(registry, parsed.positionals[2], tags)
      : removeTags(registry, parsed.positionals[2], tags);
    return outcome(`tags ${subcommand}`, data);
  }
  if (subcommand === "list") {
    assertAllowedOptions(parsed.options);
    requirePositionals(parsed.positionals, 3, "registry-cli.js tags list <entry-id>");
    return outcome("tags list", listTags(registry, parsed.positionals[2]));
  }
  throw new RegistryError("CLI_UNKNOWN_COMMAND", "tags requires add, remove, or list.");
}

function handlePolicy(registry, parsed) {
  if (parsed.positionals[1] !== "set") {
    throw new RegistryError("CLI_UNKNOWN_COMMAND", "policy requires set.");
  }
  assertAllowedOptions(parsed.options, ["visibility"]);
  requirePositionals(parsed.positionals, 3, "registry-cli.js policy set <entry-id> [policy options]");
  return outcome("policy set", setEntryPolicy(registry, parsed.positionals[2], {
    visibility: optionValue(parsed.options, "visibility")
  }));
}

function handleStats(registry, parsed) {
  const subcommand = parsed.positionals[1] || "";
  if (subcommand === "tags") {
    assertAllowedOptions(parsed.options, ["limit"]);
    requirePositionals(parsed.positionals, 2, "registry-cli.js stats tags [--limit <n>]");
    return outcome("stats tags", topTags(registry, {
      limit: optionValue(parsed.options, "limit")
    }));
  }
  if (subcommand === "sources") {
    assertAllowedOptions(parsed.options, ["limit", "threshold"]);
    requirePositionals(parsed.positionals, 2, "registry-cli.js stats sources [--threshold <n>] [--limit <n>]");
    return outcome("stats sources", topSourceDomains(registry, {
      limit: optionValue(parsed.options, "limit"),
      threshold: optionValue(parsed.options, "threshold")
    }));
  }
  throw new RegistryError("CLI_UNKNOWN_COMMAND", "stats requires tags or sources.");
}

async function handleSnapshots(registry, parsed) {
  const subcommand = parsed.positionals[1] || "";
  if (subcommand === "attach") {
    assertAllowedOptions(parsed.options, ["file", "captured-at"]);
    requirePositionals(parsed.positionals, 3, "registry-cli.js snapshots attach <entry-id> --file <image>");
    return outcome("snapshots attach", await attachSnapshot(
      registry,
      parsed.positionals[2],
      requireOption(parsed.options, "file"),
      { capturedAt: optionValue(parsed.options, "captured-at") }
    ));
  }
  if (subcommand === "list") {
    assertAllowedOptions(parsed.options);
    requirePositionals(parsed.positionals, 3, "registry-cli.js snapshots list <entry-id>");
    return outcome("snapshots list", listSnapshots(registry, parsed.positionals[2]));
  }
  if (subcommand === "remove") {
    assertAllowedOptions(parsed.options);
    requirePositionals(parsed.positionals, 3, "registry-cli.js snapshots remove <snapshot-id>");
    return outcome("snapshots remove", await removeSnapshot(registry, parsed.positionals[2]));
  }
  throw new RegistryError("CLI_UNKNOWN_COMMAND", "snapshots requires attach, list, or remove.");
}

function handleSummaries(registry, parsed) {
  const subcommand = parsed.positionals[1] || "";
  if (subcommand === "create-job") {
    assertAllowedOptions(parsed.options, ["requested-by"]);
    requirePositionals(parsed.positionals, 3, "registry-cli.js summaries create-job <entry-id>");
    return outcome("summaries create-job", createSummaryJob(registry, parsed.positionals[2], {
      requestedBy: optionValue(parsed.options, "requested-by")
    }));
  }
  if (subcommand === "list-jobs") {
    assertAllowedOptions(parsed.options, ["entry-id", "status", "page", "page-size"]);
    requirePositionals(parsed.positionals, 2, "registry-cli.js summaries list-jobs [filters]");
    return outcome("summaries list-jobs", listSummaryJobs(registry, {
      entryId: optionValue(parsed.options, "entry-id"),
      status: optionValue(parsed.options, "status"),
      page: optionValue(parsed.options, "page"),
      pageSize: optionValue(parsed.options, "page-size")
    }));
  }
  throw new RegistryError("CLI_UNKNOWN_COMMAND", "summaries requires create-job or list-jobs.");
}

function setNullableChange(target, property, options, valueOption, clearOption) {
  const value = optionValue(options, valueOption);
  const clear = optionValue(options, clearOption);
  if (value !== undefined && clear) {
    throw new RegistryError(
      "CLI_ARGUMENT_ERROR",
      `--${valueOption} and --${clearOption} cannot be combined.`
    );
  }
  if (value !== undefined) {
    target[property] = value;
  } else if (clear) {
    target[property] = null;
  }
}

function outcome(command, data) {
  return { command, data };
}

function helpText() {
  return `Web Bookmark Hub registry CLI

Usage:
  node registry-cli.js enrich <plan|run|templates> [--entry ID | --url URL]
    [--site SITE] [--mode pending|retry|refresh] [--limit 20] [--allow-new] [--json]
  Agent access uses agent-cli.js, not this owner CLI. See docs/project/ENRICHMENT.md.
  node registry-cli.js init [--db <path>] [--json]
  node registry-cli.js add <url> [--title <text>] [--kind <kind>] [--tag <tag> ...]
    [--comment <text>] [--metadata-json <object>] [--visibility normal|private]
    [--content-focus text|visual] [--folder-id <id>]
  node registry-cli.js list [--saved-from <date>] [--saved-to <date>] [--tag <tag>]
    [--kind <kind>] [--provider <provider>] [--source-domain <host>]
    [--visibility <value>] [--agent-access <value>] [--content-focus text|visual]
    [--folder-id <id> [--include-descendants]|--unfiled] [--preview with|without]
    [--page <n>] [--page-size <n>] [--search <text>]
    [--sort newest|oldest|updated_desc|updated_asc|title_asc|title_desc|source_asc|source_desc]
  node registry-cli.js get <entry-id>
  node registry-cli.js edit <entry-id> [--title <text>|--clear-title]
    [--kind <kind>|--reset-kind] [--metadata-json <object>]
    [--published-at <date>|--clear-published-at] [--updated-at <date>|--clear-updated-at]
    [--content-focus text|visual]
  node registry-cli.js comments add <entry-id> --text <comment>
  node registry-cli.js comments list <entry-id> [--page <n>] [--page-size <n>]
  node registry-cli.js tags add|remove <entry-id> --tag <tag> [--tag <tag> ...]
  node registry-cli.js tags list <entry-id>
  node registry-cli.js policy set <entry-id> --visibility normal|private
  node registry-cli.js stats tags [--limit <n>]
  node registry-cli.js stats sources [--threshold <n>] [--limit <n>]
  node registry-cli.js snapshots attach <entry-id> --file <local-image> [--captured-at <date>]
  node registry-cli.js snapshots list <entry-id>
  node registry-cli.js snapshots remove <snapshot-id>
  node registry-cli.js folders create --name <name> [--parent-id <id>]
  node registry-cli.js folders get <folder-id>
  node registry-cli.js folders list [--parent-id <id>|--root]
  node registry-cli.js folders tree
  node registry-cli.js folders rename <folder-id> --name <name>
  node registry-cli.js folders move <folder-id> (--parent-id <id>|--root)
  node registry-cli.js folders delete <folder-id>
  node registry-cli.js folders assign <entry-id> --folder-id <id>
  node registry-cli.js folders unassign <entry-id>
  node registry-cli.js images add-file <entry-id> --file <image> [--source-kind <kind>]
    [--source-url <url>] [--captured-at <date>] [--cover]
  node registry-cli.js images add-reference <entry-id> --url <image-url> [--source-kind <kind>]
    [--captured-at <date>] [--cover]
  node registry-cli.js images get <image-id>
  node registry-cli.js images list <entry-id>
  node registry-cli.js images set-cover <image-id>
  node registry-cli.js images clear-cover <entry-id>
  node registry-cli.js images remove <image-id>
  node registry-cli.js images audit-local
  node registry-cli.js captures import <manifest-json> [--folder-id <id>]
  node registry-cli.js captures import-tree <root-directory> [--report <json>]
  node registry-cli.js metadata validate <json>
  node registry-cli.js metadata export <new-json>
  node registry-cli.js metadata import <json>
  node registry-cli.js db backup <backup-sqlite3>
  node registry-cli.js db backup-bundle <new-directory>
  node registry-cli.js db verify-backup-bundle <directory>
  node registry-cli.js db restore-bundle <bundle> --to <new-directory>
  node registry-cli.js db reconcile-cleanup [--limit <n>]
  node registry-cli.js summaries create-job <entry-id> [--requested-by <label>]
  node registry-cli.js summaries list-jobs [--entry-id <id>] [--status <status>]

Database selection:
  --db takes precedence over WEB_BOOKMARK_HUB_DB. Without either, the CLI uses the
  Git-ignored project data/registry.sqlite3 path. Registry data elsewhere inside this
  repository is rejected. --json and --db may appear anywhere in a command.

Notes:
  db backup creates a SQLite-only copy. Use db backup-bundle for a complete backup
  that includes the adjacent local-file tree, and stop the owning server first.
  Entry defaults are private / blocked / AI disabled. Summary jobs make no network call
  and are fixed to gpt-5.6-luna with reasoning effort max. Visual source kinds are
  user_upload, browser_selected, provider_thumbnail, page_snapshot, and imported;
  page_snapshot and user_upload cannot be remote references.`;
}

module.exports = {
  executeCli,
  helpText
};
