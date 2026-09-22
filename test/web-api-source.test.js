"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const createApiSource = require("../web/api-source.js");

function response(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data
  };
}

function fakeApi(routes) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const pathname = new URL(url).pathname;
    const handler = routes[pathname];
    if (!handler) throw new Error(`Unexpected API call: ${pathname}`);
    return typeof handler === "function" ? handler(url, init, calls.length - 1) : handler;
  };
  return { calls, fetch };
}

function sourceWith(routes, options = {}) {
  const api = fakeApi({
    "/api/v1/health": response({
      ok: true,
      data: { status: "ok", api_version: 1, schema_version: 12, capabilities: { permanent_delete: true } }
    }),
    "/api/v1/session": response({ ok: true, data: { csrf_token: "csrf-test", expires_at: "2026-09-01T00:00:00.000Z" } }),
    ...routes
  });
  return {
    api,
    source: createApiSource({
      baseUrl: "http://127.0.0.1:43127",
      fetch: api.fetch,
      randomUUID: () => "11111111-1111-4111-8111-111111111111",
      now: () => new Date("2026-08-31T00:00:00.000Z"),
      ...options
    })
  };
}

test("initialize exposes the service contract and stale servers cannot receive permanent Delete", async () => {
  const current = sourceWith({});
  const initialized = await current.source.initialize();
  assert.equal(initialized.service.schema_version, 12);
  assert.equal(initialized.service.capabilities.permanent_delete, true);

  const stale = sourceWith({
    "/api/v1/health": response({ ok: true, data: { status: "ok", schema_version: 5 } }),
    "/api/v1/entries/4": () => {
      throw new Error("A stale backend must not receive permanent Delete.");
    },
    "/api/v1/entries/batch": () => {
      throw new Error("A stale backend must not receive batch permanent Delete.");
    }
  });
  await assert.rejects(stale.source.deleteEntry(4), (error) => (
    error instanceof createApiSource.ApiError && error.code === "SERVER_RESTART_REQUIRED"
  ));
  await assert.rejects(stale.source.batchEntries({ entry_ids: [4], operation: "delete", value: {} }), (error) => (
    error instanceof createApiSource.ApiError && error.code === "SERVER_RESTART_REQUIRED"
  ));
  assert.equal(stale.api.calls.filter((call) => new URL(call.url).pathname.includes("entries")).length, 0);
});

test("list query maps explicit filters, URL Groups, pages, and AbortSignal", async () => {
  const seen = [];
  const subject = sourceWith({
    "/api/v1/entries": (url, init) => {
      seen.push({ params: new URL(url).searchParams, signal: init.signal });
      return response({ ok: true, data: { items: [], page: 1, page_size: 8, total: 0, total_pages: 0 } });
    }
  });
  const controller = new AbortController();
  await subject.source.listEntries({
    search: "needle",
    sort: "title",
    url_group_id: "group-id",
    page: 2,
    page_size: 8,
    content_focus: "visual",
    preview: "with",
    source_domain: "example.test",
    folder_id: 9,
    include_descendants: true,
    tag: "reference",
    signal: controller.signal
  });
  assert.equal(seen[0].params.get("url_group_id"), "group-id");
  assert.equal(seen[0].params.get("search"), "needle");
  assert.equal(seen[0].params.get("page"), "2");
  assert.equal(seen[0].params.get("content_focus"), "visual");
  assert.equal(seen[0].params.get("preview"), "with");
  assert.equal(seen[0].params.get("source_domain"), "example.test");
  assert.equal(seen[0].params.get("folder_id"), "9");
  assert.equal(seen[0].params.get("include_descendants"), "true");
  assert.equal(seen[0].params.get("tag"), "reference");
  assert.equal(seen[0].signal, controller.signal);
  await subject.source.listEntries({ saved_from: "2026-08-17", visibility: "private", folder_id: 7, tag: "art" });
  assert.equal(seen[1].params.get("saved_from"), "2026-08-17");
  assert.equal(seen[1].params.get("visibility"), "private");
  assert.equal(seen[1].params.get("folder_id"), "7");
  assert.equal(seen[1].params.get("tag"), "art");
});

