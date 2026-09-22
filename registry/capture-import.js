"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const { assertRegistry, RegistryError } = require("./errors.js");
const { captureEntries } = require("./captures.js");
const { editEntry, getEntry } = require("./entries.js");
const { getFolder } = require("./folders.js");
const { addLocalImage, addRemoteImageReference } = require("./visual-assets.js");
const { isPathWithin } = require("./database.js");
const { analyzeUrl } = require("./url-policy.js");

const UNSUPPORTED_REMOTE_EXTENSION = /\.(?:avi|html?|m4v|mkv|mov|mp3|mp4|mpeg|mpg|pdf|wav|webm)(?:$|[?#])/i;

async function importCaptureManifest(registry, manifestPath, { folderId, attachAssetsToExisting = false, clock = Date } = {}) {
  const manifest = await validateCaptureManifest(manifestPath);
  const assignedFolderId = folderId === undefined || folderId === null
    ? undefined
    : getFolder(registry, folderId).id;

  const manifestRoot = await resolveManifestRoot(manifestPath);
  const report = {
    counts: {
      entries_created: 0,
      entries_already_saved: 0,
      local_images_added: 0,
      local_images_repaired: 0,
      remote_references_added: 0,
      items_skipped: 0,
      assets_skipped: 0
    },
    items: [],
    skips: []
  };
  const capture = captureEntries(registry, {
    channel: "manifest_import",
    adapter: "legacy-manifest",
    requesterScope: "manifest:cli",
    clientRequestId: randomUUID(),
    items: manifest.items.map((item) => manifestCaptureItem(item, assignedFolderId))
  }, { clock });

  for (const [itemIndex, item] of manifest.items.entries()) {
    const captureItem = capture.items[itemIndex];
    if (!captureItem || captureItem.entry_id === null) {
      addSkip(report, {
        item_index: itemIndex,
        code: captureItem?.outcome_code || "CAPTURE_ITEM_REJECTED"
      });
      report.counts.items_skipped += 1;
      continue;
    }
    if (captureItem.outcome_code === "already_saved") {
      report.counts.entries_already_saved += 1;
      if (attachAssetsToExisting && getEntry(registry, captureItem.entry_id, { includeArchived: true }).deleted_at === null) {
        report.items.push(await importItem(registry, item, itemIndex, captureItem, manifestRoot, {
          folderId: assignedFolderId,
          clock,
          existingEntry: true
        }, report));
      } else {
        report.items.push({ item_index: itemIndex, entry_id: captureItem.entry_id, outcome_code: "already_saved", local_image_ids: [], remote_image_ids: [], skips: [] });
      }
      continue;
    }
    const itemResult = await importItem(registry, item, itemIndex, captureItem, manifestRoot, {
      folderId: assignedFolderId,
      clock
    }, report);
    if (itemResult) {
      report.items.push(itemResult);
    }
  }
  return report;
}

async function validateCaptureManifest(manifestPath) {
  const manifest = await readManifest(manifestPath);
  assertRegistry(Array.isArray(manifest.items), "CAPTURE_MANIFEST_INVALID", "Capture manifest items must be an array.");
  return manifest;
}

async function importItem(registry, item, itemIndex, captureItem, manifestRoot, options, report) {
  const entryId = captureItem.entry_id;
  if (!options.existingEntry) editEntry(registry, entryId, { contentFocus: "visual" }, { clock: options.clock });

  const result = {
    item_index: itemIndex,
    entry_id: entryId,
    outcome_code: captureItem.outcome_code,
    local_image_ids: [],
    remote_image_ids: [],
    skips: []
  };
  if (!options.existingEntry) report.counts.entries_created += 1;

  const remoteCandidates = [];
  const assets = Array.isArray(item.assets) ? item.assets : [];
  for (const [assetIndex, asset] of assets.entries()) {
    const sourceUrl = readAssetSourceUrl(asset);
    if (typeof asset === "string") {
      remoteCandidates.push({ sourceUrl: asset, assetIndex, source: "assets" });
      continue;
    }
    if (!isPlainObject(asset)) {
      addAssetSkip(report, result, itemIndex, assetIndex, "CAPTURE_ASSET_INVALID");
      continue;
    }
    if (sourceUrl) remoteCandidates.push({ sourceUrl, assetIndex, source: "assets" });
    if (asset.relativePath !== undefined) {
      let localPath;
      try {
        localPath = await resolveManifestAssetPath(manifestRoot, asset.relativePath);
      } catch (error) {
        addAssetSkip(report, result, itemIndex, assetIndex, safeCode(error, "CAPTURE_ASSET_PATH_INVALID"));
        continue;
      }
      try {
        const image = await addLocalImage(registry, entryId, localPath, {
          sourceKind: "browser_selected",
          sourceUrl,
          makeCover: result.local_image_ids.length === 0,
          clock: options.clock
        });
        if (!result.local_image_ids.includes(image.asset.id)) result.local_image_ids.push(image.asset.id);
        if (!image.duplicate) report.counts.local_images_added += 1;
        if (image.repaired) report.counts.local_images_repaired += 1;
      } catch (error) {
        addAssetSkip(report, result, itemIndex, assetIndex, safeCode(error, "CAPTURE_ASSET_REJECTED"));
      }
      continue;
    }
  }

  for (const [assetIndex, sourceUrl] of normalizeUrlCandidates(item.mediaUrls).entries()) {
    remoteCandidates.push({ sourceUrl, assetIndex, source: "media_urls" });
  }
  for (const [assetIndex] of normalizeUrlCandidates(item.downloadableUrls).entries()) {
    addAssetSkip(report, result, itemIndex, assetIndex, "CAPTURE_DOWNLOADABLE_IGNORED", "downloadable_urls");
  }

  if (result.local_image_ids.length === 0) {
    const candidate = firstValidRemoteCandidate(remoteCandidates, report, result, itemIndex);
    if (candidate) {
      try {
        const image = await addRemoteImageReference(registry, entryId, candidate.sourceUrl, {
          sourceKind: "browser_selected",
          clock: options.clock
        });
        if (!result.remote_image_ids.includes(image.asset.id)) result.remote_image_ids.push(image.asset.id);
        if (!image.duplicate) report.counts.remote_references_added += 1;
      } catch (error) {
        addAssetSkip(report, result, itemIndex, candidate.assetIndex, safeCode(error, "CAPTURE_REMOTE_REFERENCE_REJECTED"), candidate.source);
      }
    }
  }
  return result;
}

function manifestCaptureItem(item, folderId) {
  if (!isPlainObject(item)) {
    return item;
  }
  return {
    entryUrl: item.postUrl,
    selectedAt: firstPresent(item.savedAt, item.selectedAt, item.capturedAt),
    publishedAt: firstPresent(item.dateISO),
    ...(folderId === undefined || folderId === null ? {} : { folderId })
  };
}

function firstValidRemoteCandidate(candidates, report, result, itemIndex) {
  for (const candidate of candidates) {
    if (typeof candidate.sourceUrl !== "string" || !candidate.sourceUrl.trim()) {
      addAssetSkip(report, result, itemIndex, candidate.assetIndex, "CAPTURE_REMOTE_URL_INVALID", candidate.source);
      continue;
    }
    if (UNSUPPORTED_REMOTE_EXTENSION.test(candidate.sourceUrl)) {
      addAssetSkip(report, result, itemIndex, candidate.assetIndex, "CAPTURE_REMOTE_MEDIA_UNSUPPORTED", candidate.source);
      continue;
    }
    try {
      analyzeUrl(candidate.sourceUrl);
      return candidate;
    } catch (error) {
      addAssetSkip(report, result, itemIndex, candidate.assetIndex, safeCode(error, "CAPTURE_REMOTE_URL_INVALID"), candidate.source);
    }
  }
  return null;
}

async function readManifest(manifestPath) {
  let source;
  try {
    source = await fsp.readFile(String(manifestPath), "utf8");
  } catch {
    throw new RegistryError("CAPTURE_MANIFEST_NOT_FOUND", "Capture manifest could not be read.");
  }
  try {
    const parsed = JSON.parse(source);
    assertRegistry(isPlainObject(parsed), "CAPTURE_MANIFEST_INVALID", "Capture manifest must be a JSON object.");
    return parsed;
  } catch (error) {
    if (error instanceof RegistryError) throw error;
    throw new RegistryError("CAPTURE_MANIFEST_INVALID", "Capture manifest must contain valid JSON.");
  }
}

async function resolveManifestRoot(manifestPath) {
  let resolvedManifest;
  try {
    resolvedManifest = await fsp.realpath(String(manifestPath));
  } catch {
    throw new RegistryError("CAPTURE_MANIFEST_NOT_FOUND", "Capture manifest could not be read.");
  }
  return path.dirname(resolvedManifest);
}

async function resolveManifestAssetPath(manifestRoot, relativePath) {
  if (typeof relativePath !== "string" || !relativePath.trim() || path.isAbsolute(relativePath)) {
    throw new RegistryError("CAPTURE_ASSET_PATH_INVALID", "Capture asset path is invalid.");
  }
  const segments = relativePath.split(/[\\/]+/);
  if (segments.includes("..") || segments.includes("")) {
    throw new RegistryError("CAPTURE_ASSET_PATH_INVALID", "Capture asset path is invalid.");
  }
  const candidate = path.resolve(manifestRoot, ...segments);
  if (!isPathWithin(manifestRoot, candidate)) {
    throw new RegistryError("CAPTURE_ASSET_PATH_INVALID", "Capture asset path leaves the manifest directory.");
  }
  let resolved;
  try {
    resolved = await fsp.realpath(candidate);
    const stat = await fsp.stat(resolved);
    if (!stat.isFile()) throw new Error("not a file");
  } catch {
    throw new RegistryError("CAPTURE_ASSET_NOT_FOUND", "Capture asset image was not found.");
  }
  if (!isPathWithin(manifestRoot, resolved)) {
    throw new RegistryError("CAPTURE_ASSET_PATH_INVALID", "Capture asset path leaves the manifest directory.");
  }
  return resolved;
}

function readAssetSourceUrl(asset) {
  if (!isPlainObject(asset)) return undefined;
  return asset.sourceUrl ?? asset.source_url ?? asset.url;
}

function normalizeUrlCandidates(value) {
  return Array.isArray(value) ? value.map((item) => typeof item === "string" ? item : readAssetSourceUrl(item)) : [];
}

function addAssetSkip(report, item, itemIndex, assetIndex, code, source) {
  const skip = { item_index: itemIndex, asset_index: assetIndex, code };
  if (source) skip.source = source;
  item.skips.push(skip);
  addSkip(report, skip);
  report.counts.assets_skipped += 1;
}

function addSkip(report, skip) {
  report.skips.push(skip);
}

function safeCode(error, fallback) {
  return error instanceof RegistryError && typeof error.code === "string" ? error.code : fallback;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function firstPresent(...values) {
  return values.find((value) => typeof value === "string" && value.trim())?.trim();
}

module.exports = {
  importCaptureManifest,
  resolveManifestAssetPath,
  validateCaptureManifest
};
