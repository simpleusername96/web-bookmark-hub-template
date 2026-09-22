"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { addComment } = require("./comments.js");
const { assertPathOutsideRepository, withTransaction } = require("./database.js");
const { addEntry } = require("./entries.js");
const { RegistryError } = require("./errors.js");
const { createFolder } = require("./folders.js");
const { addTags } = require("./tags.js");
const { addRemoteImageReference, clearCover } = require("./visual-assets.js");

const METADATA_FORMAT = "web-bookmark-hub/metadata-export/v1";
const MAX_FOLDERS = 10_000;
const MAX_ENTRIES = 10_000;
const MAX_ENTRY_CHILDREN = 1_000;
const REMOTE_SOURCE_KINDS = new Set(["browser_selected", "provider_thumbnail", "imported"]);

function exportOwnerMetadata(registry, targetPath) {
  const target = path.resolve(String(targetPath));
  assertPathOutsideRepository(target);
  if (fs.existsSync(target)) throw new RegistryError("METADATA_EXPORT_EXISTS", "Metadata export target already exists.");
  const document = buildOwnerMetadata(registry);
  validateOwnerMetadata(document);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return { export_path: target, folders: document.folders.length, entries: document.entries.length };
}

function buildOwnerMetadata(registry) {
  const folders = registry.db.prepare("SELECT * FROM folders ORDER BY id ASC").all();
  const folderKeys = new Map(folders.map((folder, index) => [Number(folder.id), `folder-${index + 1}`]));
  const entries = registry.db.prepare("SELECT * FROM entries WHERE deleted_at IS NULL ORDER BY id ASC").all();
  return {
    format: METADATA_FORMAT,
    folders: folders.map((folder) => ({
      key: folderKeys.get(Number(folder.id)),
      parent_key: folder.parent_id === null ? null : folderKeys.get(Number(folder.parent_id)),
      name: folder.name,
      created_at: folder.created_at,
      updated_at: folder.updated_at
    })),
    entries: entries.map((entry) => ({
      url_original: entry.url_original,
      title: entry.title,
      kind: entry.kind,
      kind_source: entry.kind_source,
      typed_metadata: JSON.parse(entry.typed_metadata_json),
      saved_at: entry.saved_at,
      published_at: entry.published_at,
      updated_at: entry.updated_at,
      visibility: entry.visibility,
      agent_access: entry.agent_access,
      ai_processing: entry.ai_processing,
      content_focus: entry.content_focus,
      folder_key: entry.folder_id === null ? null : folderKeys.get(Number(entry.folder_id)),
      tags: registry.db.prepare(`
        SELECT t.name FROM tags t JOIN entry_tags et ON et.tag_id = t.id
        WHERE et.entry_id = ? ORDER BY t.normalized_name ASC, t.id ASC
      `).all(entry.id).map((tag) => tag.name),
      notes: registry.db.prepare(`
        SELECT body, created_at FROM entry_comments
        WHERE entry_id = ? ORDER BY created_at ASC, id ASC
      `).all(entry.id).map((note) => ({ body: note.body, created_at: note.created_at })),
      visual_references: registry.db.prepare(`
        SELECT source_kind, source_url, captured_at, position, is_cover
        FROM entry_visual_assets
        WHERE entry_id = ? AND source_url IS NOT NULL
        ORDER BY position ASC, id ASC
      `).all(entry.id).filter(exportableVisualReference).map((asset) => ({
        source_kind: asset.source_kind,
        source_url: credentialFreeUrl(asset.source_url),
        captured_at: asset.captured_at,
        is_cover: Boolean(asset.is_cover)
      }))
    }))
  };
}

function validateOwnerMetadataFile(sourcePath) {
  return validateOwnerMetadata(readDocument(sourcePath));
}

function validateOwnerMetadata(document) {
  assertExactKeys(document, ["format", "folders", "entries"], "document");
  assert(document.format === METADATA_FORMAT, "METADATA_FORMAT_UNSUPPORTED", "Metadata export format is unsupported.");
  assertArray(document.folders, "folders", MAX_FOLDERS);
  assertArray(document.entries, "entries", MAX_ENTRIES);
  const folderKeys = new Set();
  for (const folder of document.folders) {
    assertExactKeys(folder, ["key", "parent_key", "name", "created_at", "updated_at"], "folder");
    assertText(folder.key, "folder key");
    assert(!folderKeys.has(folder.key), "METADATA_INVALID", "Folder keys must be unique.");
    folderKeys.add(folder.key);
    assert(folder.parent_key === null || typeof folder.parent_key === "string", "METADATA_INVALID", "Folder parent key is invalid.");
    assertText(folder.name, "folder name");
    assertTimestamp(folder.created_at, "folder created_at");
    assertTimestamp(folder.updated_at, "folder updated_at");
  }
  assertAcyclicFolders(document.folders, folderKeys);
  for (const entry of document.entries) validateEntry(entry, folderKeys);
  return { valid: true, format: METADATA_FORMAT, folders: document.folders.length, entries: document.entries.length };
}

