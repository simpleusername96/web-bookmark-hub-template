"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  MAX_ASSETS,
  MAX_ITEMS,
  MAX_SHORTCUT_SCREENSHOT_BYTES,
  boundedShortcutScreenshotDataUrl,
  buildCapturePresence,
  buildCurrentTabCapture,
  captureFullySucceeded,
  summarizeCaptureResult,
  genericImageCandidate,
  normalizeSelectedCapture,
  shortcutEnrichmentDecision
} = require("../extension/capture-contract.js");
const { CANONICAL_BASE_URL, CONFIG_KEY, createRegistryClient, entryDetailUrl, normalizeBaseUrl } = require("../extension/registry-client.js");
const { MAX_JSON_BODY_BYTES, serializeJsonBody } = require("../extension/transport-contract.js");
const { createExternalPairingBridge } = require("../extension/pairing-bridge.js");
const { SESSION_KEY, createSelectionSessionStore, sessionMatchesTab } = require("../extension/selection-session.js");
const { DEFAULT_FILES, createSelectionRuntime } = require("../extension/selection-runtime.js");

const ROOT = path.resolve(__dirname, "..");
const TAB = {
  id: 17,
  url: "https://example.test/articles/one?keep=1#section",
  title: "Actual active tab"
};

test("shared JSON transport limit agrees for ASCII and multi-byte payloads", () => {
  const encoder = new TextEncoder();
  const emptyBytes = encoder.encode(JSON.stringify({ data: "" })).byteLength;
  const ascii = { data: "a".repeat(MAX_JSON_BODY_BYTES - emptyBytes) };
  assert.equal(encoder.encode(serializeJsonBody(ascii)).byteLength, MAX_JSON_BODY_BYTES);
  assert.throws(() => serializeJsonBody({ data: `${ascii.data}a` }), { code: "REQUEST_BODY_TOO_LARGE" });

  const available = MAX_JSON_BODY_BYTES - emptyBytes;
  const multi = { data: "가".repeat(Math.floor(available / 3)) + "a".repeat(available % 3) };
  assert.equal(encoder.encode(serializeJsonBody(multi)).byteLength, MAX_JSON_BODY_BYTES);
  assert.throws(() => serializeJsonBody({ data: `${multi.data}가` }), { code: "REQUEST_BODY_TOO_LARGE" });
});

test("shortcut enrichment decision requires server approval and a missing summary", () => {
  assert.deepEqual(shortcutEnrichmentDecision({ items: [{
    entry_id: 9,
    enrichment: { allowed: true, needs_summary: true, reason: null }
  }] }), { collect: true, allowed: true, needsSummary: true, reason: null });
  assert.equal(shortcutEnrichmentDecision({ items: [{
    entry_id: 9,
    enrichment: { allowed: false, needs_summary: false, reason: "policy_blocked" }
  }] }).collect, false);
  assert.equal(shortcutEnrichmentDecision({ items: [{
    entry_id: 9,
    enrichment: { allowed: true, needs_summary: false, reason: "already_summarized" }
  }] }).collect, false);
  assert.equal(shortcutEnrichmentDecision({ items: [] }).collect, false);
});

test("shortcut screenshot degrades to absent before transport when invalid or oversized", () => {
  const jpegPrefix = Buffer.from([0xff, 0xd8, 0xff]).toString("base64");
  const small = `data:image/jpeg;base64,${jpegPrefix}`;
  assert.equal(boundedShortcutScreenshotDataUrl(small), small);
  assert.equal(boundedShortcutScreenshotDataUrl("data:image/png;base64,AAAA"), null);
  const oversized = `data:image/jpeg;base64,${"A".repeat(Math.ceil((MAX_SHORTCUT_SCREENSHOT_BYTES + 1) * 4 / 3))}`;
  assert.equal(boundedShortcutScreenshotDataUrl(oversized), null);
});

test("oversized extension capture is rejected before fetch", async () => {
  let fetchCalls = 0;
  const storage = storageArea({
    [CONFIG_KEY]: { baseUrl: CANONICAL_BASE_URL, token: "test-token", client: { id: 1 } }
  });
  const client = createRegistryClient({
    chromeApi: { runtime: { id: "extension" }, storage: { local: storage } },
    fetchImpl: async () => { fetchCalls += 1; return response({}); }
  });
  await assert.rejects(() => client.capture({ data: "가".repeat(MAX_JSON_BODY_BYTES) }, "request-id"), {
    code: "REQUEST_BODY_TOO_LARGE"
  });
  assert.equal(fetchCalls, 0);
});

