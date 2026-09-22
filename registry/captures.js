"use strict";

const { createHash } = require("node:crypto");

const { withTransaction } = require("./database.js");
const { addComment } = require("./comments.js");
const { addEntry } = require("./entries.js");
const { RegistryError } = require("./errors.js");
const { nowIso, parseStoredJson } = require("./values.js");
const { addTags, uniqueTags } = require("./tags.js");
const { addRemoteImageReference } = require("./visual-assets.js");
const { deriveProviderThumbnail } = require("./provider-thumbnails.js");
const { resolveCapturePolicy } = require("./capture-policy.js");
const {
  AGENT_ACCESS_LEVELS,
  AI_PROCESSING_MODES,
  ENTRY_KINDS,
  canonicalEntryKind,
  VISIBILITIES
} = require("./constants.js");

const CAPTURE_CHANNELS = Object.freeze(["web", "chrome", "manifest_import"]);
const MAX_CAPTURE_ITEMS = 100;
const MAX_ASSETS_PER_ITEM = 100;
const MAX_URL_LENGTH = 8192;
const MAX_TITLE_LENGTH = 1000;
const MAX_ADAPTER_LENGTH = 120;
const MAX_SCOPE_LENGTH = 200;
const MAX_TAGS_PER_ITEM = 50;
const MAX_COMMENT_LENGTH = 20000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUESTER_SCOPE = /^[a-z][a-z0-9_-]{0,31}:[A-Za-z0-9._-]+$/;
const VISUAL_TEMPLATE_ADAPTERS = new Set(["pinterest-pin-grid", "x-media"]);
const PROVIDER_THUMBNAIL_ADAPTERS = new Set(["web-add-url", "current-tab"]);

function captureEntries(registry, input, { clock = Date } = {}) {
  const request = normalizeCaptureRequest(input);
  const payloadSha256 = fingerprintRequest(request);

  return withTransaction(registry.db, () => {
    const existing = registry.db.prepare(`
      SELECT * FROM capture_requests
      WHERE requester_scope = ? AND client_request_id = ?
    `).get(request.requesterScope, request.clientRequestId);
    if (existing) {
      if (existing.payload_sha256 !== payloadSha256) {
        throw new RegistryError(
          "CAPTURE_REQUEST_CONFLICT",
          "The capture request ID was already used with different content.",
          { clientRequestId: request.clientRequestId }
        );
      }
      if (existing.state !== "completed") {
        throw new RegistryError(
          "CAPTURE_REQUEST_INCOMPLETE",
          "The capture request has no completed result.",
          { clientRequestId: request.clientRequestId }
        );
      }
      return readCaptureResult(registry, existing, true);
    }

    const requestedAt = nowIso(clock);
    const inserted = registry.db.prepare(`
      INSERT INTO capture_requests (
        requester_scope, client_request_id, payload_sha256, channel, adapter,
        state, item_count, requested_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, 'processing', ?, ?, NULL)
    `).run(
      request.requesterScope,
      request.clientRequestId,
      payloadSha256,
      request.channel,
      request.adapter,
      request.items.length,
      requestedAt
    );
    const requestId = Number(inserted.lastInsertRowid);

    for (const [itemIndex, item] of request.items.entries()) {
      processCaptureItem(registry, request, requestId, itemIndex, item, clock);
    }

    const completedAt = nowIso(clock);
    registry.db.prepare(`
      UPDATE capture_requests
      SET state = 'completed', completed_at = ?
      WHERE id = ?
    `).run(completedAt, requestId);
    const completed = registry.db.prepare("SELECT * FROM capture_requests WHERE id = ?").get(requestId);
    return readCaptureResult(registry, completed, false);
  });
}