test("source methods map numeric IDs, Registry DTOs, not-found, and API errors", async () => {
  let unauthorizedCalls = 0;
  const subject = sourceWith({
    "/api/v1/entries/7": response({ ok: true, data: { id: 7, title: "Seven" } }),
    "/api/v1/entries/8": response({ ok: false, error: { code: "ENTRY_NOT_FOUND", message: "Entry not found." } }, 404),
    "/api/v1/entries/9": () => {
      unauthorizedCalls += 1;
      return response({ ok: false, error: { code: "WEB_SESSION_UNAUTHORIZED", message: "Expired" } }, 401);
    },
    "/api/v1/entries/7/comments": response({ ok: true, data: { items: [], page: 1, page_size: 20, total: 0, total_pages: 0 } }),
    "/api/v1/insights/tags": response({ ok: true, data: [{ id: 1, normalized_name: "art" }] }),
    "/api/v1/tags/suggestions": response({ ok: true, data: [{ id: 1, name: "Art", normalized_name: "art", entry_count: 2 }] }),
    "/api/v1/folders/tree": response({ ok: true, data: [{ id: 2, name: "Saved", children: [] }] }),
    "/api/v1/url-groups": response({ ok: true, data: [{ id: "group", label: "example.test", children: [] }] }),
    "/api/v1/clients": response({ ok: true, data: [{ id: 3, label: "Chrome" }] })
  });
  assert.deepEqual(await subject.source.getEntry("7"), { id: 7, title: "Seven" });
  assert.equal(await subject.source.getEntry(8), null);
  await assert.rejects(subject.source.getEntry(9), (error) => (
    error instanceof createApiSource.ApiError && error.code === "WEB_SESSION_UNAUTHORIZED" && error.status === 401
  ));
  assert.equal(unauthorizedCalls, 2);
  await assert.rejects(subject.source.getEntry("demo-7"), /positive integer/);
  assert.equal((await subject.source.listComments(7)).total, 0);
  assert.equal((await subject.source.topTags({ limit: 5 }))[0].normalized_name, "art");
  assert.equal((await subject.source.suggestTags({ query: "ar", exclude: ["archive"], limit: 8 }))[0].name, "Art");
  const suggestionUrl = new URL(subject.api.calls.find((call) => new URL(call.url).pathname === "/api/v1/tags/suggestions").url);
  assert.equal(suggestionUrl.searchParams.get("q"), "ar");
  assert.deepEqual(suggestionUrl.searchParams.getAll("exclude"), ["archive"]);
  assert.equal((await subject.source.listFolders())[0].id, 2);
  assert.equal((await subject.source.listUrlGroups())[0].id, "group");
  await subject.source.listFolders({ query: { search: "needle", visibility: "normal" } });
  await subject.source.listUrlGroups({ query: { search: "needle", folder_id: 2, include_descendants: true } });
  const filteredFolderUrl = new URL(subject.api.calls.filter((call) => new URL(call.url).pathname === "/api/v1/folders/tree").at(-1).url);
  const filteredGroupUrl = new URL(subject.api.calls.filter((call) => new URL(call.url).pathname === "/api/v1/url-groups").at(-1).url);
  assert.equal(filteredFolderUrl.searchParams.get("search"), "needle");
  assert.equal(filteredFolderUrl.searchParams.get("visibility"), "normal");
  assert.equal(filteredGroupUrl.searchParams.get("folder_id"), "2");
  assert.equal(filteredGroupUrl.searchParams.get("include_descendants"), "true");
  assert.equal((await subject.source.listClients())[0].id, 3);
});

test("renews an unauthorized Web session once and replays a mutation unchanged", async () => {
  const calls = [];
  let sessionCount = 0;
  let mutationCount = 0;
  const source = createApiSource({
    baseUrl: "http://127.0.0.1:43127",
    randomUUID: () => "11111111-1111-4111-8111-111111111111",
    fetch: async (url, init) => {
      const pathname = new URL(url).pathname;
      calls.push({ pathname, init });
      if (pathname === "/api/v1/session") {
        sessionCount += 1;
        return response({ ok: true, data: { csrf_token: `csrf-${sessionCount}` } });
      }
      if (pathname === "/api/v1/entries") {
        mutationCount += 1;
        if (mutationCount === 1) {
          return response({ ok: false, error: { code: "WEB_SESSION_UNAUTHORIZED", message: "Expired" } }, 401);
        }
        return response({ ok: true, data: { entry: { id: 12 }, outcome_code: "created" } });
      }
      throw new Error(`Unexpected API call: ${pathname}`);
    }
  });

  const result = await source.addEntry({ url: "https://example.test/session" });
  assert.equal(result.entry.id, 12);
  assert.equal(sessionCount, 2);
  const mutations = calls.filter((call) => call.pathname === "/api/v1/entries");
  assert.equal(mutations.length, 2);
  assert.equal(mutations[0].init.body, mutations[1].init.body);
  assert.equal(mutations[0].init.headers["idempotency-key"], mutations[1].init.headers["idempotency-key"]);
  assert.equal(mutations[0].init.headers["x-csrf-token"], "csrf-1");
  assert.equal(mutations[1].init.headers["x-csrf-token"], "csrf-2");
});

