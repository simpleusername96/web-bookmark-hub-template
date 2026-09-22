"use strict";

const { RegistryError } = require("../registry/errors.js");

function createWebRouter({
  auth,
  registry,
  clock,
  mutationCache,
  aiUrlSummary,
  parseJsonBody,
  requireIdempotencyKey,
  requireMethod,
  runIdempotentMutation,
  api
}) {
  const {
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
    suggestTags,
    topTags,
    updateDefaults,
    updateFolder,
    updateRule
  } = api;

  return async function dispatchWebApi({ request, url, method, pathname }) {
  if (pathname === "/api/v1/ai-url-summary") {
    requireMethod(method, ["GET", "POST"]);
    if (method === "GET") {
      auth.authenticateWeb(request);
      return ok(aiUrlSummary.status());
    }
    const session = auth.authenticateWeb(request, { csrf: true });
    const body = parseJsonBody(request, { allowEmpty: true });
    assertPlainObject(body, "AI URL summary body must be an object.");
    assertAllowedFields(body, new Set(["mode", "entry_ids", "query", "expected_count", "expected_digest"]));
    if (body.mode !== "all" && body.mode !== "selected") {
      throw new RegistryError("VALIDATION_ERROR", "Choose all pending URLs or selected URLs.");
    }
    if (body.mode === "all" && Object.keys(body).length !== 1) {
      throw new RegistryError("VALIDATION_ERROR", "All mode accepts no selection fields.");
    }
    const entryIds = body.mode === "selected" ? selectedEntryIdsFromApi(registry, body) : undefined;
    return runIdempotentMutation(mutationCache, session, request, body, () => (
      ok(aiUrlSummary.start({ entryIds }), { status: 202 })
    ));
  }
  if (pathname === "/api/v1/entries/selection-snapshot") {
    requireMethod(method, ["GET"]);
    auth.authenticateWeb(request);
    return ok(selectionSnapshotFromQuery(registry, url.searchParams));
  }
  if (pathname === "/api/v1/entries/batch") {
    requireMethod(method, ["POST"]);
    const session = auth.authenticateWeb(request, { csrf: true });
    const body = parseJsonBody(request);
    return runIdempotentMutation(mutationCache, session, request, body, async () => (
      ok(await batchEntriesFromApi(registry, body, { requesterScope: session.requesterScope, clock }))
    ));
  }
  if (pathname === "/api/v1/entries") {
    requireMethod(method, ["GET", "POST"]);
    if (method === "GET") {
      auth.authenticateWeb(request);
      return ok(listEntriesFromQuery(registry, url.searchParams));
    }
    const session = auth.authenticateWeb(request, { csrf: true });
    const body = parseJsonBody(request);
    return runIdempotentMutation(mutationCache, session, request, body, () => {
      const data = createEntryFromApi(registry, body, {
        requesterScope: session.requesterScope,
        clientRequestId: requireIdempotencyKey(request),
        clock
      });
      return ok(data, { status: data.replayed ? 200 : 201 });
    });
  }

  const entryMatch = /^\/api\/v1\/entries\/(\d+)$/.exec(pathname);
  if (entryMatch) {
    requireMethod(method, ["GET", "PATCH", "DELETE"]);
    if (method === "GET") {
      auth.authenticateWeb(request);
      return ok(getEntry(registry, entryMatch[1], {
        includeArchived: ["1", "true"].includes(url.searchParams.get("include_archived"))
      }));
    }
    const session = auth.authenticateWeb(request, { csrf: true });
    const body = parseJsonBody(request, { allowEmpty: method === "DELETE" });
    return runIdempotentMutation(mutationCache, session, request, body, async () => (
      method === "PATCH"
        ? ok(editEntryFromApi(registry, entryMatch[1], body, {
          requesterScope: session.requesterScope,
          clock
        }))
        : ok(await deleteEntryFromApi(registry, entryMatch[1], body))
    ));
  }

  const restoreMatch = /^\/api\/v1\/entries\/(\d+)\/restore$/.exec(pathname);
  if (restoreMatch) {
    requireMethod(method, ["POST"]);
    const session = auth.authenticateWeb(request, { csrf: true });
    const body = parseJsonBody(request, { allowEmpty: true });
    return runIdempotentMutation(mutationCache, session, request, body, () => (
      ok(restoreEntryFromApi(registry, restoreMatch[1], body, {
        requesterScope: session.requesterScope,
        clock
      }))
    ));
  }

  const revisionsMatch = /^\/api\/v1\/entries\/(\d+)\/revisions$/.exec(pathname);
  if (revisionsMatch) {
    requireMethod(method, ["GET"]);
    auth.authenticateWeb(request);
    return ok(listEntryRevisions(registry, revisionsMatch[1]));
  }

  const entryAssetsMatch = /^\/api\/v1\/entries\/(\d+)\/visual-assets$/.exec(pathname);
  if (entryAssetsMatch) {
    requireMethod(method, ["GET"]);
    auth.authenticateWeb(request);
    return ok(listEntryVisualAssets(registry, entryAssetsMatch[1]));
  }

  const clearCoverMatch = /^\/api\/v1\/entries\/(\d+)\/clear-cover$/.exec(pathname);
  if (clearCoverMatch) {
    requireMethod(method, ["POST"]);
    const session = auth.authenticateWeb(request, { csrf: true });
    const body = parseJsonBody(request, { allowEmpty: true });
    return runIdempotentMutation(mutationCache, session, request, body, () => (
      ok(clearEntryCover(registry, clearCoverMatch[1], body, {
        actor: { type: "user", id: session.requesterScope },
        clock
      }))
    ));
  }

  const setCoverMatch = /^\/api\/v1\/visual-assets\/(\d+)\/set-cover$/.exec(pathname);
  if (setCoverMatch) {
    requireMethod(method, ["POST"]);
    const session = auth.authenticateWeb(request, { csrf: true });
    const body = parseJsonBody(request, { allowEmpty: true });
    return runIdempotentMutation(mutationCache, session, request, body, () => (
      ok(setVisualAssetCover(registry, setCoverMatch[1], body, {
        actor: { type: "user", id: session.requesterScope },
        clock
      }))
    ));
  }

  const removeAssetMatch = /^\/api\/v1\/visual-assets\/(\d+)$/.exec(pathname);
  if (removeAssetMatch) {
    requireMethod(method, ["DELETE"]);
    const session = auth.authenticateWeb(request, { csrf: true });
    const body = parseJsonBody(request, { allowEmpty: true });
    return runIdempotentMutation(mutationCache, session, request, body, async () => (
      ok(await removeVisualAssetFromApi(registry, removeAssetMatch[1], body, {
        actor: { type: "user", id: session.requesterScope },
        clock
      }))
    ));
  }

  const commentsMatch = /^\/api\/v1\/entries\/(\d+)\/comments$/.exec(pathname);
  if (commentsMatch) {
    requireMethod(method, ["GET", "POST"]);
    if (method === "GET") {
      auth.authenticateWeb(request);
      return ok(listEntryComments(registry, commentsMatch[1], url.searchParams));
    }
    const session = auth.authenticateWeb(request, { csrf: true });
    const body = parseJsonBody(request);
    return runIdempotentMutation(mutationCache, session, request, body, () => (
      ok(addEntryComment(registry, commentsMatch[1], body, { clock }), { status: 201 })
    ));
  }

  if (pathname === "/api/v1/insights/tags") {
    requireMethod(method, ["GET"]);
    auth.authenticateWeb(request);
    return ok(topTags(registry, { limit: queryValue(url.searchParams, "limit") }));
  }

  if (pathname === "/api/v1/tags/suggestions") {
    requireMethod(method, ["GET"]);
    auth.authenticateWeb(request);
    return ok(suggestTags(registry, {
      query: queryValue(url.searchParams, "q"),
      exclude: url.searchParams.getAll("exclude"),
      limit: queryValue(url.searchParams, "limit")
    }));
  }
  if (pathname === "/api/v1/url-groups") {
    requireMethod(method, ["GET"]);
    auth.authenticateWeb(request);
    const filters = entryFiltersFromQuery(url.searchParams);
    return ok(listSidebarUrlGroups(registry, filters));
  }
  if (pathname === "/api/v1/folders/tree") {
    requireMethod(method, ["GET"]);
    auth.authenticateWeb(request);
    const filters = entryFiltersFromQuery(url.searchParams);
    return ok(getSidebarFolderTree(registry, filters));
  }
  if (pathname === "/api/v1/folders") {
    requireMethod(method, ["POST"]);
    const session = auth.authenticateWeb(request, { csrf: true });
    const body = parseJsonBody(request);
    assertPlainObject(body, "Folder request body must be an object.");
    assertAllowedFields(body, new Set(["name", "parent_id"]));
    return runIdempotentMutation(mutationCache, session, request, body, () => (
      ok(createFolder(registry, { name: body.name, parentId: body.parent_id }, { clock }), { status: 201 })
    ));
  }
  const folderMatch = /^\/api\/v1\/folders\/(\d+)$/.exec(pathname);
  if (folderMatch) {
    requireMethod(method, ["GET", "PATCH", "DELETE"]);
    if (method === "GET") {
      auth.authenticateWeb(request);
      return ok(getFolder(registry, folderMatch[1]));
    }
    const session = auth.authenticateWeb(request, { csrf: true });
    const body = parseJsonBody(request, { allowEmpty: method === "DELETE" });
    assertPlainObject(body, "Folder request body must be an object.");
    assertAllowedFields(body, method === "PATCH" ? new Set(["name", "parent_id"]) : new Set());
    return runIdempotentMutation(mutationCache, session, request, body, () => {
      if (method === "DELETE") return ok(deleteFolder(registry, folderMatch[1]));
      return ok(updateFolder(registry, folderMatch[1], {
        ...(Object.prototype.hasOwnProperty.call(body, "name") ? { name: body.name } : {}),
        ...(Object.prototype.hasOwnProperty.call(body, "parent_id") ? { parentId: body.parent_id } : {})
      }, { clock }));
    });
  }
  if (pathname === "/api/v1/capture-policy") {
    requireMethod(method, ["GET", "PATCH"]);
    if (method === "GET") {
      auth.authenticateWeb(request);
      return ok(getCapturePolicy(registry));
    }
    const session = auth.authenticateWeb(request, { csrf: true });
    const body = parseJsonBody(request);
    return runIdempotentMutation(mutationCache, session, request, body, () => (
      ok(updateDefaults(registry, body, { clock }))
    ));
  }
  if (pathname === "/api/v1/capture-policy/rules") {
    requireMethod(method, ["GET", "POST"]);
    if (method === "GET") {
      auth.authenticateWeb(request);
      return ok(listCapturePolicyRules(registry));
    }
    const session = auth.authenticateWeb(request, { csrf: true });
    const body = parseJsonBody(request);
    return runIdempotentMutation(mutationCache, session, request, body, () => (
      ok(createRule(registry, body, { clock }), { status: 201 })
    ));
  }
  const policyRuleMatch = /^\/api\/v1\/capture-policy\/rules\/(\d+)$/.exec(pathname);
  if (policyRuleMatch) {
    requireMethod(method, ["PATCH", "DELETE"]);
    const session = auth.authenticateWeb(request, { csrf: true });
    const body = parseJsonBody(request, { allowEmpty: method === "DELETE" });
    return runIdempotentMutation(mutationCache, session, request, body, () => (
      ok(method === "PATCH"
        ? updateRule(registry, policyRuleMatch[1], body, { clock })
        : deleteRule(registry, policyRuleMatch[1], body))
    ));
  }
  const policyPreviewMatch = /^\/api\/v1\/capture-policy\/rules\/(\d+)\/preview$/.exec(pathname);
  if (policyPreviewMatch) {
    requireMethod(method, ["GET"]);
    auth.authenticateWeb(request);
    return ok(previewRule(registry, policyPreviewMatch[1]));
  }
  const policyApplyMatch = /^\/api\/v1\/capture-policy\/rules\/(\d+)\/apply$/.exec(pathname);
  if (policyApplyMatch) {
    requireMethod(method, ["POST"]);
    const session = auth.authenticateWeb(request, { csrf: true });
    const body = parseJsonBody(request, { allowEmpty: true });
    return runIdempotentMutation(mutationCache, session, request, body, () => (
      ok(applyRule(registry, policyApplyMatch[1], body, {
        requesterScope: session.requesterScope,
        clock
      }))
    ));
  }
  if (pathname === "/api/v1/pairing-codes") {
    requireMethod(method, ["POST"]);
    const session = auth.authenticateWeb(request, { csrf: true });
    const body = parseJsonBody(request, { allowEmpty: true });
    assertPlainObject(body, "Pairing code body must be an object.");
    assertAllowedFields(body, new Set());
    return runIdempotentMutation(mutationCache, session, request, body, () => (
      ok(auth.createPairingCodeForSession(session), { status: 201 })
    ));
  }
  if (pathname === "/api/v1/clients") {
    requireMethod(method, ["GET"]);
    auth.authenticateWeb(request);
    return ok(auth.listClients());
  }
  const revokeMatch = /^\/api\/v1\/clients\/(\d+)\/revoke$/.exec(pathname);
  if (revokeMatch) {
    requireMethod(method, ["POST"]);
    const session = auth.authenticateWeb(request, { csrf: true });
    const body = parseJsonBody(request, { allowEmpty: true });
    assertPlainObject(body, "Client revoke body must be an object.");
    assertAllowedFields(body, new Set());
    return runIdempotentMutation(mutationCache, session, request, body, () => (
      ok(auth.revokeClient(revokeMatch[1]))
    ));
  }
  throw new RegistryError("ROUTE_NOT_FOUND", "API route not found.");
  }

}

module.exports = { createWebRouter };