function processCaptureItem(registry, request, requestId, itemIndex, item, clock) {
  const recordedAt = nowIso(clock);
  if (item.errorCode) {
    recordItem(registry, requestId, itemIndex, item.errorCode, null, {}, recordedAt);
    return;
  }

  const providerThumbnail = PROVIDER_THUMBNAIL_ADAPTERS.has(request.adapter)
    ? deriveProviderThumbnail(item.entryUrl)
    : null;
  let created;
  let resolvedTags = item.tags;
  try {
    const policy = resolveCapturePolicy(registry, item.entryUrl, {
      visibility: item.visibility,
      agentAccess: item.agentAccess,
      aiProcessing: item.aiProcessing,
      kind: item.kind
    }, item.assetUrls.length ? "selected_images" : "page");
    resolvedTags = uniqueTags([...(policy.defaultTags || []), ...item.tags]).map((tag) => tag.name);
    created = addEntry(registry, {
      url: item.entryUrl,
      title: request.channel === "chrome" || VISUAL_TEMPLATE_ADAPTERS.has(request.adapter) ? undefined : item.title,
      kind: policy.kind,
      publishedAt: item.publishedAt,
      savedAt: item.selectedAt,
      folderId: item.folderId,
      contentFocus: item.assetUrls.length || providerThumbnail ? "visual" : item.contentFocus,
      visibility: policy.visibility,
      agentAccess: policy.agentAccess,
      aiProcessing: policy.aiProcessing
    }, {
      clock,
      provenance: {
        createdVia: request.channel,
        captureAdapter: request.adapter,
        captureRequestId: requestId,
        captureItemIndex: itemIndex
      }
    });
  } catch (error) {
    if (!(error instanceof RegistryError)) {
      throw error;
    }
    recordItem(registry, requestId, itemIndex, error.code, null, {}, recordedAt);
    return;
  }

  const reusedEntry = created.outcome_code === "already_saved";
  if (reusedEntry && (created.entry.deleted_at || (item.assetUrls.length === 0 && !providerThumbnail))) {
    recordItem(registry, requestId, itemIndex, "already_saved", created.entry.id, {
      assets: [],
      archived: Boolean(created.entry.deleted_at)
    }, recordedAt);
    return;
  }

  if (!reusedEntry && resolvedTags.length) {
    addTags(registry, created.entry.id, resolvedTags, { clock });
  }
  if (!reusedEntry && item.comment !== undefined) {
    addComment(registry, created.entry.id, item.comment, { clock });
  }

  const assets = [];
  for (const [assetIndex, candidate] of item.assetUrls.entries()) {
    if (candidate.errorCode) {
      assets.push({ asset_index: assetIndex, outcome_code: candidate.errorCode });
      continue;
    }
    try {
      const attached = addRemoteImageReference(registry, created.entry.id, candidate.url, {
        sourceKind: "browser_selected",
        clock
      });
      assets.push({
        asset_index: assetIndex,
        outcome_code: attached.duplicate ? "duplicate" : "attached",
        visual_asset_id: attached.asset.id
      });
    } catch (error) {
      if (!(error instanceof RegistryError)) {
        throw error;
      }
      assets.push({ asset_index: assetIndex, outcome_code: error.code });
    }
  }
  if (providerThumbnail) {
    const assetIndex = item.assetUrls.length;
    try {
      const attached = addRemoteImageReference(registry, created.entry.id, providerThumbnail.sourceUrl, {
        sourceKind: providerThumbnail.sourceKind,
        clock
      });
      assets.push({
        asset_index: assetIndex,
        outcome_code: attached.duplicate ? "duplicate" : "attached",
        visual_asset_id: attached.asset.id
      });
    } catch (error) {
      if (!(error instanceof RegistryError)) throw error;
      assets.push({ asset_index: assetIndex, outcome_code: error.code });
    }
  }
  const hasAssetSkips = assets.some((asset) => !["attached", "duplicate"].includes(asset.outcome_code));
  const outcomeCode = reusedEntry
    ? (hasAssetSkips ? "already_saved_with_asset_skips" : "already_saved")
    : (hasAssetSkips ? "created_with_asset_skips" : "created");
  recordItem(registry, requestId, itemIndex, outcomeCode, created.entry.id, {
    assets,
    archived: Boolean(created.entry.deleted_at)
  }, recordedAt);
}