test("current-tab capture trusts the worker tab and only accepts explicit user metadata", () => {
  const capture = buildCurrentTabCapture(TAB, {
    url: "https://attacker.test/forged",
    title: "Forged popup title",
    createdVia: "legacy",
    visibility: "normal",
    comment: "  useful note  ",
    tags: [" reference ", "reference", "art   study"],
    folderId: "3",
    contentFocus: "visual"
  });

  assert.equal(capture.adapter, "current-tab");
  assert.equal(capture.items[0].entryUrl, TAB.url);
  assert.equal(Object.hasOwn(capture.items[0], "title"), false);
  assert.equal(capture.items[0].comment, "useful note");
  assert.deepEqual(capture.items[0].tags, ["reference", "art study"]);
  assert.equal(capture.items[0].folderId, 3);
  assert.equal(capture.items[0].contentFocus, undefined);
  assert.equal(capture.items[0].createdVia, undefined);
  assert.equal(capture.items[0].visibility, "normal");
  assert.match(capture.items[0].selectedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("current-tab capture rejects restricted, malformed, and credential-bearing URLs", () => {
  for (const url of [
    "chrome://extensions",
    "file:///C:/private.txt",
    "data:text/plain,secret",
    "https://user:password@example.test/private"
  ]) {
    assert.throws(() => buildCurrentTabCapture({ ...TAB, url }, {}), { code: "TAB_URL_INVALID" });
  }
  assert.throws(() => buildCurrentTabCapture({ title: "missing id", url: TAB.url }, {}), { code: "TAB_INVALID" });
});

test("generic selector uses currentSrc, falls back to the page, and filters unsafe images", () => {
  const selected = genericImageCandidate({
    currentSrc: "https://cdn.test/large@2x.jpg?raw=1",
    src: "https://cdn.test/small.jpg",
    anchorHref: "https://example.test/post/42?view=media",
    pageUrl: TAB.url,
    title: "  Selected image  ",
    width: 240,
    height: 180,
    intersectionRatio: 0.5,
    visible: true
  });
  assert.deepEqual(selected, {
    entryUrl: "https://example.test/post/42?view=media",
    publishedAt: undefined,
    assetUrls: ["https://cdn.test/large@2x.jpg?raw=1"],
    adapter: "generic"
  });

  const fallback = genericImageCandidate({
    src: "https://cdn.test/fallback.png",
    anchorHref: "javascript:alert(1)",
    pageUrl: TAB.url,
    width: 96,
    height: 96,
    intersectionRatio: 1,
    visible: true
  });
  assert.equal(fallback.entryUrl, TAB.url);

  const base = {
    src: "https://cdn.test/image.jpg",
    pageUrl: TAB.url,
    width: 120,
    height: 120,
    intersectionRatio: 1,
    visible: true
  };
  assert.equal(genericImageCandidate({ ...base, width: 95 }), null);
  assert.equal(genericImageCandidate({ ...base, intersectionRatio: 0 }), null);
  assert.equal(genericImageCandidate({ ...base, visible: false }), null);
  assert.equal(genericImageCandidate({ ...base, src: "data:image/png;base64,AAAA" }), null);
  assert.equal(genericImageCandidate({ ...base, src: "https://user:password@cdn.test/a.jpg" }), null);
});

test("selected images group by exact Entry URL with stable asset order and user-owned metadata", () => {
  const selectedAt = "2026-08-31T04:05:06.000Z";
  const capture = normalizeSelectedCapture([
    {
      entryUrl: "https://example.test/post/7?mode=media",
      title: "First title wins",
      assetUrls: ["https://cdn.test/a.jpg", "https://cdn.test/b.jpg"],
      adapter: "generic",
      folderId: 999,
      urlGroupId: "forged"
    },
    {
      entryUrl: "https://example.test/post/7?mode=media",
      title: "Later title",
      assetUrls: ["https://cdn.test/b.jpg", "https://cdn.test/c.jpg"],
      adapter: "generic"
    },
    {
      entryUrl: "https://example.test/post/7?mode=thread",
      assetUrls: ["https://cdn.test/d.jpg"],
      adapter: "generic"
    }
  ], {
    pageUrl: TAB.url,
    selectedAt,
    userMetadata: { comment: "Keep context", tags: ["visual"], folderId: 4, contentFocus: "text" }
  });

  assert.equal(capture.adapter, "generic");
  assert.equal(capture.items.length, 2);
  assert.deepEqual(capture.items[0], {
    entryUrl: "https://example.test/post/7?mode=media",
    publishedAt: undefined,
    selectedAt,
    assetUrls: ["https://cdn.test/a.jpg", "https://cdn.test/b.jpg", "https://cdn.test/c.jpg"],
    comment: "Keep context",
    tags: ["visual"],
    folderId: 4
  });
  assert.equal(capture.items[1].entryUrl, "https://example.test/post/7?mode=thread");
  assert.equal(capture.items[1].folderId, 4);
  assert.equal(capture.items[1].urlGroupId, undefined);
});

test("site templates are optional extractors and must stay related to the active profile", () => {
  const profile = {
    id: "example-profile",
    hostSuffixes: ["example.test"],
    detailPathRegex: /^\/post\/\d+\/?$/
  };
  const capture = normalizeSelectedCapture([{
    entryUrl: "https://www.example.test/post/42",
    assetUrls: ["https://cdn.test/a.jpg"],
    adapter: profile.id,
    account: "forged-auto-folder"
  }], { pageUrl: "https://example.test/user/media", profiles: [profile] });
  assert.equal(capture.adapter, profile.id);
  assert.equal(capture.items[0].account, undefined);
  assert.equal(capture.items[0].folderId, undefined);

  assert.throws(() => normalizeSelectedCapture([{
    entryUrl: "https://other.test/post/42",
    assetUrls: ["https://cdn.test/a.jpg"],
    adapter: profile.id
  }], { pageUrl: "https://example.test/user/media", profiles: [profile] }), {
    code: "TEMPLATE_RELATIONSHIP_INVALID"
  });
});

test("capture presence keeps bounded exact references for each page candidate", () => {
  const items = buildCapturePresence([{
    entryUrl: "https://example.test/post/42#detail",
    assetUrls: ["https://cdn.test/image.jpg#variant"],
    presenceAssetUrls: [
      "https://cdn.test/image.jpg#variant",
      "https://cdn.test/image-original.jpg"
    ],
    adapter: "generic"
  }], { pageUrl: TAB.url });
  assert.deepEqual(items, [{
    entryUrl: "https://example.test/post/42#detail",
    assetUrls: [
      "https://cdn.test/image.jpg#variant",
      "https://cdn.test/image-original.jpg"
    ]
  }]);
  assert.throws(() => buildCapturePresence([], { pageUrl: TAB.url }), { code: "PRESENCE_LIMIT_INVALID" });
  assert.throws(() => buildCapturePresence(Array(MAX_ITEMS + 1).fill({
    entryUrl: TAB.url,
    assetUrls: ["https://cdn.test/image.jpg"]
  }), { pageUrl: TAB.url }), { code: "PRESENCE_LIMIT_INVALID" });
  assert.throws(() => buildCapturePresence([{
    entryUrl: TAB.url,
    assetUrls: ["data:image/png;base64,AAAA"]
  }], { pageUrl: TAB.url }), { code: "ASSET_URL_INVALID" });
  assert.throws(() => buildCapturePresence([{
    entryUrl: TAB.url,
    assetUrls: ["https://cdn.test/image.jpg"],
    presenceAssetUrls: Array.from({ length: 5 }, (_value, index) => `https://cdn.test/${index}.jpg`)
  }], { pageUrl: TAB.url }), { code: "ASSET_LIMIT_INVALID" });
});

test("selection contract enforces request and asset limits", () => {
  const candidate = (index) => ({
    entryUrl: `https://example.test/post/${index}`,
    assetUrls: [`https://cdn.test/${index}.jpg`],
    adapter: "generic"
  });
  assert.throws(() => normalizeSelectedCapture([], { pageUrl: TAB.url }), { code: "ITEM_LIMIT_INVALID" });
  assert.throws(() => normalizeSelectedCapture(
    Array.from({ length: MAX_ITEMS + 1 }, (_value, index) => candidate(index)),
    { pageUrl: TAB.url }
  ), { code: "ITEM_LIMIT_INVALID" });
  assert.throws(() => normalizeSelectedCapture([{
    ...candidate(1),
    assetUrls: Array.from({ length: MAX_ASSETS + 1 }, (_value, index) => `https://cdn.test/${index}.jpg`)
  }], { pageUrl: TAB.url }), { code: "ASSET_LIMIT_INVALID" });
});

test("capture completion keeps partial selections for retry and accepts replayed success", () => {
  assert.equal(captureFullySucceeded({ items: [{ entry_id: 1, outcome_code: "created" }] }), true);
  assert.equal(captureFullySucceeded({ items: [{ entry_id: 1, outcome_code: "already_saved" }] }), true);
  assert.equal(captureFullySucceeded({ items: [{ entry_id: 1, outcome_code: "already_saved_with_asset_skips", assets: [{ visual_asset_id: 2, outcome_code: "CAPTURE_IMAGE_DOWNLOAD_FAILED" }] }] }), false);
  assert.equal(captureFullySucceeded({ replayed: true, items: [{ entry_id: 1, outcome_code: "created" }] }), true);
  assert.equal(captureFullySucceeded({ items: [{ entry_id: 1, outcome_code: "created_with_asset_skips", assets: [{ outcome_code: "CAPTURE_IMAGE_REFERENCE_INVALID" }] }] }), false);
  assert.equal(captureFullySucceeded({ items: [{ entry_id: null, outcome_code: "CAPTURE_ITEM_URL_INVALID" }] }), false);
  assert.deepEqual(summarizeCaptureResult({
    replayed: true,
    counts: { remote_references_added: 1, local_images_added: 0 },
    items: [
      { entry_id: 1, outcome_code: "created_with_asset_skips", assets: [{ visual_asset_id: 2, outcome_code: "CAPTURE_IMAGE_DOWNLOAD_FAILED" }] },
      { entry_id: 2, outcome_code: "already_saved", assets: [{ outcome_code: "attached" }] },
      { entry_id: null, outcome_code: "CAPTURE_ITEM_URL_INVALID", assets: [] }
    ]
  }), {
    completed: false,
    replayed: true,
    entriesSaved: 2,
    entriesCreated: 1,
    entriesAlreadySaved: 1,
    entryIds: [1, 2],
    itemsFailed: 1,
    assetsFailed: 1,
    localCopiesFailed: 1,
    referencesFailed: 0,
    remoteReferencesAdded: 1,
    localImagesAdded: 0,
    localImagesReused: 0
  });
});

test("registry client pairs only with explicit loopback and never returns its bearer token", async () => {
  const storage = storageArea({ accumCaptureLegacy: { untouched: true } });
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url, init });
    if (url.endsWith("pairing-exchanges")) {
      return response({ token: "very-secret-token", client: { id: 8, label: "Test Chrome" } });
    }
    if (url.endsWith("api/v1/client")) return response({ id: 8, label: "Test Chrome" });
    if (url.endsWith("folders/tree")) return response([{ id: 2, name: "References", children: [] }]);
    if (url.endsWith("captures/presence")) return response({ saved: [true, false] });
    return response({ items: [{ entry_id: 9, outcome_code: "created" }] });
  };
  const chromeApi = { runtime: { id: "abcdefghijklmnopabcdefghijklmnop" }, storage: { local: storage } };
  const client = createRegistryClient({ chromeApi, fetchImpl });

  assert.equal(normalizeBaseUrl("http://127.0.0.1:3042/path?ignored=1"), CANONICAL_BASE_URL);
  assert.equal(entryDetailUrl(9), "http://127.0.0.1:3042/?entry=9");
  assert.throws(() => entryDetailUrl("api/v1/entries/9"), { code: "ENTRY_ID_INVALID" });
  for (const value of ["http://localhost:3042/", "https://127.0.0.1:3042/", "http://127.0.0.1/", "http://user:pass@127.0.0.1:3042/", `http://127.0.0.1:${3042 + 1}/`]) {
    assert.throws(() => normalizeBaseUrl(value), { code: "REGISTRY_URL_INVALID" });
  }

  const paired = await client.pair({ baseUrl: CANONICAL_BASE_URL, code: "123456", label: "Test Chrome" });
  assert.deepEqual(paired, {
    connected: true,
    state: "connected",
    baseUrl: CANONICAL_BASE_URL,
    client: { id: 8, label: "Test Chrome" }
  });
  assert.equal("token" in paired, false);
  assert.equal((await client.connection()).token, undefined);
  assert.equal(storage.data.accumCaptureLegacy.untouched, true);
  assert.equal(storage.data[CONFIG_KEY].token, "very-secret-token");

  await client.listFolders();
  assert.deepEqual(await client.capturePresence([
    { entryUrl: TAB.url, assetUrl: "https://cdn.test/saved.jpg" },
    { entryUrl: TAB.url, assetUrl: "https://cdn.test/new.jpg" }
  ]), { saved: [true, false] });
  await client.capture({ adapter: "generic", items: [{ entryUrl: TAB.url }] }, "request-id");
  await client.suggestTags({ query: "ar", exclude: ["archive"], limit: 8 });
  assert.equal(requests[2].init.headers.authorization, "Bearer very-secret-token");
  assert.equal(requests[3].init.headers.authorization, "Bearer very-secret-token");
  assert.equal(requests[4].init.headers.authorization, "Bearer very-secret-token");
  assert.equal(requests[4].init.headers["idempotency-key"], "request-id");
  assert.equal(JSON.parse(requests[3].init.body).items.length, 2);
  assert.equal(new URL(requests[5].url).pathname, "/api/v1/tags/suggestions");
  assert.equal(new URL(requests[5].url).searchParams.get("q"), "ar");
  assert.deepEqual(new URL(requests[5].url).searchParams.getAll("exclude"), ["archive"]);
  assert.equal(requests[5].init.headers.authorization, "Bearer very-secret-token");
  assert.equal(requests.some((request) => Object.hasOwn(request.init, "credentials")), false);
});