function importOwnerMetadata(registry, sourcePath) {
  const document = readDocument(sourcePath);
  validateOwnerMetadata(document);
  return withTransaction(registry.db, () => {
    const folderIds = importFolders(registry, document.folders);
    const counts = { folders_created: 0, folders_reused: 0, entries_created: 0, entries_already_saved: 0 };
    for (const value of folderIds.values()) counts[value.created ? "folders_created" : "folders_reused"] += 1;
    for (const entry of document.entries) {
      const created = addEntry(registry, {
        url: entry.url_original,
        title: entry.title,
        ...(entry.kind_source === "user" ? { kind: entry.kind } : {}),
        typedMetadata: entry.typed_metadata,
        savedAt: entry.saved_at,
        publishedAt: entry.published_at,
        updatedAt: entry.updated_at,
        visibility: entry.visibility,
        agentAccess: entry.agent_access,
        aiProcessing: entry.ai_processing,
        contentFocus: entry.content_focus,
        folderId: entry.folder_key === null ? null : folderIds.get(entry.folder_key).id
      });
      if (created.outcome_code === "already_saved") {
        counts.entries_already_saved += 1;
        continue;
      }
      counts.entries_created += 1;
      if (created.entry.kind !== entry.kind || created.entry.kind_source !== entry.kind_source) {
        throw new RegistryError("METADATA_KIND_MISMATCH", "Metadata Entry type is incompatible with its URL.");
      }
      if (entry.tags.length) addTags(registry, created.entry.id, entry.tags, { clock: at(entry.saved_at) });
      for (const note of entry.notes) addComment(registry, created.entry.id, note.body, { clock: at(note.created_at) });
      for (const asset of entry.visual_references) {
        addRemoteImageReference(registry, created.entry.id, asset.source_url, {
          sourceKind: asset.source_kind,
          capturedAt: asset.captured_at,
          makeCover: asset.is_cover,
          clock: at(asset.captured_at)
        });
      }
      if (entry.visual_references.length && !entry.visual_references.some((asset) => asset.is_cover)) {
        clearCover(registry, created.entry.id, { clock: at(entry.saved_at) });
      }
    }
    return counts;
  });
}

function importFolders(registry, folders) {
  const remaining = new Map(folders.map((folder) => [folder.key, folder]));
  const result = new Map();
  while (remaining.size) {
    let progressed = false;
    for (const [key, folder] of remaining) {
      if (folder.parent_key !== null && !result.has(folder.parent_key)) continue;
      const parentId = folder.parent_key === null ? null : result.get(folder.parent_key).id;
      const normalizedName = normalizeFolderName(folder.name);
      const existing = registry.db.prepare(`
        SELECT id FROM folders WHERE parent_id IS ? AND normalized_name = ? ORDER BY id ASC LIMIT 1
      `).get(parentId, normalizedName);
      if (existing) result.set(key, { id: Number(existing.id), created: false });
      else {
        const created = createFolder(registry, { name: folder.name, parentId }, { clock: at(folder.created_at) });
        registry.db.prepare("UPDATE folders SET updated_at = ? WHERE id = ?").run(folder.updated_at, created.id);
        result.set(key, { id: created.id, created: true });
      }
      remaining.delete(key);
      progressed = true;
    }
    if (!progressed) throw new RegistryError("METADATA_INVALID", "Folder hierarchy is invalid.");
  }
  return result;
}