function recordItem(registry, requestId, itemIndex, outcomeCode, entryId, details, recordedAt) {
  registry.db.prepare(`
    INSERT INTO capture_request_items (
      request_id, item_index, outcome_code, entry_id, details_json, recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(requestId, itemIndex, outcomeCode, entryId, JSON.stringify(details), recordedAt);
}

function readCaptureResult(registry, requestRow, replayed) {
  const items = registry.db.prepare(`
    SELECT item_index, outcome_code, entry_id, details_json
    FROM capture_request_items
    WHERE request_id = ?
    ORDER BY item_index ASC
  `).all(requestRow.id).map((row) => {
    const details = parseStoredJson(row.details_json, {});
    return {
      item_index: Number(row.item_index),
      outcome_code: row.outcome_code,
      entry_id: row.entry_id === null ? null : Number(row.entry_id),
      assets: Array.isArray(details.assets) ? details.assets : [],
      archived: details.archived === true
    };
  });
  return {
    request: {
      id: Number(requestRow.id),
      client_request_id: requestRow.client_request_id,
      channel: requestRow.channel,
      adapter: requestRow.adapter,
      state: requestRow.state,
      item_count: Number(requestRow.item_count),
      requested_at: requestRow.requested_at,
      completed_at: requestRow.completed_at
    },
    replayed,
    counts: summarizeItems(items),
    items
  };
}

function summarizeItems(items) {
  const assets = items.flatMap((item) => item.assets);
  return {
    entries_created: items.filter((item) => ["created", "created_with_asset_skips"].includes(item.outcome_code)).length,
    entries_already_saved: items.filter((item) => ["already_saved", "already_saved_with_asset_skips"].includes(item.outcome_code)).length,
    items_skipped: items.filter((item) => item.entry_id === null).length,
    remote_references_added: assets.filter((asset) => asset.outcome_code === "attached").length,
    remote_references_reused: assets.filter((asset) => asset.outcome_code === "duplicate").length,
    local_images_added: assets.filter((asset) => asset.outcome_code === "downloaded").length,
    local_images_reused: assets.filter((asset) => asset.outcome_code === "local_duplicate").length,
    assets_skipped: assets.filter((asset) => !assetOutcomeSucceeded(asset.outcome_code)).length
  };
}

function recordCaptureAssetOutcomes(registry, captureResult, localizedItems, { clock = Date } = {}) {
  const requestId = Number(captureResult?.request?.id);
  if (!Number.isSafeInteger(requestId) || requestId < 1 || !Array.isArray(localizedItems)) {
    throw new RegistryError("CAPTURE_RESULT_INVALID", "Capture localization result is invalid.");
  }
  return withTransaction(registry.db, () => {
    const request = registry.db.prepare("SELECT * FROM capture_requests WHERE id = ? AND state = 'completed'").get(requestId);
    if (!request) throw new RegistryError("CAPTURE_REQUEST_INCOMPLETE", "Capture request is not ready for image localization.");
    for (const item of localizedItems) {
      const itemIndex = Number(item?.item_index);
      const row = registry.db.prepare(`
        SELECT outcome_code, entry_id, details_json
        FROM capture_request_items
        WHERE request_id = ? AND item_index = ?
      `).get(requestId, itemIndex);
      if (!row || row.entry_id === null || ![
        "created", "created_with_asset_skips", "already_saved", "already_saved_with_asset_skips"
      ].includes(row.outcome_code)) continue;
      const details = parseStoredJson(row.details_json, {});
      const assets = normalizeRecordedAssets(item.assets);
      const reusedEntry = row.outcome_code.startsWith("already_saved");
      const complete = assets.every((asset) => assetOutcomeSucceeded(asset.outcome_code));
      const outcomeCode = reusedEntry
        ? (complete ? "already_saved" : "already_saved_with_asset_skips")
        : (complete ? "created" : "created_with_asset_skips");
      registry.db.prepare(`
        UPDATE capture_request_items
        SET outcome_code = ?, details_json = ?, recorded_at = ?
        WHERE request_id = ? AND item_index = ?
      `).run(outcomeCode, JSON.stringify({ ...details, assets }), nowIso(clock), requestId, itemIndex);
    }
    const updated = registry.db.prepare("SELECT * FROM capture_requests WHERE id = ?").get(requestId);
    return readCaptureResult(registry, updated, Boolean(captureResult.replayed));
  });
}

function normalizeRecordedAssets(value) {
  if (!Array.isArray(value)) throw new RegistryError("CAPTURE_RESULT_INVALID", "Capture asset localization result is invalid.");
  return value.map((asset) => {
    const assetIndex = Number(asset?.asset_index);
    const outcomeCode = String(asset?.outcome_code || "");
    if (!Number.isSafeInteger(assetIndex) || assetIndex < 0 || !/^[A-Z0-9_]+$|^[a-z_]+$/.test(outcomeCode)) {
      throw new RegistryError("CAPTURE_RESULT_INVALID", "Capture asset localization result is invalid.");
    }
    const normalized = { asset_index: assetIndex, outcome_code: outcomeCode };
    for (const field of ["visual_asset_id", "local_visual_asset_id"]) {
      if (asset?.[field] === undefined || asset[field] === null) continue;
      const id = Number(asset[field]);
      if (!Number.isSafeInteger(id) || id < 1) throw new RegistryError("CAPTURE_RESULT_INVALID", "Capture Visual Asset identity is invalid.");
      normalized[field] = id;
    }
    return normalized;
  });
}

function assetOutcomeSucceeded(value) {
  return ["attached", "duplicate", "downloaded", "local_duplicate"].includes(value);
}

function normalizeCaptureRequest(input) {
  if (!isPlainObject(input)) {
    throw new RegistryError("VALIDATION_ERROR", "capture request must be an object.");
  }
  const channel = String(input.channel || "").trim();
  if (!CAPTURE_CHANNELS.includes(channel)) {
    throw new RegistryError("VALIDATION_ERROR", "capture channel is invalid.", {
      field: "channel",
      allowed: CAPTURE_CHANNELS
    });
  }
  const requesterScope = boundedRequiredString(input.requesterScope, "requester_scope", MAX_SCOPE_LENGTH);
  if (!REQUESTER_SCOPE.test(requesterScope)) {
    throw new RegistryError("VALIDATION_ERROR", "requester_scope is invalid.", {
      field: "requester_scope"
    });
  }
  const clientRequestId = String(input.clientRequestId || "").trim().toLocaleLowerCase("en-US");
  if (!UUID.test(clientRequestId)) {
    throw new RegistryError("VALIDATION_ERROR", "client_request_id must be a UUID.", {
      field: "client_request_id"
    });
  }
  const adapter = normalizeAdapter(input.adapter);
  if (!Array.isArray(input.items) || input.items.length < 1) {
    throw new RegistryError("VALIDATION_ERROR", "capture items must be a non-empty array.", {
      field: "items"
    });
  }
  if (input.items.length > MAX_CAPTURE_ITEMS) {
    throw new RegistryError("CAPTURE_ITEM_LIMIT_EXCEEDED", "capture request has too many items.", {
      maxItems: MAX_CAPTURE_ITEMS
    });
  }
  return {
    channel,
    requesterScope,
    clientRequestId,
    adapter,
    items: input.items.map(normalizeCaptureItem)
  };
}

function normalizeCaptureItem(value) {
  if (!isPlainObject(value)) {
    return {
      fingerprint: { invalid_type: typeName(value) },
      errorCode: "CAPTURE_ITEM_INVALID"
    };
  }
  const url = boundedItemString(value.entryUrl, MAX_URL_LENGTH, {
    required: true,
    invalidCode: "CAPTURE_ITEM_URL_INVALID",
    missingCode: "CAPTURE_ITEM_URL_REQUIRED",
    tooLongCode: "CAPTURE_ITEM_URL_TOO_LONG"
  });
  const title = boundedItemString(value.title, MAX_TITLE_LENGTH, {
    invalidCode: "CAPTURE_ITEM_TITLE_INVALID",
    tooLongCode: "CAPTURE_ITEM_TITLE_TOO_LONG"
  });
  const publishedAt = boundedItemString(value.publishedAt, 100, {
    invalidCode: "CAPTURE_ITEM_TIMESTAMP_INVALID",
    tooLongCode: "CAPTURE_ITEM_TIMESTAMP_INVALID"
  });
  const selectedAt = boundedItemString(value.selectedAt, 100, {
    invalidCode: "CAPTURE_ITEM_TIMESTAMP_INVALID",
    tooLongCode: "CAPTURE_ITEM_TIMESTAMP_INVALID"
  });
  const assetUrls = normalizeAssetUrls(value.assetUrls);
  const folderId = normalizeFolderInput(value.folderId);
  const kind = normalizeKindInput(value.kind);
  const contentFocus = normalizeContentFocusInput(value.contentFocus);
  const tags = normalizeTagsInput(value.tags);
  const comment = boundedItemString(value.comment, MAX_COMMENT_LENGTH, {
    invalidCode: "CAPTURE_ITEM_COMMENT_INVALID",
    tooLongCode: "CAPTURE_ITEM_COMMENT_TOO_LONG"
  });
  const visibility = normalizePolicyInput(value.visibility, VISIBILITIES, "VISIBILITY");
  const agentAccess = normalizePolicyInput(value.agentAccess, AGENT_ACCESS_LEVELS, "AGENT_ACCESS");
  const aiProcessing = normalizePolicyInput(value.aiProcessing, AI_PROCESSING_MODES, "AI_PROCESSING");
  const firstError = [
    url, title, publishedAt, selectedAt, assetUrls, folderId, kind, contentFocus, tags, comment,
    visibility, agentAccess, aiProcessing
  ]
    .find((part) => part.errorCode);
  const fingerprint = {
    entryUrl: url.fingerprint,
    title: title.fingerprint,
    publishedAt: publishedAt.fingerprint,
    selectedAt: selectedAt.fingerprint,
    folderId: folderId.fingerprint,
    kind: kind.fingerprint,
    contentFocus: contentFocus.fingerprint,
    tags: tags.fingerprint,
    comment: comment.fingerprint,
    visibility: visibility.fingerprint,
    agentAccess: agentAccess.fingerprint,
    aiProcessing: aiProcessing.fingerprint,
    assetUrls: assetUrls.fingerprint
  };
  if (firstError) {
    return { fingerprint, errorCode: firstError.errorCode };
  }
  return {
    fingerprint,
    entryUrl: url.value,
    title: title.value,
    publishedAt: publishedAt.value,
    selectedAt: selectedAt.value,
    folderId: folderId.value,
    kind: kind.value,
    contentFocus: contentFocus.value,
    tags: tags.value,
    comment: comment.value,
    visibility: visibility.value,
    agentAccess: agentAccess.value,
    aiProcessing: aiProcessing.value,
    assetUrls: assetUrls.value
  };
}

function normalizePolicyInput(value, allowed, label) {
  if (value === undefined || value === null || value === "") {
    return { value: undefined, fingerprint: null };
  }
  if (typeof value !== "string" || !allowed.includes(value.trim().toLowerCase())) {
    return { errorCode: `CAPTURE_ITEM_${label}_INVALID`, fingerprint: typeName(value) };
  }
  const normalized = value.trim().toLowerCase();
  return { value: normalized, fingerprint: normalized };
}

function normalizeKindInput(value) {
  if (value === undefined || value === null || value === "") {
    return { value: undefined, fingerprint: null };
  }
  if (typeof value !== "string") {
    return { errorCode: "CAPTURE_ITEM_KIND_INVALID", fingerprint: typeName(value) };
  }
  const normalized = canonicalEntryKind(value);
  if (!ENTRY_KINDS.includes(normalized)) {
    return { errorCode: "CAPTURE_ITEM_KIND_INVALID", fingerprint: typeName(value) };
  }
  return { value: normalized, fingerprint: normalized };
}

function normalizeContentFocusInput(value) {
  if (value === undefined || value === null || value === "") {
    return { value: "text", fingerprint: null };
  }
  if (typeof value !== "string" || !["text", "visual"].includes(value.trim().toLowerCase())) {
    return { errorCode: "CAPTURE_ITEM_CONTENT_FOCUS_INVALID", fingerprint: typeName(value) };
  }
  const normalized = value.trim().toLowerCase();
  return { value: normalized, fingerprint: normalized };
}

function normalizeTagsInput(value) {
  if (value === undefined) {
    return { value: [], fingerprint: [] };
  }
  if (!Array.isArray(value) || value.length > MAX_TAGS_PER_ITEM) {
    return {
      errorCode: "CAPTURE_ITEM_TAGS_INVALID",
      fingerprint: Array.isArray(value) ? { count: value.length } : typeName(value)
    };
  }
  const tags = [];
  for (const candidate of value) {
    if (typeof candidate !== "string" || !candidate.trim() || candidate.trim().length > 80) {
      return { errorCode: "CAPTURE_ITEM_TAGS_INVALID", fingerprint: { invalid: true, count: value.length } };
    }
    tags.push(candidate.trim().replace(/\s+/gu, " "));
  }
  return { value: tags, fingerprint: tags };
}

function normalizeAssetUrls(value) {
  if (value === undefined) {
    return { value: [], fingerprint: [] };
  }
  if (!Array.isArray(value)) {
    return { errorCode: "CAPTURE_ITEM_ASSETS_INVALID", fingerprint: { invalid_type: typeName(value) } };
  }
  if (value.length > MAX_ASSETS_PER_ITEM) {
    return {
      errorCode: "CAPTURE_ASSET_LIMIT_EXCEEDED",
      fingerprint: { count: value.length, over_limit: true }
    };
  }
  const normalized = value.map((candidate) => {
    const part = boundedItemString(candidate, MAX_URL_LENGTH, {
      required: true,
      invalidCode: "CAPTURE_ASSET_URL_INVALID",
      missingCode: "CAPTURE_ASSET_URL_INVALID",
      tooLongCode: "CAPTURE_ASSET_URL_TOO_LONG"
    });
    return part.errorCode
      ? { errorCode: part.errorCode, fingerprint: part.fingerprint }
      : { url: part.value, fingerprint: part.fingerprint };
  });
  return {
    value: normalized,
    fingerprint: normalized.map((candidate) => candidate.fingerprint)
  };
}

function normalizeFolderInput(value) {
  if (value === undefined || value === null || value === "") {
    return { value: undefined, fingerprint: null };
  }
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) {
    return {
      errorCode: "VALIDATION_ERROR",
      fingerprint: typeof value === "string" ? value.slice(0, 100) : typeName(value)
    };
  }
  return { value: id, fingerprint: id };
}

function boundedItemString(value, maxLength, codes = {}) {
  if (value === undefined || value === null) {
    if (codes.required) {
      return { errorCode: codes.missingCode, fingerprint: null };
    }
    return { value: undefined, fingerprint: null };
  }
  if (typeof value !== "string") {
    return { errorCode: codes.invalidCode, fingerprint: { invalid_type: typeName(value) } };
  }
  const text = value.trim();
  if (!text && codes.required) {
    return { errorCode: codes.missingCode, fingerprint: "" };
  }
  if (text.length > maxLength) {
    return {
      errorCode: codes.tooLongCode,
      fingerprint: { length: text.length, prefix_sha256: sha256(text.slice(0, maxLength)) }
    };
  }
  return { value: text || undefined, fingerprint: text || null };
}

function normalizeAdapter(value) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return null;
  }
  if (typeof value !== "string" || value.trim().length > MAX_ADAPTER_LENGTH) {
    throw new RegistryError("VALIDATION_ERROR", "capture adapter is invalid.", {
      field: "adapter",
      maxLength: MAX_ADAPTER_LENGTH
    });
  }
  return value.trim();
}

function boundedRequiredString(value, field, maxLength) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) {
    throw new RegistryError("VALIDATION_ERROR", `${field} is invalid.`, {
      field,
      maxLength
    });
  }
  return value.trim();
}

function fingerprintRequest(request) {
  return sha256(JSON.stringify({
    channel: request.channel,
    adapter: request.adapter,
    items: request.items.map((item) => item.fingerprint)
  }));
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function typeName(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

module.exports = {
  CAPTURE_CHANNELS,
  MAX_ASSETS_PER_ITEM,
  MAX_CAPTURE_ITEMS,
  captureEntries,
  normalizeCaptureRequest,
  recordCaptureAssetOutcomes
};
