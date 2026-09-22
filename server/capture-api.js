"use strict";

const { captureEntries } = require("../registry/captures.js");
const { getCapturePolicy } = require("../registry/capture-policy.js");
const { RegistryError } = require("../registry/errors.js");
const { getEntry } = require("../registry/entries.js");
const { findSavedVisualAssetPresence } = require("../registry/visual-assets.js");
const { localizeChromeCapture } = require("./capture-downloads.js");
const { assertAllowedFields, assertPlainObject } = require("./entries-api.js");

const CAPTURE_BODY_FIELDS = new Set(["adapter", "items"]);
const CAPTURE_ITEM_FIELDS = new Set([
  "entryUrl", "title", "publishedAt", "selectedAt", "assetUrls",
  "comment", "tags", "folderId", "kind", "contentFocus", "visibility", "agentAccess", "aiProcessing"
]);
const CAPTURE_PRESENCE_LIMIT = 100;
const CAPTURE_PRESENCE_BODY_FIELDS = new Set(["items"]);
const CAPTURE_PRESENCE_ITEM_FIELDS = new Set(["entryUrl", "assetUrl", "assetUrls"]);

async function captureFromChrome(registry, body, { client, clientRequestId, clock = Date, downloadImage }) {
  assertPlainObject(body, "Capture request body must be an object.");
  assertAllowedFields(body, CAPTURE_BODY_FIELDS);
  const items = Array.isArray(body.items)
    ? body.items.map((item) => publicCaptureItem(item))
    : body.items;
  const capture = captureEntries(registry, {
    channel: "chrome",
    adapter: body.adapter || "generic",
    requesterScope: `client:${client.id}`,
    clientRequestId,
    items
  }, { clock });
  const selectedImageStorage = getCapturePolicy(registry).selected_image_storage || "reference_only";
  const result = selectedImageStorage === "reference_only"
    ? capture
    : await localizeChromeCapture(registry, capture, { clock, downloadImage });
  return body.adapter === "current-tab" ? withShortcutEnrichmentState(registry, result) : result;
}

function withShortcutEnrichmentState(registry, capture) {
  return {
    ...capture,
    items: capture.items.map((item) => {
      if (!item.entry_id) return item;
      const entry = getEntry(registry, item.entry_id, { includeArchived: true });
      const allowed = !entry.deleted_at && entry.visibility === "normal"
        && entry.agent_access === "allowed" && ["manual", "enabled"].includes(entry.ai_processing);
      return {
        ...item,
        enrichment: {
          allowed,
          needs_summary: allowed && !entry.latest_summary,
          reason: allowed ? (entry.latest_summary ? "already_summarized" : null) : "policy_blocked"
        }
      };
    })
  };
}

function capturePresenceFromChrome(registry, body) {
  assertPlainObject(body, "Capture presence body must be an object.");
  assertAllowedFields(body, CAPTURE_PRESENCE_BODY_FIELDS);
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > CAPTURE_PRESENCE_LIMIT) {
    throw new RegistryError(
      "CAPTURE_PRESENCE_LIMIT_INVALID",
      `Capture presence requires 1-${CAPTURE_PRESENCE_LIMIT} items.`
    );
  }
  const items = body.items.map((item) => {
    assertPlainObject(item, "Capture presence item must be an object.");
    assertAllowedFields(item, CAPTURE_PRESENCE_ITEM_FIELDS);
    return { entryUrl: item.entryUrl, assetUrl: item.assetUrl, assetUrls: item.assetUrls };
  });
  return { saved: findSavedVisualAssetPresence(registry, items) };
}

function publicCaptureItem(item) {
  assertPlainObject(item, "Capture item must be an object.");
  assertAllowedFields(item, CAPTURE_ITEM_FIELDS);
  return {
    entryUrl: item.entryUrl,
    title: item.title,
    publishedAt: item.publishedAt,
    selectedAt: item.selectedAt,
    assetUrls: item.assetUrls,
    comment: item.comment,
    tags: item.tags,
    folderId: item.folderId,
    kind: item.kind,
    contentFocus: item.contentFocus,
    visibility: item.visibility,
    agentAccess: item.agentAccess,
    aiProcessing: item.aiProcessing
  };
}

module.exports = {
  CAPTURE_PRESENCE_LIMIT,
  captureFromChrome,
  capturePresenceFromChrome,
  publicCaptureItem
};