test("registry client redacts connection failures", async () => {
  const storage = storageArea({
    [CONFIG_KEY]: { baseUrl: CANONICAL_BASE_URL, token: "never-print-this", client: { id: 1 } }
  });
  const client = createRegistryClient({
    chromeApi: { runtime: { id: "extension" }, storage: { local: storage } },
    fetchImpl: async () => { throw new Error("network leaked https://private.test/?token=never-print-this"); }
  });
  await assert.rejects(() => client.listFolders(), (error) => {
    assert.equal(error.code, "REGISTRY_UNAVAILABLE");
    assert.equal(error.message.includes("never-print-this"), false);
    assert.equal(error.message.includes("private.test"), false);
    assert.match(error.message, /Fastrun Manager/);
    return true;
  });
});

test("registry client verifies stored authorization and normalizes its endpoint to canonical 3042", async () => {
  const storage = storageArea({
    [CONFIG_KEY]: { baseUrl: `http://127.0.0.1:${3042 + 1}/`, token: "existing-token", client: { id: 4, label: "Chrome" } }
  });
  const client = createRegistryClient({
    chromeApi: { runtime: { id: "extension" }, storage: { local: storage } },
    fetchImpl: async () => response({ id: 4, label: "Chrome" })
  });

  assert.deepEqual(await client.connection(), {
    connected: true,
    state: "connected",
    baseUrl: CANONICAL_BASE_URL,
    client: { id: 4, label: "Chrome" }
  });
  assert.equal(storage.data[CONFIG_KEY].baseUrl, CANONICAL_BASE_URL);
  assert.equal(storage.data[CONFIG_KEY].token, "existing-token");
});