test("does not retry non-session API or network failures", async () => {
  for (const failure of [
    response({ ok: false, error: { code: "CSRF_INVALID", message: "Invalid" } }, 403),
    response({ ok: false, error: { code: "ENTRY_INVALID", message: "Invalid" } }, 400)
  ]) {
    let calls = 0;
    const subject = sourceWith({
      "/api/v1/entries": () => { calls += 1; return failure; }
    });
    await assert.rejects(subject.source.addEntry({ url: "https://example.test/failure" }));
    assert.equal(calls, 1);
  }

  let networkCalls = 0;
  const network = sourceWith({
    "/api/v1/entries": () => { networkCalls += 1; throw new Error("offline"); }
  });
  await assert.rejects(network.source.addEntry({ url: "https://example.test/offline" }), /offline/);
  assert.equal(networkCalls, 1);
});

test("mutations forward CSRF, UUID idempotency, accepted fields, and comment/client routes", async () => {
  const bodies = [];
  const route = (url, init) => {
    bodies.push({ pathname: new URL(url).pathname, init, body: JSON.parse(init.body) });
    return response({ ok: true, data: { accepted: true } }, init.method === "POST" ? 201 : 200);
  };
  const subject = sourceWith({
    "/api/v1/entries": route,
    "/api/v1/entries/4/comments": route,
    "/api/v1/pairing-codes": route,
    "/api/v1/clients/3/revoke": route
  });
  await subject.source.addEntry({
    url: "https://example.test/item",
    title: "Item",
    kind: "article",
    folderId: 2,
    contentFocus: "visual",
    tags: ["art"],
    comment: "note",
    visibility: "normal",
    createdVia: "legacy"
  });
  await subject.source.addComment(4, "second");
  await subject.source.createPairingCode();
  await subject.source.revokeClient(3);
  assert.deepEqual(bodies[0].body, {
    url: "https://example.test/item",
    title: "Item",
    kind: "article",
    folder_id: 2,
    content_focus: "visual",
    tags: ["art"],
    comment: "note",
    visibility: "normal"
  });
  assert.deepEqual(bodies.slice(1).map((item) => item.pathname), [
    "/api/v1/entries/4/comments",
    "/api/v1/pairing-codes",
    "/api/v1/clients/3/revoke"
  ]);
  bodies.forEach((item) => {
    assert.equal(item.init.headers["x-csrf-token"], "csrf-test");
    assert.equal(item.init.headers["idempotency-key"], "11111111-1111-4111-8111-111111111111");
  });
});

test("automatic Web Add omits Content type and presentation focus", async () => {
  let body;
  const subject = sourceWith({
    "/api/v1/entries": (_url, init) => {
      body = JSON.parse(init.body);
      return response({ ok: true, data: { entry: { id: 1 }, outcome_code: "created" } }, 201);
    }
  });
  await subject.source.addEntry({ url: "https://youtu.be/abcdefghijk" });
  assert.deepEqual(body, { url: "https://youtu.be/abcdefghijk" });
});

test("human CRUD, asset, history, and capture-policy methods preserve HTTP intent", async () => {
  const calls = [];
  const route = (url, init) => {
    calls.push({ pathname: new URL(url).pathname, method: init.method, body: init.body ? JSON.parse(init.body) : null });
    return response({ ok: true, data: {} });
  };
  const subject = sourceWith({
    "/api/v1/entries/4": route,
    "/api/v1/entries/selection-snapshot": route,
    "/api/v1/entries/batch": route,
    "/api/v1/entries/4/revisions": route,
    "/api/v1/entries/4/visual-assets": route,
    "/api/v1/visual-assets/7/set-cover": route,
    "/api/v1/entries/4/clear-cover": route,
    "/api/v1/visual-assets/7": route,
    "/api/v1/capture-policy": route,
    "/api/v1/capture-policy/rules": route,
    "/api/v1/capture-policy/rules/2": route,
    "/api/v1/capture-policy/rules/2/preview": route,
    "/api/v1/capture-policy/rules/2/apply": route,
    "/api/v1/folders": route,
    "/api/v1/folders/6": route
  });
  await subject.source.editEntry(4, { title: null, folder_id: null, tags: [] });
  await subject.source.selectionSnapshot({ search: "needle", folder_id: 6 });
  await subject.source.batchEntries({ entry_ids: [4, 5], operation: "set_kind", value: { kind: "research" } });
  await subject.source.deleteEntry(4);
  await subject.source.listEntryRevisions(4);
  await subject.source.listVisualAssets(4);
  await subject.source.setCover(7);
  await subject.source.clearCover(4);
  await subject.source.removeVisualAsset(7);
  await subject.source.getCapturePolicy();
  await subject.source.updateCapturePolicy({ visibility: "normal" });
  await subject.source.listCapturePolicyRules();
  await subject.source.createCapturePolicyRule({ url_prefix: "https://example.test/images" });
  await subject.source.updateCapturePolicyRule(2, { enabled: false });
  await subject.source.deleteCapturePolicyRule(2);
  await subject.source.previewCapturePolicyRule(2);
  await subject.source.applyCapturePolicyRule(2, "confirmed");
  await subject.source.getFolder(6);
  await subject.source.createFolder({ name: "Work", parent_id: null });
  await subject.source.updateFolder(6, { name: "Projects", parent_id: 2 });
  await subject.source.deleteFolder(6);
  assert.deepEqual(calls[0], {
    pathname: "/api/v1/entries/4",
    method: "PATCH",
    body: { title: null, folder_id: null, tags: [] }
  });
  assert.ok(calls.some((call) => call.pathname === "/api/v1/entries/4" && call.method === "DELETE"));
  assert.ok(calls.some((call) => call.pathname === "/api/v1/entries/batch" && call.method === "POST"));
  assert.ok(calls.some((call) => call.pathname === "/api/v1/entries/selection-snapshot" && call.method === "GET"));
  assert.ok(calls.some((call) => call.pathname === "/api/v1/visual-assets/7" && call.method === "DELETE"));
  assert.ok(calls.some((call) => call.pathname === "/api/v1/capture-policy" && call.method === "PATCH"));
  assert.ok(calls.some((call) => call.pathname === "/api/v1/capture-policy/rules/2" && call.method === "PATCH"));
  assert.ok(calls.some((call) => call.pathname === "/api/v1/capture-policy/rules/2" && call.method === "DELETE"));
  assert.ok(calls.some((call) => call.pathname === "/api/v1/folders" && call.method === "POST"));
  assert.ok(calls.some((call) => call.pathname === "/api/v1/folders/6" && call.method === "PATCH"));
  assert.ok(calls.some((call) => call.pathname === "/api/v1/folders/6" && call.method === "DELETE"));
});

