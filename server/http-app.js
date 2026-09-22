"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const {
  MAX_JSON_BODY_BYTES,
  MAX_SHORTCUT_EVIDENCE_BODY_BYTES
} = require("../extension/transport-contract.js");

const { SCHEMA_VERSION } = require("../registry/database.js");
const { getEntry } = require("../registry/entries.js");
const { RegistryError } = require("../registry/errors.js");
const { createFolder, deleteFolder, getFolder, getFolderTree, updateFolder } = require("../registry/folders.js");
const { topTags } = require("../registry/insights.js");
const { suggestTags } = require("../registry/tags.js");
const { getSidebarFolderTree, listSidebarUrlGroups } = require("../registry/sidebar-projections.js");
const { getVisualAsset } = require("../registry/visual-assets.js");
const {
  createAuthManager,
  headerValue,
  validateLoopbackRequest,
  validateWebRequestMetadata
} = require("./auth.js");
const { captureFromChrome, capturePresenceFromChrome } = require("./capture-api.js");
const {
  applyRule,
  createRule,
  deleteRule,
  getCapturePolicy,
  listCapturePolicyRules,
  previewRule,
  updateDefaults,
  updateRule
} = require("./capture-policy-api.js");
const {
  addEntryComment,
  batchEntriesFromApi,
  assertAllowedFields,
  assertPlainObject,
  createEntryFromApi,
  deleteEntryFromApi,
  editEntryFromApi,
  entryFiltersFromQuery,
  listEntriesFromQuery,
  listEntryComments,
  listEntryRevisions,
  queryValue,
  restoreEntryFromApi,
  selectionSnapshotFromQuery,
  selectedEntryIdsFromApi
} = require("./entries-api.js");
const { fail, ok } = require("./responses.js");
const { createAiUrlSummaryService } = require("./ai-url-summary.js");
const { serveStaticFile } = require("./static-files.js");
const { stageShortcutEvidence } = require("./shortcut-enrichment.js");
const { createWebRouter } = require("./web-router.js");
const {
  clearEntryCover,
  listEntryVisualAssets,
  removeVisualAssetFromApi,
  setVisualAssetCover
} = require("./visual-assets-api.js");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const API_VERSION = 1;
const WEB_CAPABILITIES = Object.freeze({ permanent_delete: true });
const IDEMPOTENCY_TTL_MS = 15 * 60 * 1000;
const MAX_IDEMPOTENCY_RESULTS = 2048;

function serviceContract() {
  return {
    api_version: API_VERSION,
    schema_version: SCHEMA_VERSION,
    capabilities: WEB_CAPABILITIES
  };
}