test("registry client distinguishes unavailable from revoked authorization without leaking credentials", async () => {
  const unavailableStorage = storageArea({
    [CONFIG_KEY]: { baseUrl: CANONICAL_BASE_URL, token: "offline-secret", client: { id: 4 } }
  });
  const unavailable = createRegistryClient({
    chromeApi: { runtime: { id: "extension" }, storage: { local: unavailableStorage } },
    fetchImpl: async () => { throw new Error("offline-secret"); }
  });
  assert.deepEqual(await unavailable.connection(), {
    connected: false,
    state: "unavailable",
    baseUrl: CANONICAL_BASE_URL,
    client: null
  });
  assert.equal(unavailableStorage.data[CONFIG_KEY].token, "offline-secret");

  const revokedStorage = storageArea({
    [CONFIG_KEY]: { baseUrl: CANONICAL_BASE_URL, token: "revoked-secret", client: { id: 4 } }
  });
  const revoked = createRegistryClient({
    chromeApi: { runtime: { id: "extension" }, storage: { local: revokedStorage } },
    fetchImpl: async () => response(null, { ok: false, status: 401, errorCode: "API_CLIENT_UNAUTHORIZED" })
  });
  assert.deepEqual(await revoked.connection(), {
    connected: false,
    state: "authorization_required",
    baseUrl: CANONICAL_BASE_URL,
    client: null
  });
  assert.equal(revokedStorage.data[CONFIG_KEY], undefined);
});