test("production has no demo fallback and session/API failures remain visible to callers", async () => {
  const subject = sourceWith({
    "/api/v1/entries": response({ ok: false, error: { code: "INTERNAL_ERROR", message: "Registry unavailable" } }, 500)
  });
  await assert.rejects(subject.source.listEntries({}), /Registry unavailable/);
  const index = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
  const demo = fs.readFileSync(path.join(__dirname, "..", "web", "demo.html"), "utf8");
  const app = fs.readFileSync(path.join(__dirname, "..", "web", "app.js"), "utf8");
  assert.match(index, /api-source\.js/);
  assert.doesNotMatch(index, /demo-(?:data|source|boot)\.js/);
  assert.match(demo, /demo-data\.js/);
  assert.match(demo, /demo-source\.js/);
  assert.match(demo, /demo-boot\.js/);
  assert.match(app, /refreshVersion/);
  assert.match(app, /currentVersion !== refreshVersion/);
});


test("save-method rules reject an old server without mutation and retry after its restart", async () => {
  let version = 13;
  const subject = sourceWith({
    "/api/v1/health": () => response({ ok: true, data: { schema_version: version } }),
    "/api/v1/capture-policy/rules/2": response({ ok: true, data: { id: 2, capture_mode: "selected_images" } }),
    "/api/v1/capture-policy/rules": response({ ok: true, data: { id: 3 } })
  });
  await assert.rejects(subject.source.updateCapturePolicyRule(2, { capture_mode: "selected_images" }), { code: "SERVER_RESTART_REQUIRED" });
  await assert.rejects(subject.source.createCapturePolicyRule({ capture_mode: "page" }), { code: "SERVER_RESTART_REQUIRED" });
  assert.equal(subject.api.calls.some(call => call.init.method === "PATCH" || call.init.method === "POST"), false);
  version = 14;
  const result = await subject.source.updateCapturePolicyRule(2, { capture_mode: "selected_images" });
  assert.equal(result.capture_mode, "selected_images");
  assert.equal(subject.api.calls.filter(call => call.init.method === "PATCH").length, 1);
});

test("AI URL summary adapter exposes status and forwards a fixed all or selected scope", async () => {
  const statusValue = { status: "idle", eligible_count: 9, last_run: null };
  const runningValue = { status: "running", eligible_count: 9, last_run: null };
  const subject = sourceWith({
    "/api/v1/ai-url-summary": (_url, init) => response({
      ok: true,
      data: init.method === "POST" ? runningValue : statusValue
    })
  });
  assert.deepEqual(await subject.source.getAiUrlSummary(), statusValue);
  assert.deepEqual(await subject.source.startAiUrlSummary({ mode: "all" }), runningValue);
  assert.deepEqual(await subject.source.startAiUrlSummary({ mode: "selected", entry_ids: [1] }), runningValue);
  const calls = subject.api.calls.filter((call) => new URL(call.url).pathname === "/api/v1/ai-url-summary");
  assert.equal(calls.length, 3);
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[1].init.method, "POST");
  assert.equal(calls[1].init.body, '{"mode":"all"}');
  assert.equal(calls[2].init.body, '{"mode":"selected","entry_ids":[1]}');
});