function validateEntry(entry, folderKeys) {
  assertExactKeys(entry, [
    "url_original", "title", "kind", "kind_source", "typed_metadata", "saved_at", "published_at",
    "updated_at", "visibility", "agent_access", "ai_processing", "content_focus", "folder_key",
    "tags", "notes", "visual_references"
  ], "entry");
  assertText(entry.url_original, "Entry URL");
  assert(entry.title === null || typeof entry.title === "string", "METADATA_INVALID", "Entry title is invalid.");
  assertText(entry.kind, "Entry kind");
  assert(["derived", "user"].includes(entry.kind_source), "METADATA_INVALID", "Entry kind source is invalid.");
  assertPlainObject(entry.typed_metadata, "Entry typed metadata");
  assertTimestamp(entry.saved_at, "Entry saved_at");
  for (const [name, value] of [["published_at", entry.published_at], ["updated_at", entry.updated_at]]) {
    if (value !== null) assertTimestamp(value, `Entry ${name}`);
  }
  assert(["normal", "private"].includes(entry.visibility), "METADATA_INVALID", "Entry visibility is invalid.");
  assert(["blocked", "metadata_only", "allowed"].includes(entry.agent_access), "METADATA_INVALID", "Entry agent access is invalid.");
  assert(["disabled", "manual", "enabled"].includes(entry.ai_processing), "METADATA_INVALID", "Entry AI processing is invalid.");
  assert(["text", "visual"].includes(entry.content_focus), "METADATA_INVALID", "Entry content focus is invalid.");
  assert(entry.folder_key === null || folderKeys.has(entry.folder_key), "METADATA_INVALID", "Entry Folder reference is invalid.");
  assertArray(entry.tags, "Entry tags", MAX_ENTRY_CHILDREN);
  entry.tags.forEach((tag) => assertText(tag, "tag"));
  assertArray(entry.notes, "Entry notes", MAX_ENTRY_CHILDREN);
  for (const note of entry.notes) {
    assertExactKeys(note, ["body", "created_at"], "note");
    assertText(note.body, "note body");
    assertTimestamp(note.created_at, "note created_at");
  }
  assertArray(entry.visual_references, "Entry visual references", MAX_ENTRY_CHILDREN);
  for (const asset of entry.visual_references) {
    assertExactKeys(asset, ["source_kind", "source_url", "captured_at", "is_cover"], "visual reference");
    assert(REMOTE_SOURCE_KINDS.has(asset.source_kind), "METADATA_INVALID", "Visual reference source kind is invalid.");
    credentialFreeUrl(asset.source_url);
    assertTimestamp(asset.captured_at, "visual reference captured_at");
    assert(typeof asset.is_cover === "boolean", "METADATA_INVALID", "Visual reference cover flag is invalid.");
  }
}

function assertAcyclicFolders(folders, keys) {
  const parents = new Map(folders.map((folder) => [folder.key, folder.parent_key]));
  for (const folder of folders) {
    if (folder.parent_key !== null && !keys.has(folder.parent_key)) {
      throw new RegistryError("METADATA_INVALID", "Folder parent reference is invalid.");
    }
    const seen = new Set([folder.key]);
    let parent = folder.parent_key;
    while (parent !== null) {
      if (seen.has(parent)) throw new RegistryError("METADATA_INVALID", "Folder hierarchy contains a cycle.");
      seen.add(parent);
      parent = parents.get(parent);
    }
  }
}

function readDocument(sourcePath) {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(String(sourcePath)), "utf8"));
  } catch {
    throw new RegistryError("METADATA_INVALID", "Metadata export could not be read as JSON.");
  }
}

function exportableVisualReference(asset) {
  if (!REMOTE_SOURCE_KINDS.has(asset.source_kind)) return false;
  try {
    credentialFreeUrl(asset.source_url);
    return true;
  } catch {
    return false;
  }
}

function credentialFreeUrl(value) {
  let url;
  try { url = new URL(String(value)); } catch { throw new RegistryError("METADATA_INVALID", "Visual reference URL is invalid."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new RegistryError("METADATA_INVALID", "Visual reference URL must be credential-free HTTP(S).");
  }
  return url.href;
}

function assertExactKeys(value, expected, label) {
  assertPlainObject(value, label);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  assert(JSON.stringify(actual) === JSON.stringify(wanted), "METADATA_INVALID", `${label} fields are invalid.`);
}

function assertPlainObject(value, label) {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), "METADATA_INVALID", `${label} must be an object.`);
}

function assertArray(value, label, max) {
  assert(Array.isArray(value) && value.length <= max, "METADATA_INVALID", `${label} must be a bounded array.`);
}

function assertText(value, label) {
  assert(typeof value === "string" && value.trim(), "METADATA_INVALID", `${label} must be text.`);
}

function assertTimestamp(value, label) {
  assert(typeof value === "string" && Number.isFinite(Date.parse(value)), "METADATA_INVALID", `${label} must be a timestamp.`);
}

function assert(condition, code, message) {
  if (!condition) throw new RegistryError(code, message);
}

function normalizeFolderName(value) {
  return String(value).normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

function at(timestamp) {
  return { now: () => timestamp };
}

module.exports = {
  METADATA_FORMAT,
  buildOwnerMetadata,
  exportOwnerMetadata,
  importOwnerMetadata,
  validateOwnerMetadata,
  validateOwnerMetadataFile
};
