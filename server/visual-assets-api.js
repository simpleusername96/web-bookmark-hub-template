"use strict";

const {
  clearCover,
  listVisualAssets,
  removeVisualAsset,
  setCover
} = require("../registry/visual-assets.js");
const { assertAllowedFields, assertPlainObject } = require("./entries-api.js");

function listEntryVisualAssets(registry, entryId) {
  return listVisualAssets(registry, entryId).map(publicVisualAsset);
}

function setVisualAssetCover(registry, assetId, body, options = {}) {
  assertEmptyBody(body);
  return publicVisualAsset(setCover(registry, assetId, options));
}

function clearEntryCover(registry, entryId, body, options = {}) {
  assertEmptyBody(body);
  return clearCover(registry, entryId, options).map(publicVisualAsset);
}

async function removeVisualAssetFromApi(registry, assetId, body, options = {}) {
  assertEmptyBody(body);
  return publicVisualAsset(await removeVisualAsset(registry, assetId, options));
}

function publicVisualAsset(asset) {
  return {
    id: asset.id,
    entry_id: asset.entry_id,
    source_kind: asset.source_kind,
    source_url: asset.source_url,
    storage_kind: asset.storage_kind,
    captured_at: asset.captured_at,
    status: asset.status,
    media_type: asset.media_type,
    byte_size: asset.byte_size,
    position: asset.position,
    is_cover: asset.is_cover,
    created_at: asset.created_at,
    updated_at: asset.updated_at,
    removed: asset.removed,
    file_removed: asset.file_removed
  };
}

function assertEmptyBody(body) {
  assertPlainObject(body, "Visual Asset mutation body must be an object.");
  assertAllowedFields(body, new Set());
}

module.exports = {
  clearEntryCover,
  listEntryVisualAssets,
  publicVisualAsset,
  removeVisualAssetFromApi,
  setVisualAssetCover
};