test("external pairing bridge accepts only the exact 3042 Web UI origin", async () => {
  const calls = [];
  const bridge = createExternalPairingBridge({
    canonicalBaseUrl: CANONICAL_BASE_URL,
    client: { async pair(input) { calls.push(input); return { connected: true }; } }
  });
  assert.deepEqual(await bridge.handle({ type: "WBH_PAIR_WITH_CODE", code: "ABC123" }, {
    url: "http://127.0.0.1:3042/?connect=abcdefghijklmnopabcdefghijklmnop"
  }), { connected: true });
  assert.deepEqual(calls[0], { baseUrl: CANONICAL_BASE_URL, code: "ABC123", label: "Chrome" });
  await assert.rejects(() => bridge.handle({ type: "WBH_PAIR_WITH_CODE", code: "ABC123" }, {
    url: "http://127.0.0.1:3043/"
  }), { code: "PAIRING_SENDER_INVALID" });
  await assert.rejects(() => bridge.handle({ type: "UNKNOWN" }, {
    url: CANONICAL_BASE_URL
  }), { code: "MESSAGE_UNSUPPORTED" });
});

test("selection session is bound to its sender tab and removes only its own session key", async () => {
  const sessionStorage = storageArea({ unrelatedSession: { keep: true } });
  const chromeApi = { storage: { session: sessionStorage } };
  const store = createSelectionSessionStore(chromeApi);
  let counter = 0;
  const started = await store.start(TAB, () => `uuid-${++counter}`, { tags: ["visual"] });
  assert.equal(sessionMatchesTab(started, TAB), true);
  assert.equal(sessionMatchesTab(started, { ...TAB, url: "https://example.test/other" }), false);
  assert.equal(sessionMatchesTab(started, { ...TAB, id: 18 }), false);
  assert.equal(started.id, "uuid-1");
  assert.equal(started.clientRequestId, "uuid-2");
  assert.deepEqual((await store.requireSender({ tab: TAB }, started.id)).userMetadata, { tags: ["visual"] });
  await assert.rejects(() => store.requireSender({ tab: { ...TAB, id: 18 } }, started.id), { code: "SELECTION_SESSION_MISMATCH" });
  await assert.rejects(() => store.requireSender({ tab: { ...TAB, url: "https://example.test/other" } }, started.id), { code: "SELECTION_SESSION_MISMATCH" });
  await store.remember(started, { items: [1] }, { items: [{ outcome_code: "created" }] });
  assert.deepEqual((await store.get()).pendingPayload, { items: [1] });
  await store.remember(await store.get(), null, null, [{ entryUrl: TAB.url, assetUrls: ["https://cdn.test/a.jpg"] }]);
  assert.equal((await store.get()).pendingPayload, null);
  assert.equal((await store.get()).selectedCandidates.length, 1);
  await store.clear();
  assert.equal(await store.get(), null);
  assert.deepEqual(sessionStorage.data.unrelatedSession, { keep: true });
});

