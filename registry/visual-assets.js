"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");

const { RegistryError } = require("./errors.js");
const { isPathWithin, resolvePathThroughExistingAncestors } = require("./database.js");
const { analyzeUrl } = require("./url-policy.js");
const { entryId, normalizeTimestamp, nowIso, positiveInteger } = require("./values.js");
const { recordEntryRevision } = require("./entry-revisions.js");
const { enqueueFileCleanup, reconcileFileCleanup } = require("./file-cleanup.js");
const { MAX_LOCAL_IMAGE_BYTES } = require("./visual-asset-contract.js");

const SOURCE_KINDS = new Set(["user_upload", "browser_selected", "provider_thumbnail", "page_snapshot", "imported"]);

async function addLocalImage(registry, entryIdValue, sourceFile, options = {}) {
  const entry = ensureEntry(registry, entryIdValue);
  if (registry.dbPath === ":memory:") throw new RegistryError("VISUAL_ASSET_STORAGE_UNAVAILABLE", "Local images require a file-backed registry database.");
  if (registry.db.isTransaction) throw new RegistryError("VISUAL_ASSET_ATTACH_BUSY", "Local image attachment requires an idle registry transaction.", { entryId: entry });
  const sourcePath = path.resolve(String(sourceFile || ""));
  const sourceStat = await sourceFileStat(sourcePath);
  if (sourceStat.size < 1) throw new RegistryError("VISUAL_ASSET_IMAGE_INVALID", "Image source is empty.");
  if (sourceStat.size > MAX_LOCAL_IMAGE_BYTES) {
    throw new RegistryError("VISUAL_ASSET_IMAGE_TOO_LARGE", "Image source exceeds the 25 MiB local file limit.", {
      maxBytes: MAX_LOCAL_IMAGE_BYTES
    });
  }
  const imageType = await detectImageFile(sourcePath);
  if (!imageType) throw unsupportedImageError();
  const sha256 = await hashFile(sourcePath);
  const sourceKind = normalizeSourceKind(options.sourceKind, "user_upload");
  const sourceUrl = optionalRemoteUrl(options.sourceUrl);
  validateStorageSourceKind(sourceKind, "local");
  const duplicate = options.allowDuplicate ? null : registry.db.prepare(`
    SELECT id, storage_path, status, sha256, media_type, byte_size FROM entry_visual_assets
    WHERE entry_id = ? AND storage_kind = 'local' AND status IN ('ready','missing') AND sha256 = ?
      AND source_kind = ? AND source_url IS ?
    ORDER BY id LIMIT 1
  `).get(entry, sha256, sourceKind, sourceUrl);
  if (duplicate) {
    const repaired = await ensureLocalDuplicateIntegrity(registry, duplicate, sourcePath, {
      sha256,
      mediaType: imageType.mediaType,
      byteSize: sourceStat.size,
      clock: options.clock || Date
    });
    transaction(registry.db, () => {
      options.assertCurrent?.();
      if (options.makeCover) setCover(registry, Number(duplicate.id), options);
      else promoteVisualFocus(registry, entry, nowIso(options.clock || Date));
    });
    return { asset: getVisualAsset(registry, Number(duplicate.id)), duplicate: true, repaired };
  }
  const capturedAt = captureTime(options);
  const createdAt = nowIso(options.clock || Date);
  const directory = storageDirectory(options.storageDirectory || "visual-assets");
  const storagePath = [directory, String(entry), `${randomUUID()}.${imageType.extension}`].join("/");
  let destinationPath = resolveVisualAssetPath(registry, storagePath);
  await fsp.mkdir(path.dirname(destinationPath), { recursive: true });
  try {
    destinationPath = resolveVisualAssetPath(registry, storagePath);
    await fsp.copyFile(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
    const copiedType = await detectImageFile(destinationPath);
    const copiedStat = await fsp.stat(destinationPath);
    const copiedHash = await hashFile(destinationPath);
    if (!copiedType || copiedType.extension !== imageType.extension || copiedHash !== sha256 || copiedStat.size !== sourceStat.size) {
      throw new RegistryError("VISUAL_ASSET_SOURCE_CHANGED", "Image source changed while it was copied.");
    }
    return { asset: insertAsset(registry, { entry, sourceKind, sourceUrl, storageKind: "local", capturedAt, status: "ready", sha256, storagePath, mediaType: imageType.mediaType, byteSize: copiedStat.size, createdAt, makeCover: Boolean(options.makeCover), assertCurrent: options.assertCurrent }), duplicate: false };
  } catch (error) {
    await fsp.rm(destinationPath, { force: true }).catch(() => {});
    if (error instanceof RegistryError) throw error;
    throw new RegistryError("VISUAL_ASSET_ATTACH_FAILED", "Image could not be attached.");
  }
}

function addRemoteImageReference(registry, entryIdValue, sourceUrlValue, options = {}) {
  const entry = ensureEntry(registry, entryIdValue);
  const sourceUrl = remoteUrl(sourceUrlValue);
  const sourceKind = normalizeSourceKind(options.sourceKind, "provider_thumbnail");
  validateStorageSourceKind(sourceKind, "remote");
  let duplicate = registry.db.prepare(`
    SELECT id, storage_kind FROM entry_visual_assets
    WHERE entry_id = ? AND source_url = ? AND source_kind = ? AND (
      (storage_kind = 'remote' AND status = 'referenced')
      OR (storage_kind = 'local' AND status = 'ready')
    )
    ORDER BY storage_kind = 'local' DESC, id ASC LIMIT 1
  `).get(entry, sourceUrl, sourceKind);
  if (duplicate) {
    const duplicateAsset = getVisualAsset(registry, Number(duplicate.id));
    const usable = duplicate.storage_kind !== "local"
      || inspectLocalAssetSync(duplicateAsset);
    if (usable) {
      if (options.makeCover) setCover(registry, Number(duplicate.id), options);
      else promoteVisualFocus(registry, entry, nowIso(options.clock || Date));
      return { asset: duplicateAsset, duplicate: true };
    }
    registry.db.prepare("UPDATE entry_visual_assets SET status = 'missing', updated_at = ? WHERE id = ?")
      .run(nowIso(options.clock || Date), duplicateAsset.id);
    duplicate = registry.db.prepare(`
      SELECT id FROM entry_visual_assets
      WHERE entry_id = ? AND source_url = ? AND source_kind = ?
        AND storage_kind = 'remote' AND status = 'referenced'
      ORDER BY id ASC LIMIT 1
    `).get(entry, sourceUrl, sourceKind);
    if (duplicate) {
      if (options.makeCover) setCover(registry, Number(duplicate.id), options);
      return { asset: getVisualAsset(registry, Number(duplicate.id)), duplicate: true };
    }
  }
  return { asset: insertAsset(registry, { entry, sourceKind, sourceUrl, storageKind: "remote", capturedAt: captureTime(options), status: "referenced", sha256: null, storagePath: null, mediaType: null, byteSize: null, createdAt: nowIso(options.clock || Date), makeCover: Boolean(options.makeCover) }), duplicate: false };
}

function insertAsset(registry, input) {
  let result;
  transaction(registry.db, () => {
    input.assertCurrent?.();
    const position = Number(registry.db.prepare("SELECT COALESCE(MAX(position) + 1, 0) AS next_position FROM entry_visual_assets WHERE entry_id = ?").get(input.entry).next_position);
    const hasCover = Boolean(registry.db.prepare("SELECT 1 FROM entry_visual_assets WHERE entry_id = ? AND is_cover = 1").get(input.entry));
    const isCover = input.makeCover || !hasCover;
    if (isCover && hasCover) registry.db.prepare("UPDATE entry_visual_assets SET is_cover = 0, updated_at = ? WHERE entry_id = ? AND is_cover = 1").run(input.createdAt, input.entry);
    result = registry.db.prepare(`INSERT INTO entry_visual_assets (entry_id, source_kind, source_url, storage_kind, captured_at, status, sha256, storage_path, media_type, byte_size, position, is_cover, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(input.entry, input.sourceKind, input.sourceUrl, input.storageKind, input.capturedAt, input.status, input.sha256, input.storagePath, input.mediaType, input.byteSize, position, isCover ? 1 : 0, input.createdAt, input.createdAt);
    promoteVisualFocus(registry, input.entry, input.createdAt);
  });
  return getVisualAsset(registry, Number(result.lastInsertRowid));
}

function listVisualAssets(registry, entryIdValue) {
  const entry = ensureEntry(registry, entryIdValue);
  return registry.db.prepare("SELECT * FROM entry_visual_assets WHERE entry_id = ? ORDER BY position ASC, id ASC").all(entry).map((row) => mapVisualAssetRow(registry, row));
}

function findSavedVisualAssetPresence(registry, items) {
  if (!Array.isArray(items)) {
    throw new RegistryError("CAPTURE_PRESENCE_INVALID", "Capture presence items must be an array.");
  }
  const findSaved = registry.db.prepare(`
    SELECT 1
    FROM entries e
    JOIN entry_visual_assets asset ON asset.entry_id = e.id
    WHERE e.url_canonical = ?
      AND asset.source_url = ?
      AND asset.status IN ('ready', 'referenced')
    LIMIT 1
  `);
  return items.map((item) => {
    const entryUrl = analyzeUrl(item.entryUrl).url_canonical;
    const assetUrls = Array.isArray(item.assetUrls) && item.assetUrls.length
      ? item.assetUrls
      : [item.assetUrl];
    if (assetUrls.length > 4) {
      throw new RegistryError("CAPTURE_PRESENCE_INVALID", "Capture presence item contains too many image references.");
    }
    const normalizedAssetUrls = assetUrls.map((assetUrl) => remoteUrl(assetUrl));
    if (normalizedAssetUrls.some((assetUrl) => Boolean(findSaved.get(entryUrl, assetUrl)))) return true;

    return false;
  });
}

function getVisualAsset(registry, assetIdValue) {
  const id = positiveInteger(assetIdValue, "visual_asset_id");
  const row = registry.db.prepare("SELECT * FROM entry_visual_assets WHERE id = ?").get(id);
  if (!row) throw new RegistryError("VISUAL_ASSET_NOT_FOUND", "Visual asset not found.", { visualAssetId: id });
  return mapVisualAssetRow(registry, row);
}

function setCover(registry, assetIdValue, options = {}) {
  const asset = getVisualAsset(registry, assetIdValue);
  const entry = asset.entry_id;
  const updatedAt = nowIso(options.clock || Date);
  transaction(registry.db, () => {
    const previous = registry.db.prepare(`
      SELECT id FROM entry_visual_assets WHERE entry_id = ? AND is_cover = 1
    `).get(entry);
    const previousFocus = registry.db.prepare("SELECT content_focus FROM entries WHERE id = ?").get(entry).content_focus;
    registry.db.prepare("UPDATE entry_visual_assets SET is_cover = 0, updated_at = ? WHERE entry_id = ? AND is_cover = 1").run(updatedAt, entry);
    registry.db.prepare("UPDATE entry_visual_assets SET is_cover = 1, updated_at = ? WHERE id = ?").run(updatedAt, asset.id);
    promoteVisualFocus(registry, entry, updatedAt);
    if (Number(previous?.id) !== asset.id || previousFocus !== "visual") {
      recordEntryRevision(registry, entry, "updated", {
        cover_visual_asset_id: { before: previous ? Number(previous.id) : null, after: asset.id },
        ...(previousFocus === "visual" ? {} : { content_focus: { before: previousFocus, after: "visual" } })
      }, options);
    }
  });
  return getVisualAsset(registry, asset.id);
}

function clearCover(registry, entryIdValue, options = {}) {
  const entry = ensureEntry(registry, entryIdValue);
  const previous = registry.db.prepare("SELECT id FROM entry_visual_assets WHERE entry_id = ? AND is_cover = 1").get(entry);
  transaction(registry.db, () => {
    registry.db.prepare("UPDATE entry_visual_assets SET is_cover = 0, updated_at = ? WHERE entry_id = ? AND is_cover = 1").run(nowIso(options.clock || Date), entry);
    if (previous) {
      recordEntryRevision(registry, entry, "updated", {
        cover_visual_asset_id: { before: Number(previous.id), after: null }
      }, options);
    }
  });
  return listVisualAssets(registry, entry);
}

async function removeVisualAsset(registry, assetIdValue, options = {}) {
  const asset = getVisualAsset(registry, assetIdValue);
  if (registry.db.isTransaction) throw new RegistryError("VISUAL_ASSET_REMOVE_BUSY", "Visual asset removal requires an idle registry transaction.", { visualAssetId: asset.id });
  if (asset.storage_kind === "remote") {
    try {
      transaction(registry.db, () => {
        registry.db.prepare("DELETE FROM entry_visual_assets WHERE id = ?").run(asset.id);
        recordAssetRemoval(registry, asset, options);
      });
    } catch (error) {
      if (error instanceof RegistryError) throw error;
      throw new RegistryError("VISUAL_ASSET_REMOVE_FAILED", "Visual asset could not be removed safely.", { visualAssetId: asset.id });
    }
    return { ...asset, removed: true, file_removed: false };
  }
  try {
    transaction(registry.db, () => {
      enqueueFileCleanup(registry, asset.storage_path, "visual_asset_remove", { clock: options.clock || Date });
      registry.db.prepare("DELETE FROM entry_visual_assets WHERE id = ?").run(asset.id);
      recordAssetRemoval(registry, asset, options);
      if (typeof options.beforeCommit === "function") options.beforeCommit();
    });
  } catch (error) {
    if (error instanceof RegistryError) throw error;
    throw new RegistryError("VISUAL_ASSET_REMOVE_FAILED", "Visual asset could not be removed safely.", { visualAssetId: asset.id });
  }
  if (typeof options.afterCommit === "function") options.afterCommit();
  const cleanup = reconcileFileCleanup(registry, {
    storagePaths: [asset.storage_path],
    limit: 1,
    afterUnlink: options.afterUnlink
  });
  return { ...asset, removed: true, file_removed: cleanup.removed === 1, file_pending: cleanup.failed === 1 };
}

async function auditLocalVisualAssets(registry) {
  const rows = registry.db.prepare(`
    SELECT storage_path, sha256, media_type, byte_size
    FROM entry_visual_assets
    WHERE storage_kind = 'local' AND status = 'ready'
    ORDER BY id
  `).all();
  const report = {
    total: rows.length,
    verified: 0,
    missing: 0,
    hash_mismatch: 0,
    size_mismatch: 0,
    media_type_mismatch: 0
  };
  for (const row of rows) {
    try {
      const filePath = resolveVisualAssetPath(registry, row.storage_path);
      const [stat, sha256, imageType] = await Promise.all([
        fsp.stat(filePath),
        hashFile(filePath),
        detectImageFile(filePath)
      ]);
      let valid = true;
      if (stat.size !== Number(row.byte_size)) { report.size_mismatch += 1; valid = false; }
      if (sha256 !== row.sha256) { report.hash_mismatch += 1; valid = false; }
      if (!imageType || imageType.mediaType !== row.media_type) { report.media_type_mismatch += 1; valid = false; }
      if (valid) report.verified += 1;
    } catch {
      report.missing += 1;
    }
  }
  return report;
}

function recordAssetRemoval(registry, asset, options) {
  recordEntryRevision(registry, asset.entry_id, "updated", {
    visual_asset: {
      before: { id: asset.id, source_kind: asset.source_kind, is_cover: asset.is_cover },
      after: null
    }
  }, options);
}

function resolveVisualAssetPath(registry, storagePath) {
  const value = String(storagePath || "");
  const segments = value.split(/[\\/]+/);
  if (!value || path.isAbsolute(value) || segments.includes("..") || segments.includes("")) throw new RegistryError("VISUAL_ASSET_PATH_INVALID", "Visual asset storage path is invalid.");
  const root = path.resolve(registry.dataDir);
  const target = path.resolve(root, ...segments);
  const relative = path.relative(root, target);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) throw new RegistryError("VISUAL_ASSET_PATH_INVALID", "Visual asset path leaves registry storage.");
  const storageRoot = path.join(root, segments[0]);
  if (fs.existsSync(storageRoot) && fs.lstatSync(storageRoot).isSymbolicLink()) {
    throw new RegistryError("VISUAL_ASSET_PATH_INVALID", "Visual asset storage path is invalid.");
  }
  const boundaryRoot = fs.existsSync(storageRoot) ? storageRoot : root;
  if (!isPathWithin(resolvePathThroughExistingAncestors(boundaryRoot), resolvePathThroughExistingAncestors(target))) throw new RegistryError("VISUAL_ASSET_PATH_INVALID", "Visual asset path leaves registry storage.");
  return target;
}

function mapVisualAssetRow(registry, row) {
  return { id: Number(row.id), entry_id: Number(row.entry_id), source_kind: row.source_kind, source_url: row.source_url, storage_kind: row.storage_kind, captured_at: row.captured_at, status: row.status, sha256: row.sha256, storage_path: row.storage_path, file_path: row.storage_path ? resolveVisualAssetPath(registry, row.storage_path) : null, media_type: row.media_type, byte_size: row.byte_size === null ? null : Number(row.byte_size), position: Number(row.position), is_cover: Boolean(row.is_cover), created_at: row.created_at, updated_at: row.updated_at };
}

function remoteUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || "").trim()); } catch { parsed = null; }
  if (!parsed || !["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new RegistryError("VISUAL_ASSET_SOURCE_URL_INVALID", "Image reference must be a credential-free HTTP(S) URL.");
  parsed.hash = "";
  return parsed.toString();
}
function optionalRemoteUrl(value) { return value === undefined || value === null || String(value).trim() === "" ? null : remoteUrl(value); }
function normalizeSourceKind(value, fallback) { const kind = String(value === undefined ? fallback : value).trim(); if (!SOURCE_KINDS.has(kind)) throw new RegistryError("VISUAL_ASSET_SOURCE_KIND_INVALID", "Visual asset source_kind is invalid.", { sourceKind: kind }); return kind; }
function validateStorageSourceKind(sourceKind, storageKind) {
  if (storageKind === "remote" && ["user_upload", "page_snapshot"].includes(sourceKind)) {
    throw new RegistryError(
      "VISUAL_ASSET_SOURCE_KIND_INVALID",
      "Visual asset source_kind is incompatible with its storage kind.",
      { sourceKind, storageKind }
    );
  }
}
function storageDirectory(value) { const directory = String(value).trim(); if (!directory || directory.includes("/") || directory.includes("\\") || directory === "." || directory === "..") throw new RegistryError("VISUAL_ASSET_PATH_INVALID", "Visual asset storage directory is invalid."); return directory; }
function captureTime(options) { return options.capturedAt ? normalizeTimestamp(options.capturedAt, "captured_at") : nowIso(options.clock || Date); }
function ensureEntry(registry, value) { const id = entryId(value); if (!registry.db.prepare("SELECT 1 FROM entries WHERE id = ?").get(id)) throw new RegistryError("ENTRY_NOT_FOUND", "Entry not found.", { entryId: id }); return id; }
function promoteVisualFocus(registry, entry, updatedAt) { registry.db.prepare("UPDATE entries SET content_focus = 'visual', record_updated_at = ? WHERE id = ?").run(updatedAt, entry); }
function transaction(db, fn) { if (db.isTransaction) return fn(); db.exec("BEGIN IMMEDIATE"); try { const result = fn(); db.exec("COMMIT"); return result; } catch (error) { try { db.exec("ROLLBACK"); } catch { /* no-op */ } throw error; } }
async function sourceFileStat(sourcePath) { try { const stat = await fsp.stat(sourcePath); if (!stat.isFile()) throw new RegistryError("VISUAL_ASSET_SOURCE_INVALID", "Image source must be a regular file."); return stat; } catch (error) { if (error instanceof RegistryError) throw error; throw new RegistryError("VISUAL_ASSET_SOURCE_NOT_FOUND", "Image source was not found."); } }
async function ensureLocalDuplicateIntegrity(registry, asset, sourcePath, expected) {
  const destinationPath = resolveVisualAssetPath(registry, asset.storage_path);
  try {
    const [stat, imageType, digest] = await Promise.all([
      fsp.stat(destinationPath), detectImageFile(destinationPath), hashFile(destinationPath)
    ]);
    if (stat.isFile() && stat.size === Number(asset.byte_size) && digest === asset.sha256 && imageType?.mediaType === asset.media_type) {
      if (asset.status === "ready") return false;
      registry.db.prepare("UPDATE entry_visual_assets SET status = 'ready', updated_at = ? WHERE id = ?")
        .run(nowIso(expected.clock), Number(asset.id));
      return true;
    }
  } catch { /* Replacement bytes repair missing or unreadable content. */ }

  await fsp.mkdir(path.dirname(destinationPath), { recursive: true });
  const repairPath = `${destinationPath}.repair-${randomUUID()}`;
  try {
    await fsp.copyFile(sourcePath, repairPath, fs.constants.COPYFILE_EXCL);
    const [copiedType, copiedStat, copiedHash] = await Promise.all([
      detectImageFile(repairPath),
      fsp.stat(repairPath),
      hashFile(repairPath)
    ]);
    if (
      !copiedType
      || copiedType.mediaType !== expected.mediaType
      || copiedStat.size !== expected.byteSize
      || copiedHash !== expected.sha256
    ) {
      throw new RegistryError("VISUAL_ASSET_SOURCE_CHANGED", "Image source changed while it was copied.");
    }
    await fsp.rename(repairPath, destinationPath);
    registry.db.prepare(`
      UPDATE entry_visual_assets
      SET status = 'ready', sha256 = ?, media_type = ?, byte_size = ?, updated_at = ?
      WHERE id = ?
    `).run(expected.sha256, expected.mediaType, expected.byteSize, nowIso(expected.clock), Number(asset.id));
    return true;
  } catch (error) {
    await fsp.rm(repairPath, { force: true }).catch(() => {});
    if (error instanceof RegistryError) throw error;
    throw new RegistryError("VISUAL_ASSET_ATTACH_FAILED", "Invalid image content could not be repaired.");
  }
}
function inspectLocalAssetSync(asset) {
  try {
    const stat = fs.statSync(asset.file_path);
    if (!stat.isFile() || stat.size !== Number(asset.byte_size)) return false;
    const handle = fs.openSync(asset.file_path, "r");
    const header = Buffer.alloc(32);
    try { fs.readSync(handle, header, 0, header.length, 0); } finally { fs.closeSync(handle); }
    if (detectImageType(header)?.mediaType !== asset.media_type) return false;
    const hash = createHash("sha256");
    const chunk = Buffer.alloc(64 * 1024);
    const file = fs.openSync(asset.file_path, "r");
    try {
      let read;
      while ((read = fs.readSync(file, chunk, 0, chunk.length, null)) > 0) hash.update(chunk.subarray(0, read));
    } finally { fs.closeSync(file); }
    return hash.digest("hex") === asset.sha256;
  } catch {
    return false;
  }
}
async function detectImageFile(filePath) { const handle = await fsp.open(filePath, "r"); try { const header = Buffer.alloc(32); const { bytesRead } = await handle.read(header, 0, header.length, 0); return detectImageType(header.subarray(0, bytesRead)); } finally { await handle.close(); } }
function detectImageType(bytes) { if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { mediaType: "image/png", extension: "png" }; if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { mediaType: "image/jpeg", extension: "jpg" }; const signature6 = bytes.subarray(0, 6).toString("ascii"); if (signature6 === "GIF87a" || signature6 === "GIF89a") return { mediaType: "image/gif", extension: "gif" }; if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return { mediaType: "image/webp", extension: "webp" }; if (bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp" && ["avif", "avis"].includes(bytes.subarray(8, 12).toString("ascii"))) return { mediaType: "image/avif", extension: "avif" }; return null; }
function unsupportedImageError() { return new RegistryError("VISUAL_ASSET_IMAGE_UNSUPPORTED", "Image source must be a PNG, JPEG, GIF, WebP, or AVIF image."); }
function hashFile(filePath) { return new Promise((resolve, reject) => { const hash = createHash("sha256"); const stream = fs.createReadStream(filePath); stream.on("error", reject); stream.on("data", (chunk) => hash.update(chunk)); stream.on("end", () => resolve(hash.digest("hex"))); }); }
module.exports = { addLocalImage, addRemoteImageReference, auditLocalVisualAssets, clearCover, detectImageType, findSavedVisualAssetPresence, getVisualAsset, listVisualAssets, removeVisualAsset, resolveVisualAssetPath, setCover };