function createHttpApp({
  registry,
  baseUrl,
  webRoot = path.resolve(__dirname, "..", "web"),
  clock = Date,
  downloadImage,
  aiUrlSummary,
  auth = createAuthManager({ registry, clock })
} = {}) {
  if (!registry || !baseUrl) {
    throw new RegistryError("INTERNAL_ERROR", "HTTP app requires Registry and baseUrl configuration.");
  }
  const configuredUrl = new URL(baseUrl);
  if (configuredUrl.protocol !== "http:" || !["127.0.0.1", "[::1]", "::1"].includes(configuredUrl.hostname)) {
    throw new RegistryError("INTERNAL_ERROR", "HTTP app baseUrl must be an HTTP loopback URL.");
  }
  const mutationCache = new Map();
  const urlSummary = aiUrlSummary || createAiUrlSummaryService({
    registry,
    repoRoot: path.resolve(__dirname, ".."),
    clock
  });
  const dispatchWebApi = createWebRouter({
    auth,
    registry,
    clock,
    mutationCache,
    aiUrlSummary: urlSummary,
    parseJsonBody,
    requireIdempotencyKey,
    requireMethod,
    runIdempotentMutation: (cache, session, request, body, action) => (
      runIdempotentMutation(cache, session, request, body, action, clock)
    ),
    api: {
      addEntryComment,
      applyRule,
      assertAllowedFields,
      assertPlainObject,
      batchEntriesFromApi,
      clearEntryCover,
      createFolder,
      createEntryFromApi,
      createRule,
      deleteEntryFromApi,
      deleteFolder,
      deleteRule,
      editEntryFromApi,
      entryFiltersFromQuery,
      getCapturePolicy,
      getEntry,
      getFolder,
      getFolderTree,
      getSidebarFolderTree,
      listCapturePolicyRules,
      listEntriesFromQuery,
      listEntryComments,
      listEntryRevisions,
      listEntryVisualAssets,
      listSidebarUrlGroups,
      ok,
      previewRule,
      queryValue,
      removeVisualAssetFromApi,
      restoreEntryFromApi,
      selectionSnapshotFromQuery,
      selectedEntryIdsFromApi,
      setVisualAssetCover,
      topTags,
      suggestTags,
      updateDefaults,
      updateFolder,
      updateRule
    }
  });

  async function dispatch(input) {
    const request = normalizeRequest(input);
    try {
      validateLoopbackRequest(request, configuredUrl.href);
      const url = new URL(request.url, configuredUrl);
      if (url.origin !== configuredUrl.origin) {
        throw new RegistryError("ORIGIN_INVALID", "Request URL is outside the configured service.");
      }
      const method = request.method;
      const pathname = url.pathname;

      if (pathname === "/api/v1/health") {
        requireMethod(method, ["GET"]);
        return ok({ status: "ok", ...serviceContract() });
      }
      if (pathname === "/api/v1/session") {
        requireMethod(method, ["GET"]);
        validateWebRequestMetadata(request, configuredUrl.href);
        const session = auth.issueSession();
        return ok({
          csrf_token: session.csrf_token,
          expires_at: session.expires_at,
          service: serviceContract()
        }, {
          headers: { "set-cookie": session.set_cookie }
        });
      }
      if (pathname === "/api/v1/pairing-exchanges") {
        requireMethod(method, ["POST"]);
        const body = parseJsonBody(request);
        assertPlainObject(body, "Pairing exchange body must be an object.");
        assertAllowedFields(body, new Set(["code", "extension_id", "label"]));
        return ok(auth.exchangePairingCode({
          code: body.code,
          extensionId: body.extension_id,
          label: body.label,
          origin: headerValue(request.headers, "origin"),
          remoteAddress: request.remoteAddress
        }), { status: 201 });
      }
      if (pathname === "/api/v1/client") {
        requireMethod(method, ["GET"]);
        return ok(auth.authenticateBearer(request));
      }
      if (pathname === "/api/v1/captures") {
        requireMethod(method, ["POST"]);
        const client = auth.authenticateBearer(request);
        const clientRequestId = requireIdempotencyKey(request);
        const body = parseJsonBody(request);
        return ok(await captureFromChrome(registry, body, { client, clientRequestId, clock, downloadImage }), { status: 201 });
      }
      if (pathname === "/api/v1/captures/presence") {
        requireMethod(method, ["POST"]);
        auth.authenticateBearer(request);
        const body = parseJsonBody(request);
        return ok(capturePresenceFromChrome(registry, body));
      }
      const shortcutEvidenceMatch = /^\/api\/v1\/captures\/(\d+)\/shortcut-evidence$/.exec(pathname);
      if (shortcutEvidenceMatch) {
        requireMethod(method, ["POST"]);
        auth.authenticateBearer(request);
        const body = parseJsonBody(request, { maxBytes: MAX_SHORTCUT_EVIDENCE_BODY_BYTES });
        return ok(await stageShortcutEvidence(registry, urlSummary, shortcutEvidenceMatch[1], body, {
          now: () => typeof clock?.now === "function" ? clock.now() : Date.now()
        }), { status: 202 });
      }
      if (pathname === "/api/v1/folders/tree" && headerValue(request.headers, "authorization")) {
        requireMethod(method, ["GET"]);
        auth.authenticateBearer(request);
        return ok(getFolderTree(registry));
      }
      if (pathname === "/api/v1/tags/suggestions" && headerValue(request.headers, "authorization")) {
        requireMethod(method, ["GET"]);
        auth.authenticateBearer(request);
        return ok(suggestTags(registry, {
          query: queryValue(url.searchParams, "q"),
          exclude: url.searchParams.getAll("exclude"),
          limit: queryValue(url.searchParams, "limit")
        }));
      }

      const visualMatch = /^\/api\/v1\/visual-assets\/(\d+)\/content$/.exec(pathname);
      if (visualMatch) {
        requireMethod(method, ["GET"]);
        authenticateAssetRequest(auth, request, configuredUrl.href);
        return serveVisualAsset(registry, visualMatch[1]);
      }

      if (pathname.startsWith("/api/v1/")) {
        validateWebRequestMetadata(request, configuredUrl.href);
        return await dispatchWebApi({ request, url, method, pathname });
      }

      requireMethod(method, ["GET", "HEAD"]);
      validateWebRequestMetadata(request, configuredUrl.href, {
        allowCrossSiteNavigation: true,
        allowSameOriginNoCors: true
      });
      return serveStaticFile(webRoot, pathname, { head: method === "HEAD" });
    } catch (error) {
      return fail(error);
    }
  }

  return { auth, baseUrl: configuredUrl.origin, dispatch };
}