test("selection runtime restores exact staged candidates after same-origin reload and clears cross-origin navigation", async () => {
  const sessionStorage = storageArea();
  const sent = [];
  const injections = [];
  const chromeApi = {
    storage: { session: sessionStorage },
    scripting: { async executeScript(input) { injections.push(input); } },
    tabs: { async sendMessage(tabId, message) { sent.push({ tabId, message }); } }
  };
  const store = createSelectionSessionStore(chromeApi);
  let counter = 0;
  const started = await store.start(TAB, () => `uuid-${++counter}`, {});
  const selectedCandidates = [{ entryUrl: TAB.url, assetUrls: ["https://cdn.test/a.jpg"], adapter: "generic" }];
  await store.remember(started, { items: [{ entryUrl: TAB.url }] }, null, selectedCandidates);
  const runtime = createSelectionRuntime({ chromeApi, selections: store });

  assert.deepEqual(await runtime.restore(TAB.id, "https://example.test/articles/reloaded"), {
    restored: true,
    pageUrl: "https://example.test/articles/reloaded"
  });
  assert.deepEqual(injections[0], { target: { tabId: TAB.id }, files: DEFAULT_FILES });
  assert.deepEqual(sent[0].message.session.selectedCandidates, selectedCandidates);
  assert.equal((await store.get()).pageUrl, "https://example.test/articles/reloaded");

  assert.deepEqual(await runtime.restore(TAB.id, "https://other.test/article"), {
    restored: false,
    cleared: true
  });
  assert.equal(await store.get(), null);
});

test("selection runtime keeps staged state after transient reinjection failure and ignores other tabs", async () => {
  const sessionStorage = storageArea();
  const chromeApi = {
    storage: { session: sessionStorage },
    scripting: { async executeScript() { throw new Error("tab is loading"); } },
    tabs: { async sendMessage() {} }
  };
  const store = createSelectionSessionStore(chromeApi);
  let counter = 0;
  await store.start(TAB, () => `uuid-${++counter}`, {});
  const runtime = createSelectionRuntime({ chromeApi, selections: store });

  assert.deepEqual(await runtime.restore(999, TAB.url), { restored: false });
  assert.deepEqual(await runtime.restore(TAB.id, TAB.url), { restored: false, retryable: true });
  assert.notEqual(await store.get(), null);
  assert.deepEqual(await runtime.closeTab(999), { cleared: false });
  assert.deepEqual(await runtime.closeTab(TAB.id), { cleared: true });
});

test("selection session follows only same-origin navigation in its original tab", async () => {
  const sessionStorage = storageArea();
  const store = createSelectionSessionStore({ storage: { session: sessionStorage } });
  let counter = 0;
  const started = await store.start(TAB, () => `uuid-${++counter}`, {});
  assert.equal(started.pageOrigin, "https://example.test");

  const followed = await store.followSender({
    tab: { ...TAB, url: "https://example.test/post/42" }
  }, started.id);
  assert.equal(followed.pageUrl, "https://example.test/post/42");
  assert.equal((await store.requireSender({ tab: { ...TAB, url: followed.pageUrl } }, started.id)).pageUrl, followed.pageUrl);

  await assert.rejects(() => store.followSender({
    tab: { ...TAB, url: "https://other.test/post/42" }
  }, started.id), { code: "SELECTION_NAVIGATION_INVALID" });
  await assert.rejects(() => store.followSender({
    tab: { ...TAB, id: 999, url: followed.pageUrl }
  }, started.id), { code: "SELECTION_SESSION_MISMATCH" });
});

