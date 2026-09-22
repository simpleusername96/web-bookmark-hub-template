"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");

const { recordCaptureAssetOutcomes } = require("../registry/captures.js");
const { RegistryError } = require("../registry/errors.js");
const { addLocalImage, getVisualAsset, removeVisualAsset } = require("../registry/visual-assets.js");
const { MAX_LOCAL_IMAGE_BYTES } = require("../registry/visual-asset-contract.js");
const { downloadImageToStaging } = require("./remote-image-downloader.js");

const MAX_CAPTURE_LOCAL_BYTES = 250 * 1024 * 1024;

async function localizeChromeCapture(registry, captureResult, options = {}) {
  const downloadImage = options.downloadImage || downloadImageToStaging;
  const localizedItems = [];
  let localizedBytes = 0;
  for (const item of captureResult.items || []) {
    const assets = [];
    for (const assetResult of item.assets || []) {
      if (!assetResult.visual_asset_id) {
        assets.push(assetResult);
        continue;
      }
      let asset;
      try {
        asset = getVisualAsset(registry, assetResult.visual_asset_id);
      } catch (error) {
        assets.push(assetFailure(assetResult, error));
        continue;
      }
      if (asset.source_kind === "provider_thumbnail" && (
        (asset.storage_kind === "remote" && asset.status === "referenced")
        || (asset.storage_kind === "local" && asset.status === "ready")
      )) {
        assets.push(assetResult);
        continue;
      }
      if (asset.storage_kind === "local" && asset.status === "ready") {
        assets.push({ ...assetResult, outcome_code: assetResult.outcome_code === "downloaded" ? "downloaded" : "local_duplicate" });
        continue;
      }
      if (asset.storage_kind !== "remote" || asset.status !== "referenced" || asset.source_kind !== "browser_selected") {
        assets.push({ ...assetResult, outcome_code: "CAPTURE_IMAGE_REFERENCE_INVALID" });
        continue;
      }
      let staged;
      let local;
      try {
        staged = await downloadImage(registry, asset.source_url, captureDownloadLimit(localizedBytes));
        localizedBytes += Number(staged.byteSize) || 0;
        if (localizedBytes > MAX_CAPTURE_LOCAL_BYTES) {
          throw new RegistryError("CAPTURE_IMAGE_BATCH_TOO_LARGE", "Selected images exceed the local capture limit.");
        }
        local = await addLocalImage(registry, asset.entry_id, staged.filePath, {
          sourceKind: "browser_selected",
          sourceUrl: asset.source_url,
          capturedAt: asset.captured_at,
          makeCover: asset.is_cover,
          clock: options.clock
        });
        try {
          await removeVisualAsset(registry, asset.id, { clock: options.clock });
        } catch (_error) {
          assets.push({
            ...assetResult,
            outcome_code: "CAPTURE_IMAGE_REMOTE_CLEANUP_FAILED",
            local_visual_asset_id: local.asset.id
          });
          continue;
        }
        assets.push({
          asset_index: assetResult.asset_index,
          outcome_code: local.duplicate ? "local_duplicate" : "downloaded",
          visual_asset_id: local.asset.id
        });
      } catch (error) {
        assets.push(assetFailure(assetResult, error));
      } finally {
        if (staged?.filePath) {
          await fsp.rm(staged.filePath, { force: true }).catch(() => {});
          await fsp.rmdir(path.dirname(staged.filePath)).catch(() => {});
        }
      }
    }
    localizedItems.push({ item_index: item.item_index, assets });
  }
  return recordCaptureAssetOutcomes(registry, captureResult, localizedItems, { clock: options.clock });
}

function captureDownloadLimit(localizedBytes) {
  const remainingBytes = MAX_CAPTURE_LOCAL_BYTES - Number(localizedBytes || 0);
  if (remainingBytes < 1) {
    throw new RegistryError("CAPTURE_IMAGE_BATCH_TOO_LARGE", "Selected images exceed the local capture limit.");
  }
  return {
    maxBytes: Math.min(MAX_LOCAL_IMAGE_BYTES, remainingBytes),
    sizeErrorCode: remainingBytes < MAX_LOCAL_IMAGE_BYTES ? "CAPTURE_IMAGE_BATCH_TOO_LARGE" : undefined
  };
}

function assetFailure(assetResult, error) {
  const code = error instanceof RegistryError && /^CAPTURE_|^VISUAL_ASSET_/.test(error.code)
    ? error.code
    : "CAPTURE_IMAGE_DOWNLOAD_FAILED";
  return { ...assetResult, outcome_code: code };
}

module.exports = { MAX_CAPTURE_LOCAL_BYTES, captureDownloadLimit, localizeChromeCapture };