async function runIdempotentMutation(cache, session, request, body, action, clock = Date) {
  const now = () => clock && typeof clock.now === "function" ? clock.now() : new Date(clock()).getTime();
  const timestamp = now();
  for (const [storedKey, value] of cache) {
    if (!value.pending && value.expiresAt <= timestamp) cache.delete(storedKey);
  }
  const key = requireIdempotencyKey(request);
  const cacheKey = `${session.requesterScope}:${key}`;
  const fingerprint = createHash("sha256")
    .update(`${request.method}\0${new URL(request.url, "http://loopback.invalid").pathname}\0${stableJson(body)}`, "utf8")
    .digest("hex");
  const existing = cache.get(cacheKey);
  if (existing) {
    if (existing.fingerprint !== fingerprint) {
      throw new RegistryError("CAPTURE_REQUEST_CONFLICT", "Idempotency key was already used with different content.");
    }
    return existing.pending || existing.response;
  }
  while (cache.size >= MAX_IDEMPOTENCY_RESULTS) {
    const oldestCompleted = [...cache].find(([, value]) => !value.pending);
    if (!oldestCompleted) {
      throw new RegistryError("IDEMPOTENCY_CAPACITY_EXCEEDED", "Too many changes are still running. Try again shortly.");
    }
    cache.delete(oldestCompleted[0]);
  }
  const entry = { fingerprint };
  cache.set(cacheKey, entry);
  entry.pending = Promise.resolve().then(action).then((response) => {
    entry.response = response;
    entry.expiresAt = now() + IDEMPOTENCY_TTL_MS;
    delete entry.pending;
    return response;
  }, (error) => {
    if (cache.get(cacheKey) === entry) cache.delete(cacheKey);
    throw error;
  });
  return entry.pending;
}

function authenticateAssetRequest(auth, request, baseUrl) {
  if (headerValue(request.headers, "authorization")) {
    return auth.authenticateBearer(request);
  }
  validateWebRequestMetadata(request, baseUrl, { allowSameOriginNoCors: true });
  return auth.authenticateWeb(request);
}

function serveVisualAsset(registry, id) {
  const asset = getVisualAsset(registry, id);
  if (asset.storage_kind !== "local" || asset.status !== "ready" || !asset.media_type?.startsWith("image/")) {
    throw new RegistryError("VISUAL_ASSET_CONTENT_UNAVAILABLE", "Visual Asset content is unavailable.");
  }
  let stat;
  try {
    stat = fs.statSync(asset.file_path);
  } catch {
    throw new RegistryError("VISUAL_ASSET_CONTENT_UNAVAILABLE", "Visual Asset content is unavailable.");
  }
  if (!stat.isFile()) throw new RegistryError("VISUAL_ASSET_CONTENT_UNAVAILABLE", "Visual Asset content is unavailable.");
  return {
    status: 200,
    headers: {
      "content-type": asset.media_type,
      "content-length": String(stat.size),
      "cache-control": "private, max-age=300",
      "content-disposition": "inline",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff"
    },
    file: Object.freeze(Object.defineProperty({}, "path", { value: asset.file_path }))
  };
}

function normalizeRequest(input = {}) {
  return {
    method: String(input.method || "GET").toUpperCase(),
    url: String(input.url || "/"),
    headers: input.headers || {},
    remoteAddress: input.remoteAddress || "",
    body: input.body
  };
}

function parseJsonBody(request, { allowEmpty = false, maxBytes = MAX_JSON_BODY_BYTES } = {}) {
  const contentType = headerValue(request.headers, "content-type").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new RegistryError("CONTENT_TYPE_INVALID", "JSON requests require application/json.");
  }
  if (request.body === undefined || request.body === null || request.body === "" ||
      (Buffer.isBuffer(request.body) && request.body.length === 0)) {
    if (allowEmpty) return {};
    throw new RegistryError("JSON_BODY_INVALID", "JSON request body is required.");
  }
  if (typeof request.body === "object" && !Buffer.isBuffer(request.body)) {
    const serialized = JSON.stringify(request.body);
    if (Buffer.byteLength(serialized) > maxBytes) throw bodyTooLarge(maxBytes);
    return request.body;
  }
  const source = Buffer.isBuffer(request.body) ? request.body.toString("utf8") : String(request.body);
  if (Buffer.byteLength(source) > maxBytes) throw bodyTooLarge(maxBytes);
  try {
    return JSON.parse(source);
  } catch {
    throw new RegistryError("JSON_BODY_INVALID", "Request body must contain valid JSON.");
  }
}

function bodyTooLarge(maxBytes = MAX_JSON_BODY_BYTES) {
  return new RegistryError("REQUEST_BODY_TOO_LARGE", "Request body is too large.", {
    maxBytes
  });
}

function requireIdempotencyKey(request) {
  const value = headerValue(request.headers, "idempotency-key").trim().toLowerCase();
  if (!UUID.test(value)) {
    throw new RegistryError("IDEMPOTENCY_KEY_INVALID", "Idempotency-Key must be a UUID.");
  }
  return value;
}

function requireMethod(actual, allowed) {
  if (!allowed.includes(actual)) {
    throw new RegistryError("METHOD_NOT_ALLOWED", "HTTP method is not allowed.", { allowed });
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

module.exports = {
  MAX_JSON_BODY_BYTES,
  MAX_SHORTCUT_EVIDENCE_BODY_BYTES,
  IDEMPOTENCY_TTL_MS,
  MAX_IDEMPOTENCY_RESULTS,
  runIdempotentMutation,
  createHttpApp,
  parseJsonBody,
  requireIdempotencyKey,
  serveVisualAsset
};