test("shipped extension surface is explicit, local-only, and free of archive execution", () => {
  const manifest = JSON.parse(read("manifest.json"));
  assert.equal(manifest.minimum_chrome_version, "102");
  assert.deepEqual(manifest.permissions, ["activeTab", "scripting", "storage"]);
  assert.deepEqual(manifest.host_permissions, ["http://127.0.0.1/*"]);
  assert.deepEqual(manifest.externally_connectable, { matches: ["http://127.0.0.1/*"] });
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.web_accessible_resources, undefined);
  assert.equal(manifest.commands["save-current-tab"].suggested_key.default, "Ctrl+Shift+E");

  const worker = read("service-worker.js");
  const selectionRuntime = read("extension/selection-runtime.js");
  const content = read("content-script.js");
  const extractor = read("extension/candidate-extractor.js");
  const popup = read("popup.js");
  const popupHtml = read("popup.html");
  const popupCss = read("popup.css");
  assert.match(worker, /chrome\.tabs\.query\(\{ active: true, lastFocusedWindow: true \}\)/);
  assert.match(worker, /buildCurrentTabCapture\(tab, metadata\)/);
  assert.match(worker, /chrome\.commands\?\.onCommand/);
  assert.match(worker, /showBookmarkHubToast/);
  assert.match(worker, /top: "24px", left: "50%"/);
  assert.match(worker, /font: "700 15px\/1\.35/);
  assert.match(worker, /padding: "10px 12px"/);
  assert.match(worker, /border: "1px solid #171715"/);
  assert.match(worker, /boxShadow: "3px 3px 0 #171715"/);
  assert.match(worker, /setTimeout\(\(\) => toast\.remove\(\), 4000\)/);
  assert.match(worker, /link\.textContent = "바로가기"/);
  assert.doesNotMatch(worker, /Entry 열기|6500|22px/);
  assert.match(worker, /transform: "translateX\(-50%\)"/);
  assert.match(worker, /storageReady\s*\.then\(\(\) => handleMessage/);
  assert.ok(worker.indexOf("extension/transport-contract.js") < worker.indexOf("extension/registry-client.js"));
  assert.match(worker, /chrome\.runtime\.onMessageExternal\.addListener/);
  assert.match(worker, /WBH_OPEN_CONNECTION/);
  assert.match(worker, /storage\.local\.setAccessLevel\(\{ accessLevel: "TRUSTED_CONTEXTS" \}\)/);
  assert.doesNotMatch(worker, /message\.(?:url|title)/);
  assert.doesNotMatch(content, /\bfetch\s*\(/);
  assert.doesNotMatch(content, /bearer|authorization|token/iu);
  assert.match(selectionRuntime, /extension\/candidate-extractor\.js/);
  assert.match(selectionRuntime, /extension\/selection-scan-scheduler\.js/);
  assert.ok(selectionRuntime.indexOf("extension/selection-scan-scheduler.js") < selectionRuntime.indexOf("content-script.js"));
  assert.match(content, /new MutationObserver/);
  assert.match(content, /WBH_SELECTION_PAGE_CHANGED/);
  assert.match(content, /wbh-media-selector/);
  assert.match(content, /position: absolute; top: 10px; left: 10px/);
  assert.match(content, /mountHost\.appendChild\(selector\.node\)/);
  assert.match(content, /patchHostPosition\(mountHost\)/);
  assert.doesNotMatch(content, /\.wbh-media-selector \{[^}]*position: fixed/);
  assert.doesNotMatch(content, /accumcapture-overlay/);
  assert.match(content, /Saved/);
  assert.doesNotMatch(content, /wbh-selector-toolbar|Save selected/);
  assert.match(content, /background: #171715; color: #fbfaf5/);
  assert.match(content, /ui-monospace/);
  assert.doesNotMatch(content, /rgba\(21, 128, 61|border-radius: 999px/);
  assert.match(worker, /WBH_SELECTION_UPDATE/);
  assert.match(worker, /WBH_SELECTION_PRESENCE/);
  assert.match(worker, /WBH_TAG_SUGGESTIONS/);
  assert.match(worker, /if \(sender\?\.tab\)/);
  assert.doesNotMatch(content, /WBH_TAG_SUGGESTIONS/);
  assert.match(worker, /sessionMatchesTab\(previous, tab\)/);
  assert.match(worker, /chrome\.tabs\.onUpdated\.addListener/);
  assert.match(worker, /selectionRuntime\.restore/);
  assert.match(worker, /WBH_SAVE_STAGED_SELECTION/);
  assert.match(worker, /catch \(error\) \{\s*await selections\.clear\(\)/);
  assert.match(content, /session\.selectedCandidates/);
  assert.match(content, /state\.persisted/);
  assert.match(content, /Already saved/);
  assert.match(content, /aria-disabled/);
  assert.match(content, /attachShadow\(\{ mode: "closed" \}\)/);
  assert.match(content, /selector\.control\.setAttribute\("aria-checked"/);
  assert.doesNotMatch(content, /selector\.node\.setAttribute\("aria-checked"/);
  assert.match(content, /Saved image state could not be checked\. Rescan to retry\./);
  assert.match(popupHtml, /id="save-tab"[^>]*>현재 페이지 저장</);
  assert.match(popupHtml, /id="start-selection"[^>]*>페이지에서 이미지 선택</);
  assert.match(popupHtml, /id="selection-panel"[^>]*hidden/);
  assert.match(popupHtml, /id="stop-selection"[^>]*aria-label="선택 종료"[^>]*data-tooltip="선택 종료"/);
  assert.match(popupHtml, /id="refresh-selection"[^>]*aria-label="다시 찾기"[^>]*data-tooltip="다시 찾기"/);
  assert.match(popupHtml, /class="selectionHelp"[\s\S]*aria-label="이미지 선택 도움말"/);
  assert.doesNotMatch(popupHtml, /id="selection-hint"/);
  assert.match(popupHtml, /id="save-selection"[^>]*>선택 항목 저장</);
  assert.match(popupHtml, /id="result-entry"/);
  assert.match(popupHtml, /web\/tag-suggestions\.js/);
  assert.match(popupHtml, />바로가기<\/a>/);
  assert.doesNotMatch(popupHtml, /Entry 열기/);
  assert.match(popupHtml, /id="connect-registry"/);
  assert.doesNotMatch(popupHtml, /id="base-url"|id="pairing-code"|id="client-label"/);
  assert.match(popupHtml, /id="capture-visibility"/);
  assert.doesNotMatch(popupHtml, /id="capture-ai-policy"/);
  assert.doesNotMatch(popupHtml + popup, /content-focus|콘텐츠 초점|contentFocus/);
  assert.match(popup, /이미 저장된 주소입니다/);
  assert.match(popup, /보관된 기존 주소입니다/);
  assert.doesNotMatch(popupHtml, /id="capture-policy"/);
  assert.match(popupHtml, /선택 항목 보기/);
  assert.doesNotMatch(popupHtml, /선택 포스트|저장 위치|id="template-label"|id="version-badge"/);
  assert.match(popup, /elements\.selectionPanel\.hidden = !selection\.active && !hasPending/);
  assert.match(popup, /ExistingTagSuggestions\.create/);
  assert.match(popup, /elements\.selectionControls\.hidden = !selection\.active/);
  assert.match(popup, /선택 항목 저장 \(\$\{stagedAssetCount\}\)/);
  assert.match(popup, /입력한 \$\{fields\.join\(", "\)\} 값은 적용되지 않았습니다/);
  assert.doesNotMatch(worker, /new URL\(`\?entry=/);
  assert.equal((worker.match(/entryDetailUrl\(/g) || []).length, 2);
  assert.match(popup, /\$\{summary\.entriesSaved \|\| 0\}개 URL은 저장됨/);
  assert.match(popup, /이미지 캐시 \$\{summary\.localCopiesFailed\}개 실패/);
  assert.doesNotMatch(popup, /일부 항목을 저장하지 못했어요/);
  assert.match(popupCss, /--canvas: #e7e4dc/);
  assert.match(popupCss, /--surface: #fbfaf5/);
  assert.match(popupCss, /--ink: #171715/);
  assert.match(popupCss, /ui-monospace/);
  assert.doesNotMatch(popupCss, /radial-gradient|backdrop-filter|border-radius: 1[2-9]px/);
  assert.match(popupCss, /\[hidden\] \{ display: none !important; \}/);
  assert.match(extractor, /cardMediaSelectors/);
  assert.match(extractor, /detailMediaSelectors/);
  const profiles = read("profiles.js");
  assert.doesNotMatch(profiles, /cardTitleSelectors:\s*\[\s*"/);
  assert.doesNotMatch(profiles, /detailTitleSelectors:\s*\[\s*"/);
  assert.doesNotMatch(`${content}\n${extractor}`, /\bfetch\s*\(/);
  assert.doesNotMatch(`${worker}\n${content}\n${popup}`, /START_ARCHIVE_SYNC|ARCHIVE_SYNC_|ACCUM_CAPTURE_ARCHIVE/);
});

function storageArea(initial = {}) {
  const area = {
    data: structuredClone(initial),
    async get(key) {
      if (typeof key === "string") return { [key]: area.data[key] };
      return structuredClone(area.data);
    },
    async set(values) {
      Object.assign(area.data, structuredClone(values));
    },
    async remove(key) {
      for (const item of Array.isArray(key) ? key : [key]) delete area.data[item];
    }
  };
  return area;
}

function response(data, { ok = true, status = 200, errorCode = "REGISTRY_REQUEST_FAILED" } = {}) {
  return {
    ok,
    status,
    async json() { return ok ? { ok, data } : { ok, error: { code: errorCode, message: "Request rejected." } }; }
  };
}

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}
