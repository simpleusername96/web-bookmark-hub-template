"use strict";

const {
  addLocalImage,
  detectImageType,
  getVisualAsset,
  listVisualAssets,
  removeVisualAsset,
  resolveVisualAssetPath
} = require("./visual-assets.js");
const { RegistryError } = require("./errors.js");
const { positiveInteger } = require("./values.js");

async function attachSnapshot(registry, entryId, sourceFile, options = {}) {
  try {
    const result = await addLocalImage(registry, entryId, sourceFile, {
      capturedAt: options.capturedAt,
      clock: options.clock,
      sourceKind: "page_snapshot",
      storageDirectory: "snapshots",
      allowDuplicate: true
    });
    return mapSnapshot(result.asset);
  } catch (error) {
    throw snapshotError(error);
  }
}

function listSnapshots(registry, entryId) {
  return listVisualAssets(registry, entryId)
    .filter((asset) => asset.source_kind === "page_snapshot")
    .sort((left, right) => right.captured_at.localeCompare(left.captured_at) || right.id - left.id)
    .map(mapSnapshot);
}

function getSnapshot(registry, snapshotId) {
  let asset;
  try {
    asset = getVisualAsset(registry, snapshotId);
  } catch (error) {
    if (error instanceof RegistryError && error.code === "VISUAL_ASSET_NOT_FOUND") {
      throw new RegistryError("SNAPSHOT_NOT_FOUND", "Snapshot not found.", {
        snapshotId: positiveInteger(snapshotId, "snapshot_id")
      });
    }
    throw error;
  }
  if (asset.source_kind !== "page_snapshot") {
    throw new RegistryError("SNAPSHOT_NOT_FOUND", "Snapshot not found.", { snapshotId: positiveInteger(snapshotId, "snapshot_id") });
  }
  return mapSnapshot(asset);
}

async function removeSnapshot(registry, snapshotId) {
  const asset = getSnapshot(registry, snapshotId);
  try {
    return mapSnapshot(await removeVisualAsset(registry, asset.id));
  } catch (error) {
    throw snapshotError(error);
  }
}

function resolveSnapshotPath(registry, storagePath) {
  try {
    return resolveVisualAssetPath(registry, storagePath);
  } catch (error) {
    if (error.code === "VISUAL_ASSET_PATH_INVALID") {
      throw new RegistryError("SNAPSHOT_PATH_INVALID", "Snapshot path leaves registry storage.");
    }
    throw error;
  }
}

function mapSnapshot(asset) {
  const result = {
    id: asset.id,
    entry_id: asset.entry_id,
    captured_at: asset.captured_at,
    status: asset.status,
    sha256: asset.sha256,
    storage_path: asset.storage_path,
    file_path: asset.file_path,
    media_type: asset.media_type,
    byte_size: asset.byte_size,
    created_at: asset.created_at
  };
  if (asset.removed !== undefined) {
    result.removed = asset.removed;
    result.file_removed = asset.file_removed;
  }
  return result;
}

function snapshotError(error) {
  if (!(error instanceof RegistryError)) return error;
  const code = {
    VISUAL_ASSET_STORAGE_UNAVAILABLE: "SNAPSHOT_STORAGE_UNAVAILABLE",
    VISUAL_ASSET_SOURCE_NOT_FOUND: "SNAPSHOT_SOURCE_NOT_FOUND",
    VISUAL_ASSET_SOURCE_INVALID: "SNAPSHOT_SOURCE_INVALID",
    VISUAL_ASSET_IMAGE_INVALID: "SNAPSHOT_IMAGE_INVALID",
    VISUAL_ASSET_IMAGE_UNSUPPORTED: "SNAPSHOT_IMAGE_UNSUPPORTED",
    VISUAL_ASSET_SOURCE_CHANGED: "SNAPSHOT_SOURCE_CHANGED",
    VISUAL_ASSET_ATTACH_FAILED: "SNAPSHOT_ATTACH_FAILED",
    VISUAL_ASSET_ATTACH_BUSY: "SNAPSHOT_ATTACH_BUSY",
    VISUAL_ASSET_REMOVE_BUSY: "SNAPSHOT_REMOVE_BUSY",
    VISUAL_ASSET_REMOVE_FAILED: "SNAPSHOT_REMOVE_FAILED"
  }[error.code];
  if (!code) return error;
  const details = error.details?.visualAssetId === undefined
    ? error.details
    : { ...error.details, snapshotId: error.details.visualAssetId };
  if (details?.visualAssetId !== undefined) delete details.visualAssetId;
  return new RegistryError(code, error.message, details);
}

module.exports = { attachSnapshot, detectImageType, getSnapshot, listSnapshots, removeSnapshot, resolveSnapshotPath };
