"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const test = require("node:test");

const { addEntry, getEntry } = require("../registry/entries.js");
const { createFolder } = require("../registry/folders.js");
const { initializeSelectedImageStorage } = require("../registry/capture-policy.js");
const { openRegistry } = require("../registry/database.js");
const { RegistryError } = require("../registry/errors.js");
const { selectionSnapshotFromQuery } = require("../server/entries-api.js");
const { addLocalImage, addRemoteImageReference, listVisualAssets, removeVisualAsset } = require("../registry/visual-assets.js");
const { IDEMPOTENCY_TTL_MS, MAX_IDEMPOTENCY_RESULTS, createHttpApp, runIdempotentMutation } = require("../server/http-app.js");

const BASE_URL = "http://127.0.0.1:43127";
const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";
const IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
  "55555555-5555-4555-8555-555555555555",
  "66666666-6666-4666-8666-666666666666",
  "77777777-7777-4777-8777-777777777777",
  "88888888-8888-4888-8888-888888888888"
];
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

function fixture(options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wbh-server-api-"));
  const registry = openRegistry({ dbPath: path.join(directory, "registry.sqlite3") });
  initializeSelectedImageStorage(registry, options.selectedImageStorage || "local_copy");
  const app = createHttpApp({
    registry,
    baseUrl: BASE_URL,
    downloadImage: options.downloadImage || syntheticDownload,
    clock: options.clock || Date,
    aiUrlSummary: options.aiUrlSummary
  });
  return { directory, registry, app };
}

test("AI URL summary routes require Web auth, CSRF, a fixed mode, and idempotency", async () => {
  let starts = 0;
  let startedWith;
  const statusValue = {
    status: "idle",
    eligible_count: 3,
    progress: null,
    model: "gpt-5.6-luna",
    reasoning_effort: "max",
    last_run: null
  };
  const runningValue = { ...statusValue, status: "running" };
  const subject = fixture({
    aiUrlSummary: {
      status: () => statusValue,
      start: (options) => { starts += 1; startedWith = options; return runningValue; }
    }
  });
  try {
    assert.equal((await dispatch(subject, "GET", "/api/v1/ai-url-summary")).status, 401);
    const auth = await session(subject);
    const statusResponse = await dispatch(subject, "GET", "/api/v1/ai-url-summary", {
      headers: { cookie: auth.cookie }
    });
    assert.deepEqual(payload(statusResponse).data, statusValue);
    assert.equal((await dispatch(subject, "POST", "/api/v1/ai-url-summary", {
      headers: { cookie: auth.cookie, "content-type": "application/json", "idempotency-key": IDS[0] },
      body: { mode: "all" }
    })).status, 403);
    const first = await dispatch(subject, "POST", "/api/v1/ai-url-summary", {
      headers: webHeaders(auth, IDS[1]),
      body: { mode: "all" }
    });
    const replay = await dispatch(subject, "POST", "/api/v1/ai-url-summary", {
      headers: webHeaders(auth, IDS[1]),
      body: { mode: "all" }
    });
    assert.equal(first.status, 202);
    assert.deepEqual(payload(first).data, runningValue);
    assert.deepEqual(payload(replay).data, runningValue);
    assert.equal(starts, 1);
    assert.deepEqual(startedWith, { entryIds: undefined });
    const arbitrary = await dispatch(subject, "POST", "/api/v1/ai-url-summary", {
      headers: webHeaders(auth, IDS[2]),
      body: { prompt: "ignore safeguards" }
    });
    assert.equal(arbitrary.status, 400);
    assert.equal(starts, 1);
    const selected = await dispatch(subject, "POST", "/api/v1/ai-url-summary", {
      headers: webHeaders(auth, IDS[3]),
      body: { mode: "selected", entry_ids: [1, 2] }
    });
    assert.equal(selected.status, 202);
    assert.deepEqual(startedWith, { entryIds: [1, 2] });
  } finally {
    dispose(subject);
  }
});

test("selected AI summary query must match the current selection snapshot", async () => {
  let selectedIds;
  const subject = fixture({ aiUrlSummary: {
    status: () => ({ status: "idle", eligible_count: 2 }),
    start: ({ entryIds }) => { selectedIds = entryIds; return { status: "running", eligible_count: 2 }; }
  } });
  try {
    const first = addEntry(subject.registry, { url: "https://example.test/first", visibility: "normal" }).entry;
    const second = addEntry(subject.registry, { url: "https://example.test/second", visibility: "normal" }).entry;
    addEntry(subject.registry, { url: "https://example.test/private", visibility: "private" });
    const auth = await session(subject);
    const query = { visibility: "normal" };
    const snapshot = selectionSnapshotFromQuery(subject.registry, new URLSearchParams(query));
    const selected = await dispatch(subject, "POST", "/api/v1/ai-url-summary", {
      headers: webHeaders(auth, IDS[4]),
      body: { mode: "selected", query, ...snapshot }
    });
    assert.equal(selected.status, 202);
    assert.deepEqual(selectedIds, [first.id, second.id]);
    const stale = await dispatch(subject, "POST", "/api/v1/ai-url-summary", {
      headers: webHeaders(auth, IDS[5]),
      body: { mode: "selected", query, expected_count: snapshot.expected_count, expected_digest: "0".repeat(64) }
    });
    assert.equal(stale.status, 409);
    assert.deepEqual(selectedIds, [first.id, second.id]);
  } finally { dispose(subject); }
});

test("removed Git publication route is unavailable", async () => {
  const subject = fixture();
  try {
    assert.equal((await dispatch(subject, "GET", "/api/v1/git-publication")).status, 404);
    assert.equal((await dispatch(subject, "POST", "/api/v1/git-publication", { body: {} })).status, 404);
  } finally {
    dispose(subject);
  }
});

async function syntheticDownload(registry) {
  const staging = path.join(registry.dataDir, "capture-staging");
  fs.mkdirSync(staging, { recursive: true });
  const filePath = path.join(staging, `${randomUUID()}.png`);
  fs.writeFileSync(filePath, PNG);
  return { filePath, byteSize: PNG.length, finalUrl: "https://cdn.synthetic.test/image.png" };
}

function dispose(subject) {
  subject.registry.close();
  fs.rmSync(subject.directory, { recursive: true, force: true, maxRetries: 3 });
}

async function dispatch(subject, method, url, { headers = {}, body, remoteAddress = "127.0.0.1" } = {}) {
  return subject.app.dispatch({
    method,
    url,
    remoteAddress,
    headers: { host: "127.0.0.1:43127", ...headers },
    body
  });
}

function payload(response) {
  return JSON.parse(String(response.body));
}

async function session(subject) {
  const response = await dispatch(subject, "GET", "/api/v1/session", {
    headers: { "sec-fetch-site": "same-origin" }
  });
  const data = payload(response).data;
  return {
    cookie: response.headers["set-cookie"].split(";", 1)[0],
    csrf: data.csrf_token
  };
}

function webHeaders(auth, idempotencyKey) {
  return {
    cookie: auth.cookie,
    "x-csrf-token": auth.csrf,
    "content-type": "application/json",
    ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {})
  };
}

async function pair(subject, auth, idempotencyKey = IDS[0]) {
  const codeResponse = await dispatch(subject, "POST", "/api/v1/pairing-codes", {
    headers: webHeaders(auth, idempotencyKey),
    body: {}
  });
  const code = payload(codeResponse).data.code;
  const exchange = await dispatch(subject, "POST", "/api/v1/pairing-exchanges", {
    headers: {
      "content-type": "application/json",
      origin: `chrome-extension://${EXTENSION_ID}`
    },
    body: { code, extension_id: EXTENSION_ID, label: "Test Chrome" }
  });
  return payload(exchange).data;
}

test("HTTP matrix requires loopback web sessions, CSRF, idempotency, and bearer capture", async () => {
  const subject = fixture();
  try {
    const health = await dispatch(subject, "GET", "/api/v1/health");
    assert.equal(health.status, 200);
    assert.deepEqual(payload(health).data.capabilities, { permanent_delete: true });
    assert.equal(payload(health).data.api_version, 1);
    assert.equal(payload(health).data.schema_version, 17);
    assert.equal((await dispatch(subject, "GET", "/api/v1/health", { remoteAddress: "192.0.2.4" })).status, 403);
    assert.equal((await dispatch(subject, "POST", "/api/v1/health")).status, 405);
    assert.equal((await dispatch(subject, "GET", "/api/v1/entries")).status, 401);
    assert.equal((await dispatch(subject, "GET", "/api/v1/session", {
      headers: { origin: "https://evil.test" }
    })).status, 403);

    const auth = await session(subject);
    assert.equal((await dispatch(subject, "POST", "/api/v1/entries", {
      headers: { cookie: auth.cookie, "content-type": "application/json", "idempotency-key": IDS[0] },
      body: { url: "https://example.test/no-csrf" }
    })).status, 403);
    assert.equal((await dispatch(subject, "POST", "/api/v1/entries", {
      headers: webHeaders(auth),
      body: { url: "https://example.test/no-key" }
    })).status, 400);

    const client = await pair(subject, auth);
    assert.equal(subject.registry.db.prepare("SELECT token_sha256 FROM api_clients").get().token_sha256.includes(client.token), false);
    assert.equal((await dispatch(subject, "POST", "/api/v1/captures", {
      headers: { "content-type": "application/json", "idempotency-key": IDS[1] },
      body: { adapter: "generic", items: [{ entryUrl: "https://capture.test/unauthorized" }] }
    })).status, 401);
    assert.equal((await dispatch(subject, "POST", "/api/v1/captures/presence", {
      headers: { "content-type": "application/json" },
      body: { items: [{ entryUrl: "https://capture.test/current-tab", assetUrl: "https://images.test/cover.png" }] }
    })).status, 401);
    const captured = await dispatch(subject, "POST", "/api/v1/captures", {
      headers: {
        "content-type": "application/json",
        "idempotency-key": IDS[1],
        authorization: `Bearer ${client.token}`,
        origin: `chrome-extension://${EXTENSION_ID}`
      },
      body: { adapter: "generic", items: [{ entryUrl: "https://capture.test/current-tab" }] }
    });
    assert.equal(captured.status, 201);
    assert.equal(getEntry(subject.registry, payload(captured).data.items[0].entry_id).created_via, "chrome");
    addRemoteImageReference(
      subject.registry,
      payload(captured).data.items[0].entry_id,
      "https://images.test/cover.png#stored",
      { sourceKind: "browser_selected" }
    );
    const presenceHeaders = {
      "content-type": "application/json",
      authorization: `Bearer ${client.token}`,
      origin: `chrome-extension://${EXTENSION_ID}`
    };
    const presence = await dispatch(subject, "POST", "/api/v1/captures/presence", {
      headers: presenceHeaders,
      body: { items: [
        {
          entryUrl: "https://capture.test/current-tab?utm_source=ignored",
          assetUrls: ["https://images.test/responsive-cover.png", "https://images.test/cover.png#page"]
        },
        { entryUrl: "https://capture.test/current-tab", assetUrl: "https://images.test/new.png" }
      ] }
    });
    assert.equal(presence.status, 200);
    assert.deepEqual(payload(presence).data, { saved: [true, false] });
    assert.deepEqual(Object.keys(payload(presence).data), ["saved"]);
    const tooManyPresence = await dispatch(subject, "POST", "/api/v1/captures/presence", {
      headers: presenceHeaders,
      body: { items: Array.from({ length: 101 }, () => ({
        entryUrl: "https://capture.test/current-tab",
        assetUrl: "https://images.test/cover.png"
      })) }
    });
    assert.equal(tooManyPresence.status, 400);
    assert.equal(payload(tooManyPresence).error.code, "CAPTURE_PRESENCE_LIMIT_INVALID");
    const currentClient = await dispatch(subject, "GET", "/api/v1/client", {
      headers: { authorization: `Bearer ${client.token}`, origin: `chrome-extension://${EXTENSION_ID}` }
    });
    assert.equal(currentClient.status, 200);
    assert.equal(payload(currentClient).data.id, client.client.id);
    assert.equal(JSON.stringify(payload(currentClient)).includes(client.token), false);
    assert.equal((await dispatch(subject, "GET", "/api/v1/folders/tree", {
      headers: { authorization: `Bearer ${client.token}`, origin: `chrome-extension://${EXTENSION_ID}` }
    })).status, 200);

    const clients = await dispatch(subject, "GET", "/api/v1/clients", { headers: { cookie: auth.cookie } });
    assert.equal(payload(clients).data.length, 1);
    assert.equal(JSON.stringify(payload(clients)).includes(client.token), false);
    const revoked = await dispatch(subject, "POST", `/api/v1/clients/${client.client.id}/revoke`, {
      headers: webHeaders(auth, IDS[2]),
      body: {}
    });
    assert.equal(revoked.status, 200);
    assert.equal((await dispatch(subject, "GET", "/api/v1/client", {
      headers: { authorization: `Bearer ${client.token}` }
    })).status, 401);
    assert.equal((await dispatch(subject, "POST", "/api/v1/captures", {
      headers: {
        "content-type": "application/json",
        "idempotency-key": IDS[3],
        authorization: `Bearer ${client.token}`
      },
      body: { items: [{ entryUrl: "https://capture.test/revoked" }] }
    })).status, 401);
  } finally {
    dispose(subject);
  }
});

test("Entry, comments, tags, Folder, URL Group, filters, and idempotent replay share one Registry", async () => {
  const subject = fixture();
  try {
    const auth = await session(subject);
    const folder = createFolder(subject.registry, { name: "Saved" });
    const firstBody = {
      url: "https://api.test/images/one?utm_source=synthetic",
      title: "Needle Alpha",
      kind: "animation",
      folder_id: folder.id,
      content_focus: "visual",
      tags: ["chosen", "art"],
      comment: "First note"
    };
    const first = await dispatch(subject, "POST", "/api/v1/entries", {
      headers: webHeaders(auth, IDS[0]),
      body: firstBody
    });
    assert.equal(first.status, 201);
    const firstData = payload(first).data;
    assert.equal(firstData.entry.kind, "image");
    const replay = await dispatch(subject, "POST", "/api/v1/entries", {
      headers: webHeaders(auth, IDS[0]),
      body: { ...firstBody }
    });
    assert.equal(replay.status, 201);
    assert.equal(payload(replay).data.entry.id, firstData.entry.id);
    assert.equal(subject.registry.db.prepare("SELECT COUNT(*) AS count FROM entry_comments").get().count, 1);
    const conflict = await dispatch(subject, "POST", "/api/v1/entries", {
      headers: webHeaders(auth, IDS[0]),
      body: { ...firstBody, title: "Changed" }
    });
    assert.equal(conflict.status, 409);

    const second = await dispatch(subject, "POST", "/api/v1/entries", {
      headers: webHeaders(auth, IDS[1]),
      body: {
        url: "https://api.test/images/two",
        title: "Needle Beta",
        folder_id: folder.id,
        tags: ["chosen"]
      }
    });
    assert.equal(second.status, 201);
    const secondData = payload(second).data;

    const batch = await dispatch(subject, "POST", "/api/v1/entries/batch", {
      headers: webHeaders(auth, IDS[4]),
      body: {
        entry_ids: [firstData.entry.id, secondData.entry.id],
        operation: "set_policy",
        value: { visibility: "normal" },
        reason: "Synthetic batch test"
      }
    });
    assert.equal(batch.status, 200);
    assert.equal(payload(batch).data.matched, 2);
    assert.equal(payload(batch).data.changed, 2);
    assert.equal(getEntry(subject.registry, firstData.entry.id).visibility, "normal");
    const selection = await dispatch(subject, "GET", `/api/v1/entries/selection-snapshot?search=needle&folder_id=${folder.id}`, {
      headers: { cookie: auth.cookie }
    });
    assert.equal(selection.status, 200);
    assert.match(payload(selection).data.expected_digest, /^[0-9a-f]{64}$/);
    const queryBatch = await dispatch(subject, "POST", "/api/v1/entries/batch", {
      headers: webHeaders(auth, IDS[6]),
      body: {
        query: { search: "needle", folder_id: folder.id },
        expected_count: payload(selection).data.expected_count,
        expected_digest: payload(selection).data.expected_digest,
        operation: "set_kind",
        value: { kind: "research" },
        reason: "Synthetic query batch test"
      }
    });
    assert.equal(queryBatch.status, 200);
    assert.deepEqual([payload(queryBatch).data.matched, payload(queryBatch).data.changed], [2, 2]);
    assert.equal("entries" in payload(queryBatch).data, false);
    const staleQueryBatch = await dispatch(subject, "POST", "/api/v1/entries/batch", {
      headers: webHeaders(auth, IDS[7]),
      body: {
        query: { search: "needle", folder_id: folder.id },
        expected_count: 1,
        expected_digest: payload(selection).data.expected_digest,
        operation: "set_policy",
        value: { visibility: "private" }
      }
    });
    assert.equal(staleQueryBatch.status, 409);
    assert.equal(payload(staleQueryBatch).error.code, "BATCH_QUERY_CHANGED");
    addRemoteImageReference(subject.registry, firstData.entry.id, "https://cdn.example.test/needle-alpha.jpg", { makeCover: true });

    const groupsResponse = await dispatch(subject, "GET", "/api/v1/url-groups", { headers: { cookie: auth.cookie } });
    const groups = payload(groupsResponse).data;
    const pathGroup = groups.flatMap((group) => [group, ...group.children]).find((group) => group.label === "api.test/images");
    assert.ok(pathGroup);
    const list = await dispatch(subject, "GET", `/api/v1/entries?search=needle&sort=oldest&tag=chosen&folder_id=${folder.id}&url_group_id=${encodeURIComponent(pathGroup.id)}`, {
      headers: { cookie: auth.cookie }
    });
    assert.deepEqual(payload(list).data.items.map((entry) => entry.title), ["Needle Alpha", "Needle Beta"]);
    assert.deepEqual(payload(list).data.items[0].tags.map((tag) => tag.normalized_name), ["art", "chosen"]);
    const withPreview = await dispatch(subject, "GET", "/api/v1/entries?preview=with&sort=title_desc", {
      headers: { cookie: auth.cookie }
    });
    const withoutPreview = await dispatch(subject, "GET", "/api/v1/entries?preview=without", {
      headers: { cookie: auth.cookie }
    });
    assert.deepEqual(payload(withPreview).data.items.map((entry) => entry.id), [firstData.entry.id]);
    assert.deepEqual(payload(withoutPreview).data.items.map((entry) => entry.id), [secondData.entry.id]);

    const comments = await dispatch(subject, "GET", `/api/v1/entries/${firstData.entry.id}/comments`, {
      headers: { cookie: auth.cookie }
    });
    assert.equal(payload(comments).data.total, 1);
    const addedComment = await dispatch(subject, "POST", `/api/v1/entries/${firstData.entry.id}/comments`, {
      headers: webHeaders(auth, IDS[2]),
      body: { text: "Second note" }
    });
    assert.equal(addedComment.status, 201);
    await dispatch(subject, "POST", `/api/v1/entries/${firstData.entry.id}/comments`, {
      headers: webHeaders(auth, IDS[2]),
      body: { text: "Second note" }
    });
    assert.equal(subject.registry.db.prepare("SELECT COUNT(*) AS count FROM entry_comments").get().count, 2);

    assert.equal(payload(await dispatch(subject, "GET", "/api/v1/insights/tags?limit=5", { headers: { cookie: auth.cookie } })).data[0].normalized_name, "chosen");
    const webSuggestions = await dispatch(subject, "GET", "/api/v1/tags/suggestions?q=AR&exclude=chosen&limit=8", {
      headers: { cookie: auth.cookie }
    });
    assert.deepEqual(payload(webSuggestions).data.map((tag) => tag.normalized_name), ["art"]);
    const paired = await pair(subject, auth, IDS[5]);
    const chromeSuggestions = await dispatch(subject, "GET", "/api/v1/tags/suggestions?q=cho&limit=8", {
      headers: {
        authorization: `Bearer ${paired.token}`,
        origin: `chrome-extension://${EXTENSION_ID}`
      }
    });
    assert.equal(chromeSuggestions.status, 200, String(chromeSuggestions.body));
    assert.deepEqual(payload(chromeSuggestions).data.map((tag) => tag.normalized_name), ["chosen"]);
    assert.equal(JSON.stringify(payload(chromeSuggestions)).includes("url_original"), false);
    assert.equal(payload(await dispatch(subject, "GET", "/api/v1/folders/tree", { headers: { cookie: auth.cookie } })).data[0].id, folder.id);
    assert.equal((await dispatch(subject, "GET", "/api/v1/entries/99999", { headers: { cookie: auth.cookie } })).status, 404);
    assert.equal((await dispatch(subject, "GET", "/api/v1/entries?url_group_id=stale", { headers: { cookie: auth.cookie } })).status, 404);
  } finally {
    dispose(subject);
  }
});

test("concurrent identical comment requests create one row and share the response", async () => {
  const subject = fixture();
  try {
    const auth = await session(subject);
    const entry = addEntry(subject.registry, { url: "https://example.test/concurrent-comment" }).entry;
    const options = { headers: webHeaders(auth, IDS[0]), body: { text: "One synthetic comment" } };
    const [first, second] = await Promise.all([
      dispatch(subject, "POST", `/api/v1/entries/${entry.id}/comments`, options),
      dispatch(subject, "POST", `/api/v1/entries/${entry.id}/comments`, options)
    ]);
    assert.equal(first.status, 201);
    assert.deepEqual(second, first);
    assert.equal(subject.registry.db.prepare("SELECT COUNT(*) AS count FROM entry_comments WHERE entry_id = ?").get(entry.id).count, 1);
  } finally {
    dispose(subject);
  }
});

test("pending idempotent work survives expiry, conflicts immediately and starts TTL at completion", async () => {
  const cache = new Map();
  const session = { requesterScope: "web:pending" };
  const request = { method: "POST", url: "/synthetic", headers: { "idempotency-key": IDS[0] } };
  let milliseconds = 1000;
  const clock = { now: () => milliseconds };
  let complete;
  let calls = 0;
  const action = () => { calls += 1; return new Promise((resolve) => { complete = resolve; }); };
  const first = runIdempotentMutation(cache, session, request, { value: 1 }, action, clock);
  await Promise.resolve();
  milliseconds += IDEMPOTENCY_TTL_MS + 1;
  const second = runIdempotentMutation(cache, session, request, { value: 1 }, action, clock);
  await assert.rejects(runIdempotentMutation(cache, session, request, { value: 2 }, action, clock), { code: "CAPTURE_REQUEST_CONFLICT" });
  assert.equal(calls, 1);
  complete({ saved: 1 });
  assert.deepEqual(await first, { saved: 1 });
  assert.deepEqual(await second, { saved: 1 });
  milliseconds += IDEMPOTENCY_TTL_MS - 1;
  assert.deepEqual(await runIdempotentMutation(cache, session, request, { value: 1 }, () => assert.fail("unexpired replay ran again"), clock), { saved: 1 });
  milliseconds += 2;
  assert.deepEqual(await runIdempotentMutation(cache, session, request, { value: 2 }, () => ({ saved: 2 }), clock), { saved: 2 });
});

test("failed idempotent work is shared and released for an explicit retry", async () => {
  const cache = new Map();
  const session = { requesterScope: "web:retry" };
  const request = { method: "POST", url: "/synthetic", headers: { "idempotency-key": IDS[0] } };
  let calls = 0;
  const action = () => { calls += 1; throw new Error("synthetic failure"); };
  const results = await Promise.allSettled([
    runIdempotentMutation(cache, session, request, {}, action),
    runIdempotentMutation(cache, session, request, {}, action)
  ]);
  assert.equal(calls, 1);
  assert.equal(results.every((result) => result.status === "rejected" && result.reason.message === "synthetic failure"), true);
  assert.equal(cache.size, 0);
  assert.deepEqual(await runIdempotentMutation(cache, session, request, {}, () => ({ retried: true })), { retried: true });
});

test("all-pending idempotency capacity rejects new work without evicting a pending replay", async () => {
  const cache = new Map();
  const session = { requesterScope: "web:capacity" };
  let complete;
  const waiting = new Promise((resolve) => { complete = resolve; });
  const pending = [];
  const request = (index) => ({ method: "POST", url: "/synthetic", headers: {
    "idempotency-key": `${index.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`
  } });
  let calls = 0;
  for (let index = 0; index < MAX_IDEMPOTENCY_RESULTS; index += 1) {
    pending.push(runIdempotentMutation(cache, session, request(index), {}, () => { calls += 1; return waiting; }));
  }
  await assert.rejects(runIdempotentMutation(cache, session, request(MAX_IDEMPOTENCY_RESULTS), {}, () => assert.fail("over-capacity work started")), (error) => {
    assert.equal(require("../server/responses.js").fail(error).status, 503);
    return error.code === "IDEMPOTENCY_CAPACITY_EXCEEDED";
  });
  const replay = runIdempotentMutation(cache, session, request(0), {}, () => assert.fail("pending replay ran again"));
  assert.equal(cache.size, MAX_IDEMPOTENCY_RESULTS);
  assert.equal(calls, MAX_IDEMPOTENCY_RESULTS);
  complete({ done: true });
  await Promise.all([...pending, replay]);
  assert.deepEqual(await runIdempotentMutation(cache, session, request(MAX_IDEMPOTENCY_RESULTS), {}, () => ({ added: true })), { added: true });
  assert.equal(cache.size, MAX_IDEMPOTENCY_RESULTS);
});

test("Web idempotency replays within fifteen minutes and expires afterward", async () => {
  let milliseconds = Date.parse("2026-09-03T00:00:00.000Z");
  const subject = fixture({ clock: { now: () => milliseconds } });
  try {
    const auth = await session(subject);
    const first = await dispatch(subject, "POST", "/api/v1/folders", {
      headers: webHeaders(auth, IDS[0]),
      body: { name: "First" }
    });
    assert.equal(first.status, 201);
    const replay = await dispatch(subject, "POST", "/api/v1/folders", {
      headers: webHeaders(auth, IDS[0]),
      body: { name: "First" }
    });
    assert.deepEqual(payload(replay), payload(first));
    const conflict = await dispatch(subject, "POST", "/api/v1/folders", {
      headers: webHeaders(auth, IDS[0]),
      body: { name: "Second" }
    });
    assert.equal(payload(conflict).error.code, "CAPTURE_REQUEST_CONFLICT");
    milliseconds += IDEMPOTENCY_TTL_MS + 1;
    const expired = await dispatch(subject, "POST", "/api/v1/folders", {
      headers: webHeaders(auth, IDS[0]),
      body: { name: "Second" }
    });
    assert.equal(expired.status, 201);
    assert.equal(subject.registry.db.prepare("SELECT COUNT(*) AS count FROM folders").get().count, 2);
  } finally {
    dispose(subject);
  }
});

test("Web idempotency results evict the oldest entry at the fixed cap", async () => {
  const cache = new Map();
  const session = { requesterScope: "web:test" };
  const clock = { now: () => 1_000 };
  for (let index = 0; index <= MAX_IDEMPOTENCY_RESULTS; index += 1) {
    const key = `${index.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
    await runIdempotentMutation(cache, session, {
      method: "POST",
      url: "/synthetic",
      headers: { "idempotency-key": key }
    }, { index }, async () => ({ index }), clock);
  }
  assert.equal(cache.size, MAX_IDEMPOTENCY_RESULTS);
  assert.equal(cache.has("web:test:00000000-0000-4000-8000-000000000000"), false);
});

test("sidebar APIs apply active retrieval filters to Folder and URL projections", async () => {
  const subject = fixture();
  try {
    const auth = await session(subject);
    const normalFolder = createFolder(subject.registry, { name: "Normal" });
    const privateFolder = createFolder(subject.registry, { name: "Private" });
    addEntry(subject.registry, {
      url: "https://normal.test/item",
      title: "Visible",
      folderId: normalFolder.id,
      visibility: "normal",
      agentAccess: "allowed",
      aiProcessing: "enabled"
    });
    addEntry(subject.registry, {
      url: "https://private.test/item",
      title: "Hidden",
      folderId: privateFolder.id,
      visibility: "private",
      agentAccess: "allowed",
      aiProcessing: "enabled"
    });

    const folders = payload(await dispatch(subject, "GET", "/api/v1/folders/tree?visibility=normal", {
      headers: { cookie: auth.cookie }
    })).data;
    const groups = payload(await dispatch(subject, "GET", "/api/v1/url-groups?visibility=normal", {
      headers: { cookie: auth.cookie }
    })).data;
    assert.deepEqual(folders.map((folder) => folder.name), ["Normal"]);
    assert.deepEqual(groups.map((group) => group.label), ["normal.test"]);
  } finally {
    dispose(subject);
  }
});

test("Chrome capture accepts trusted popup policy, localizes valid images, and rejects unknown authority", async () => {
  const subject = fixture();
  const previousFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = () => { fetchCalls += 1; throw new Error("must not fetch"); };
  try {
    const auth = await session(subject);
    const paired = await pair(subject, auth);
    const headers = {
      "content-type": "application/json",
      "idempotency-key": IDS[1],
      authorization: `Bearer ${paired.token}`,
      origin: `chrome-extension://${EXTENSION_ID}`
    };
    const body = {
      adapter: "generic-image-selector",
      items: [
        {
          entryUrl: "https://gallery.test/post?kept=1",
          selectedAt: "2026-08-31T02:00:00.000Z",
          assetUrls: ["https://cdn.gallery.test/a.jpg", "data:image/png;base64,AAAA"]
        },
        { title: "missing URL" }
      ]
    };
    const first = await dispatch(subject, "POST", "/api/v1/captures", { headers, body });
    assert.equal(first.status, 201);
    assert.deepEqual(payload(first).data.items.map((item) => item.outcome_code), ["created_with_asset_skips", "CAPTURE_ITEM_URL_REQUIRED"]);
    const capturedAssets = subject.registry.db.prepare("SELECT storage_kind, status FROM entry_visual_assets ORDER BY id").all()
      .map((row) => ({ storage_kind: row.storage_kind, status: row.status }));
    assert.deepEqual(capturedAssets, [{ storage_kind: "local", status: "ready" }]);
    const replay = await dispatch(subject, "POST", "/api/v1/captures", { headers, body });
    assert.equal(payload(replay).data.replayed, true);
    assert.deepEqual(payload(replay).data.items, payload(first).data.items);
    assert.equal(fetchCalls, 0);

    const firstAsset = subject.registry.db.prepare("SELECT id FROM entry_visual_assets ORDER BY id LIMIT 1").get();
    await removeVisualAsset(subject.registry, firstAsset.id);
    const reattached = await dispatch(subject, "POST", "/api/v1/captures", {
      headers: { ...headers, "idempotency-key": IDS[4] },
      body: {
        adapter: "generic-image-selector",
        items: [{
          entryUrl: "https://gallery.test/post?kept=1",
          assetUrls: ["https://cdn.gallery.test/a.jpg"]
        }]
      }
    });
    assert.equal(payload(reattached).data.items[0].outcome_code, "already_saved");
    assert.equal(payload(reattached).data.items[0].assets[0].outcome_code, "downloaded");
    assert.deepEqual(
      subject.registry.db.prepare("SELECT storage_kind, status FROM entry_visual_assets ORDER BY id").all()
        .map((row) => ({ storage_kind: row.storage_kind, status: row.status })),
      [{ storage_kind: "local", status: "ready" }]
    );

    const localAsset = subject.registry.db.prepare("SELECT storage_path FROM entry_visual_assets ORDER BY id LIMIT 1").get();
    const missingPath = path.join(subject.registry.dataDir, ...localAsset.storage_path.split("/"));
    fs.rmSync(missingPath);
    const repaired = await dispatch(subject, "POST", "/api/v1/captures", {
      headers: { ...headers, "idempotency-key": IDS[5] },
      body: {
        adapter: "generic-image-selector",
        items: [{
          entryUrl: "https://gallery.test/post?kept=1",
          assetUrls: ["https://cdn.gallery.test/a.jpg"]
        }]
      }
    });
    assert.equal(payload(repaired).data.items[0].outcome_code, "already_saved");
    assert.equal(payload(repaired).data.items[0].assets[0].outcome_code, "local_duplicate");
    assert.equal(fs.existsSync(missingPath), true);

    const folder = createFolder(subject.registry, { name: "Chrome saves" });
    const enriched = await dispatch(subject, "POST", "/api/v1/captures", {
      headers: { ...headers, "idempotency-key": IDS[3] },
      body: {
        adapter: "current-tab",
        items: [{
          entryUrl: "https://gallery.test/with-user-context",
          title: "Explicit browser save",
          comment: "Why this link matters",
          tags: ["reference", "visual"],
          folderId: folder.id,
          contentFocus: "text",
          visibility: "normal",
          agentAccess: "metadata_only",
          aiProcessing: "manual"
        }]
      }
    });
    assert.equal(enriched.status, 201);
    const enrichedEntry = getEntry(subject.registry, payload(enriched).data.items[0].entry_id);
    assert.equal(enrichedEntry.folder_id, folder.id);
    assert.equal(enrichedEntry.content_focus, "text");
    assert.equal(enrichedEntry.comment_count, 1);
    assert.deepEqual(
      [enrichedEntry.visibility, enrichedEntry.agent_access, enrichedEntry.ai_processing],
      ["normal", "allowed", "enabled"]
    );
    assert.deepEqual(enrichedEntry.tags.map((tag) => tag.name), ["reference", "visual"]);

    const smuggle = await dispatch(subject, "POST", "/api/v1/captures", {
      headers: { ...headers, "idempotency-key": IDS[2] },
      body: {
        items: [{
          entryUrl: "https://gallery.test/smuggle",
          folderId: 1,
          visibility: "normal",
          createdVia: "legacy"
        }]
      }
    });
    assert.equal(smuggle.status, 400);
    assert.equal(payload(smuggle).error.code, "VALIDATION_ERROR");
  } finally {
    global.fetch = previousFetch;
    dispose(subject);
  }
});

test("shortcut evidence is policy-gated, Entry-bound, staged without HTML retention, and queued", async () => {
  let startedWith;
  const subject = fixture({
    aiUrlSummary: {
      status: () => ({ status: "idle" }),
      start: (options) => {
        startedWith = options;
        return { status: "running", newly_queued: 1 };
      }
    }
  });
  try {
    const auth = await session(subject);
    const client = await pair(subject, auth, randomUUID());
    const extensionHeaders = {
      "content-type": "application/json",
      authorization: `Bearer ${client.token}`,
      origin: `chrome-extension://${EXTENSION_ID}`
    };
    const sourceUrl = "https://example.test/shortcut/article";
    const captured = await dispatch(subject, "POST", "/api/v1/captures", {
      headers: { ...extensionHeaders, "idempotency-key": randomUUID() },
      body: { adapter: "current-tab", items: [{ entryUrl: sourceUrl, visibility: "normal" }] }
    });
    assert.equal(captured.status, 201);
    const capturedItem = payload(captured).data.items[0];
    assert.deepEqual(capturedItem.enrichment, { allowed: true, needs_summary: true, reason: null });

    const stagingRoot = path.join(subject.registry.dataDir, "shortcut-enrichment-staging");
    const staleDirectory = path.join(stagingRoot, "stale-capture");
    fs.mkdirSync(staleDirectory, { recursive: true });
    fs.writeFileSync(path.join(staleDirectory, "page.html"), "stale");
    const staleTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(staleDirectory, staleTime, staleTime);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const evidence = await dispatch(subject, "POST", `/api/v1/captures/${capturedItem.entry_id}/shortcut-evidence`, {
      headers: extensionHeaders,
      body: {
        url: sourceUrl,
        capturedAt: "2026-09-20T00:00:00.000Z",
        html: "<!doctype html><html><head><title>Captured article</title></head><body><main><h1>Captured article</h1><p>Exact visible article content for the saved page.</p></main></body></html>",
        screenshotDataUrl: `data:image/jpeg;base64,${jpeg.toString("base64")}`
      }
    });
    assert.equal(evidence.status, 202);
    assert.deepEqual(payload(evidence).data, { queued: true, deduplicated: false, screenshot_fallback: true });
    assert.equal(fs.existsSync(staleDirectory), false);
    assert.equal(startedWith.entryIds[0], capturedItem.entry_id);
    assert.equal(startedWith.entryContext.verifiedEvidence.content, "Captured article Exact visible article content for the saved page.");
    assert.equal(fs.existsSync(path.join(subject.registry.dataDir, "shortcut-enrichment-staging",
      path.basename(path.dirname(startedWith.entryContext.fallbackImageFile)), "page.html")), false);
    assert.equal(fs.existsSync(startedWith.entryContext.fallbackImageFile), true);
    await startedWith.entryContext.cleanup();
    assert.equal(fs.existsSync(path.dirname(startedWith.entryContext.fallbackImageFile)), false);

    const imageEntry = addEntry(subject.registry, {
      url: "https://example.test/shortcut/with-image",
      visibility: "normal"
    }).entry;
    startedWith = null;
    const withImage = await dispatch(subject, "POST", `/api/v1/captures/${imageEntry.id}/shortcut-evidence`, {
      headers: extensionHeaders,
      body: {
        url: imageEntry.url_original,
        capturedAt: "2026-09-20T00:00:00.000Z",
        html: "<html><head><title>Image article</title><meta property='og:image' content='https://cdn.test/cover.jpg'></head><body><main>Image article body</main></body></html>",
        screenshotDataUrl: `data:image/jpeg;base64,${jpeg.toString("base64")}`
      }
    });
    assert.deepEqual(payload(withImage).data, { queued: true, deduplicated: false, screenshot_fallback: false });
    assert.equal(startedWith.entryContext.fallbackImageFile, null);
    const staged = stagingRoot;
    const stagedDirectories = fs.readdirSync(staged);
    assert.equal(stagedDirectories.length, 1);
    assert.deepEqual(fs.readdirSync(path.join(staged, stagedDirectories[0])), []);
    await startedWith.entryContext.cleanup();

    const mismatchEntry = addEntry(subject.registry, {
      url: "https://example.test/shortcut/mismatch",
      visibility: "normal"
    }).entry;
    startedWith = null;
    const mismatch = await dispatch(subject, "POST", `/api/v1/captures/${mismatchEntry.id}/shortcut-evidence`, {
      headers: extensionHeaders,
      body: {
        url: "https://example.test/shortcut/other",
        capturedAt: "2026-09-20T00:00:00.000Z",
        html: "<html><body><main>wrong page</main></body></html>",
        screenshotDataUrl: null
      }
    });
    assert.equal(payload(mismatch).error.code, "SHORTCUT_EVIDENCE_ITEM_MISMATCH");
    assert.equal(startedWith, null);
    assert.deepEqual(fs.readdirSync(staged), []);

    const privateEntry = addEntry(subject.registry, {
      url: "https://example.test/private-shortcut",
      visibility: "private"
    }).entry;
    startedWith = null;
    const blocked = await dispatch(subject, "POST", `/api/v1/captures/${privateEntry.id}/shortcut-evidence`, {
      headers: extensionHeaders,
      body: {
        url: privateEntry.url_original,
        capturedAt: "2026-09-20T00:00:00.000Z",
        html: "<html><body><main>must not stage</main></body></html>",
        screenshotDataUrl: null
      }
    });
    assert.equal(blocked.status, 400);
    assert.equal(payload(blocked).error.code, "SHORTCUT_ENRICHMENT_POLICY_BLOCKED");
    assert.equal(startedWith, null);
    const archivedEntry = addEntry(subject.registry, {
      url: "https://example.test/archived-shortcut",
      visibility: "normal"
    }).entry;
    subject.registry.db.prepare("UPDATE entries SET deleted_at = ? WHERE id = ?")
      .run("2026-09-20T00:00:00.000Z", archivedEntry.id);
    const archivedCapture = await dispatch(subject, "POST", "/api/v1/captures", {
      headers: { ...extensionHeaders, "idempotency-key": randomUUID() },
      body: { adapter: "current-tab", items: [{ entryUrl: archivedEntry.url_original }] }
    });
    assert.equal(archivedCapture.status, 201);
    assert.equal(payload(archivedCapture).data.items[0].archived, true);
    assert.deepEqual(payload(archivedCapture).data.items[0].enrichment, {
      allowed: false,
      needs_summary: false,
      reason: "policy_blocked"
    });
    const oversized = addEntry(subject.registry, {
      url: "https://example.test/shortcut/oversized",
      visibility: "normal"
    }).entry;
    const oversizedResponse = await dispatch(subject, "POST", `/api/v1/captures/${oversized.id}/shortcut-evidence`, {
      headers: extensionHeaders,
      body: {
        url: oversized.url_original,
        capturedAt: "2026-09-20T00:00:00.000Z",
        html: "x".repeat(768 * 1024 + 1),
        screenshotDataUrl: null
      }
    });
    assert.equal(payload(oversizedResponse).error.code, "SHORTCUT_EVIDENCE_HTML_INVALID");
    assert.deepEqual(fs.readdirSync(staged), []);
  } finally { dispose(subject); }
});

test("Add URL and current-tab capture keep YouTube provider thumbnails remote", async () => {
  let downloadCalls = 0;
  const subject = fixture({
    async downloadImage() {
      downloadCalls += 1;
      throw new Error("provider thumbnails must not enter selected-image download");
    }
  });
  try {
    const auth = await session(subject);
    const firstVideoId = "7lCDEYXw3mM";
    const added = await dispatch(subject, "POST", "/api/v1/entries", {
      headers: webHeaders(auth, randomUUID()),
      body: { url: `https://www.youtube.com/watch?v=${firstVideoId}` }
    });
    assert.equal(added.status, 201);
    const addedEntry = payload(added).data.entry;
    assert.deepEqual(listVisualAssets(subject.registry, addedEntry.id).map((asset) => ({
      source_kind: asset.source_kind,
      source_url: asset.source_url,
      storage_kind: asset.storage_kind,
      is_cover: asset.is_cover
    })), [{
      source_kind: "provider_thumbnail",
      source_url: `https://i.ytimg.com/vi/${firstVideoId}/hqdefault.jpg`,
      storage_kind: "remote",
      is_cover: true
    }]);

    const client = await pair(subject, auth, randomUUID());
    const secondVideoId = "abcdefghijk";
    const captured = await dispatch(subject, "POST", "/api/v1/captures", {
      headers: {
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
        authorization: `Bearer ${client.token}`,
        origin: `chrome-extension://${EXTENSION_ID}`
      },
      body: { adapter: "current-tab", items: [{ entryUrl: `https://youtu.be/${secondVideoId}` }] }
    });
    assert.equal(captured.status, 201);
    const capturedEntryId = payload(captured).data.items[0].entry_id;
    assert.equal(listVisualAssets(subject.registry, capturedEntryId)[0].source_kind, "provider_thumbnail");
    assert.equal(downloadCalls, 0);
  } finally {
    dispose(subject);
  }
});

test("reference-only selected images retain remote Visual Assets without download calls", async () => {
  let downloadCalls = 0;
  const subject = fixture({
    selectedImageStorage: "reference_only",
    async downloadImage() {
      downloadCalls += 1;
      throw new Error("reference-only capture must not download");
    }
  });
  try {
    const auth = await session(subject);
    const client = await pair(subject, auth, randomUUID());
    const response = await dispatch(subject, "POST", "/api/v1/captures", {
      headers: {
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
        authorization: `Bearer ${client.token}`,
        origin: `chrome-extension://${EXTENSION_ID}`
      },
      body: {
        adapter: "generic-image-selector",
        items: [{
          entryUrl: "https://reference-only.test/post/1",
          assetUrls: ["https://cdn.reference-only.test/image.png"]
        }]
      }
    });
    assert.equal(response.status, 201);
    const data = payload(response).data;
    assert.equal(data.items[0].outcome_code, "created");
    assert.equal(data.items[0].assets[0].outcome_code, "attached");
    assert.equal(data.counts.remote_references_added, 1);
    assert.equal(data.counts.local_images_added, 0);
    assert.equal(downloadCalls, 0);
    assert.deepEqual(
      listVisualAssets(subject.registry, data.items[0].entry_id).map((asset) => ({
        storage_kind: asset.storage_kind,
        source_kind: asset.source_kind,
        status: asset.status
      })),
      [{ storage_kind: "remote", source_kind: "browser_selected", status: "referenced" }]
    );
  } finally {
    dispose(subject);
  }
});

test("Chrome image download failure retains a remote reference and idempotent replay localizes it", async () => {
  let available = false;
  const subject = fixture({
    async downloadImage(registry) {
      if (!available) throw new RegistryError("CAPTURE_IMAGE_DOWNLOAD_FAILED", "Synthetic image is temporarily unavailable.");
      return syntheticDownload(registry);
    }
  });
  try {
    const auth = await session(subject);
    const paired = await pair(subject, auth);
    const headers = {
      "content-type": "application/json",
      "idempotency-key": IDS[4],
      authorization: `Bearer ${paired.token}`,
      origin: `chrome-extension://${EXTENSION_ID}`
    };
    const body = {
      adapter: "generic",
      items: [{
        entryUrl: "https://retry.test/post/1",
        assetUrls: ["https://cdn.retry.test/original.png"]
      }]
    };
    const first = await dispatch(subject, "POST", "/api/v1/captures", { headers, body });
    const firstData = payload(first).data;
    assert.equal(firstData.items[0].outcome_code, "created_with_asset_skips");
    assert.equal(firstData.items[0].assets[0].outcome_code, "CAPTURE_IMAGE_DOWNLOAD_FAILED");
    assert.deepEqual(
      subject.registry.db.prepare("SELECT storage_kind, source_url FROM entry_visual_assets").all()
        .map((row) => ({ storage_kind: row.storage_kind, source_url: row.source_url })),
      [{ storage_kind: "remote", source_url: "https://cdn.retry.test/original.png" }]
    );

    available = true;
    const replay = await dispatch(subject, "POST", "/api/v1/captures", { headers, body });
    const replayData = payload(replay).data;
    assert.equal(replayData.replayed, true);
    assert.equal(replayData.items[0].outcome_code, "created");
    assert.equal(replayData.items[0].assets[0].outcome_code, "downloaded");
    assert.equal(replayData.counts.local_images_added, 1);
    assert.equal(replayData.counts.remote_references_added, 0);
    const local = subject.registry.db.prepare("SELECT id, storage_kind, source_url, byte_size FROM entry_visual_assets").get();
    assert.deepEqual(
      { storage_kind: local.storage_kind, source_url: local.source_url, byte_size: Number(local.byte_size) },
      { storage_kind: "local", source_url: "https://cdn.retry.test/original.png", byte_size: PNG.length }
    );
    const content = await dispatch(subject, "GET", `/api/v1/visual-assets/${local.id}/content`, {
      headers: { cookie: auth.cookie, "sec-fetch-site": "same-origin", "sec-fetch-mode": "no-cors" }
    });
    assert.equal(content.body, undefined);
    assert.deepEqual(fs.readFileSync(content.file.path), PNG);
    const ledger = JSON.stringify(subject.registry.db.prepare("SELECT details_json FROM capture_request_items").all());
    assert.equal(ledger.includes("retry.test"), false);
  } finally {
    dispose(subject);
  }
});

test("human CRUD, revision, Visual Asset, and capture-policy routes share authenticated Registry rules", async () => {
  const subject = fixture();
  try {
    const auth = await session(subject);
    const entry = addEntry(subject.registry, { url: "https://rules.test/images/one", title: "Before" }).entry;
    const firstAsset = addRemoteImageReference(subject.registry, entry.id, "https://cdn.rules.test/one.png").asset;
    const secondAsset = addRemoteImageReference(subject.registry, entry.id, "https://cdn.rules.test/two.png").asset;
    const key = (number) => `${String(number).padStart(8, "0")}-0000-4000-8000-000000000000`;

    const edited = await dispatch(subject, "PATCH", `/api/v1/entries/${entry.id}`, {
      headers: webHeaders(auth, key(10)),
      body: {
        title: "After",
        tags: ["visual", "saved"],
        visibility: "normal"
      }
    });
    assert.equal(edited.status, 200);
    assert.equal(payload(edited).data.title, "After");
    assert.deepEqual(payload(edited).data.tags.map((tag) => tag.name), ["saved", "visual"]);
    const revisions = await dispatch(subject, "GET", `/api/v1/entries/${entry.id}/revisions`, {
      headers: { cookie: auth.cookie }
    });
    assert.deepEqual(payload(revisions).data.map((revision) => revision.action), ["updated", "created"]);

    const assets = await dispatch(subject, "GET", `/api/v1/entries/${entry.id}/visual-assets`, {
      headers: { cookie: auth.cookie }
    });
    assert.equal(payload(assets).data.length, 2);
    assert.equal(JSON.stringify(payload(assets)).includes("file_path"), false);
    assert.equal(JSON.stringify(payload(assets)).includes("storage_path"), false);
    await dispatch(subject, "POST", `/api/v1/visual-assets/${firstAsset.id}/set-cover`, {
      headers: webHeaders(auth, key(11)),
      body: {}
    });
    assert.equal(getEntry(subject.registry, entry.id).cover_image.id, firstAsset.id);
    await dispatch(subject, "POST", `/api/v1/entries/${entry.id}/clear-cover`, {
      headers: webHeaders(auth, key(12)),
      body: {}
    });
    assert.equal(getEntry(subject.registry, entry.id).cover_image, null);
    await dispatch(subject, "DELETE", `/api/v1/visual-assets/${secondAsset.id}`, {
      headers: webHeaders(auth, key(13)),
      body: {}
    });
    assert.equal(getEntry(subject.registry, entry.id).visual_asset_count, 1);

    const policy = await dispatch(subject, "PATCH", "/api/v1/capture-policy", {
      headers: webHeaders(auth, key(14)),
      body: {
        visibility: "normal",
        selected_image_storage: "reference_only"
      }
    });
    assert.equal(payload(policy).data.visibility, "normal");
    assert.equal(payload(policy).data.selected_image_storage, "reference_only");
    const createdRule = await dispatch(subject, "POST", "/api/v1/capture-policy/rules", {
      headers: webHeaders(auth, key(15)),
      body: {
        url_prefix: "https://rules.test/images",
        visibility: "private",
        kind: "research"
      }
    });
    assert.equal(createdRule.status, 201);
    const rule = payload(createdRule).data;
    const movedRule = await dispatch(subject, "PATCH", `/api/v1/capture-policy/rules/${rule.id}`, {
      headers: webHeaders(auth, key(150)),
      body: { url_prefix: "https://rules.test/renamed" }
    });
    assert.deepEqual([payload(movedRule).data.hostname, payload(movedRule).data.path_prefix], ["rules.test", "/renamed"]);
    await dispatch(subject, "PATCH", `/api/v1/capture-policy/rules/${rule.id}`, {
      headers: webHeaders(auth, key(151)),
      body: { url_prefix: "https://rules.test/images" }
    });
    const preview = await dispatch(subject, "GET", `/api/v1/capture-policy/rules/${rule.id}/preview`, {
      headers: { cookie: auth.cookie }
    });
    assert.equal(payload(preview).data.match_count, 1);
    const applied = await dispatch(subject, "POST", `/api/v1/capture-policy/rules/${rule.id}/apply`, {
      headers: webHeaders(auth, key(16)),
      body: { reason: "Confirm previewed update" }
    });
    assert.equal(payload(applied).data.updated_count, 1);
    assert.equal(getEntry(subject.registry, entry.id).visibility, "private");
    assert.equal(getEntry(subject.registry, entry.id).kind, "research");

    const deleted = await dispatch(subject, "DELETE", `/api/v1/entries/${entry.id}`, {
      headers: webHeaders(auth, key(17)),
      body: { reason: "No longer needed" }
    });
    assert.equal(payload(deleted).data.deleted, 1);
    assert.equal((await dispatch(subject, "GET", `/api/v1/entries/${entry.id}`, {
      headers: { cookie: auth.cookie }
    })).status, 404);
    const replayedDelete = await dispatch(subject, "DELETE", `/api/v1/entries/${entry.id}`, {
      headers: webHeaders(auth, key(17)),
      body: { reason: "No longer needed" }
    });
    assert.deepEqual(payload(replayedDelete), payload(deleted));
  } finally {
    dispose(subject);
  }
});

test("Web Folder routes create, inspect, rename, move, and delete only empty Folders", async () => {
  const subject = fixture();
  try {
    const auth = await session(subject);
    const key = () => randomUUID();
    const created = await dispatch(subject, "POST", "/api/v1/folders", {
      headers: webHeaders(auth, key()),
      body: { name: "Projects", parent_id: null }
    });
    assert.equal(created.status, 201);
    const parent = payload(created).data;
    const childResponse = await dispatch(subject, "POST", "/api/v1/folders", {
      headers: webHeaders(auth, key()),
      body: { name: "Active", parent_id: parent.id }
    });
    const child = payload(childResponse).data;
    const inspected = await dispatch(subject, "GET", `/api/v1/folders/${child.id}`, { headers: { cookie: auth.cookie } });
    assert.equal(payload(inspected).data.name, "Active");

    const renamed = await dispatch(subject, "PATCH", `/api/v1/folders/${child.id}`, {
      headers: webHeaders(auth, key()),
      body: { name: "Current", parent_id: null }
    });
    assert.deepEqual([payload(renamed).data.name, payload(renamed).data.parent_id], ["Current", null]);
    const rejected = await dispatch(subject, "PATCH", `/api/v1/folders/${child.id}`, {
      headers: webHeaders(auth, key()),
      body: { name: "Not applied", parent_id: 9999 }
    });
    assert.equal(payload(rejected).error.code, "FOLDER_NOT_FOUND");
    const unchanged = await dispatch(subject, "GET", `/api/v1/folders/${child.id}`, { headers: { cookie: auth.cookie } });
    assert.deepEqual([payload(unchanged).data.name, payload(unchanged).data.parent_id], ["Current", null]);
    const cycle = await dispatch(subject, "PATCH", `/api/v1/folders/${parent.id}`, {
      headers: webHeaders(auth, key()),
      body: { parent_id: parent.id }
    });
    assert.equal(payload(cycle).error.code, "FOLDER_CYCLE");

    addEntry(subject.registry, { url: "https://folder-routes.test/one", folderId: parent.id });
    const nonEmpty = await dispatch(subject, "DELETE", `/api/v1/folders/${parent.id}`, {
      headers: webHeaders(auth, key()), body: {}
    });
    assert.equal(payload(nonEmpty).error.code, "FOLDER_NOT_EMPTY");
    const removed = await dispatch(subject, "DELETE", `/api/v1/folders/${child.id}`, {
      headers: webHeaders(auth, key()), body: {}
    });
    assert.equal(payload(removed).data.deleted, true);
  } finally {
    dispose(subject);
  }
});

test("static and local Visual Asset delivery expose bytes without exposing local paths", async () => {
  const subject = fixture();
  try {
    const auth = await session(subject);
    const html = await dispatch(subject, "GET", "/", { headers: { "sec-fetch-site": "same-origin" } });
    assert.equal(html.status, 200);
    assert.equal(html.headers["cache-control"], "no-store");
    assert.match(html.headers["content-security-policy"], /default-src 'self'/);
    assert.equal(String(html.body).includes("Web Bookmark Hub"), true);
    const externalNavigation = await dispatch(subject, "GET", "/?entry=1", { headers: {
      "sec-fetch-site": "cross-site",
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
      "sec-fetch-user": "?1"
    } });
    assert.equal(externalNavigation.status, 200);
    assert.equal(String(externalNavigation.body).includes("Web Bookmark Hub"), true);
    assert.equal((await dispatch(subject, "GET", "/api/v1/entries", { headers: {
      "sec-fetch-site": "cross-site",
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
      "sec-fetch-user": "?1"
    } })).status, 403);
    const browserSubresourceHeaders = {
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "no-cors"
    };
    const stylesheet = await dispatch(subject, "GET", "/styles.css", { headers: browserSubresourceHeaders });
    assert.equal(stylesheet.status, 200);
    assert.equal(stylesheet.headers["content-type"], "text/css; charset=utf-8");
    assert.equal(stylesheet.headers["cache-control"], "no-store");
    const script = await dispatch(subject, "GET", "/app.js", { headers: browserSubresourceHeaders });
    assert.equal(script.status, 200);
    assert.equal(script.headers["content-type"], "text/javascript; charset=utf-8");
    assert.equal(script.headers["cache-control"], "no-store");
    assert.equal((await dispatch(subject, "GET", "/../registry/database.js")).status, 404);
    assert.equal((await dispatch(subject, "POST", "/", {
      headers: { "content-type": "application/json" },
      body: {}
    })).status, 405);

    const sourcePath = path.join(subject.directory, "preview.png");
    fs.writeFileSync(sourcePath, PNG);
    const entry = addEntry(subject.registry, { url: "https://asset.test/local" }).entry;
    const local = await addLocalImage(subject.registry, entry.id, sourcePath, { sourceKind: "user_upload" });
    const remote = addRemoteImageReference(subject.registry, entry.id, "https://images.asset.test/remote.png");
    assert.equal((await dispatch(subject, "GET", `/api/v1/visual-assets/${local.asset.id}/content`)).status, 401);
    const content = await dispatch(subject, "GET", `/api/v1/visual-assets/${local.asset.id}/content`, {
      headers: { cookie: auth.cookie, ...browserSubresourceHeaders }
    });
    assert.equal(content.status, 200);
    assert.equal(content.headers["content-type"], "image/png");
    assert.equal(content.body, undefined);
    assert.deepEqual(fs.readFileSync(content.file.path), PNG);
    assert.equal(JSON.stringify(content).includes(subject.directory), false);
    assert.equal((await dispatch(subject, "GET", `/api/v1/visual-assets/${remote.asset.id}/content`, {
      headers: { cookie: auth.cookie }
    })).status, 404);
    fs.unlinkSync(local.asset.file_path);
    assert.equal((await dispatch(subject, "GET", `/api/v1/visual-assets/${local.asset.id}/content`, {
      headers: { cookie: auth.cookie }
    })).status, 404);
    fs.writeFileSync(local.asset.file_path, PNG);
    subject.registry.db.prepare("UPDATE entry_visual_assets SET media_type = 'text/plain' WHERE id = ?").run(local.asset.id);
    assert.equal((await dispatch(subject, "GET", `/api/v1/visual-assets/${local.asset.id}/content`, {
      headers: { cookie: auth.cookie }
    })).status, 404);
    subject.registry.db.prepare("UPDATE entry_visual_assets SET media_type = 'image/png', storage_path = '../escape.png' WHERE id = ?").run(local.asset.id);
    const escaped = await dispatch(subject, "GET", `/api/v1/visual-assets/${local.asset.id}/content`, {
      headers: { cookie: auth.cookie }
    });
    assert.equal(escaped.status, 400);
    assert.equal(JSON.stringify(payload(escaped)).includes(subject.directory), false);
  } finally {
    dispose(subject);
  }
});

test("empty Buffer bodies are accepted only for routes permitting empty JSON", async () => {
  const subject = fixture();
  try {
    const auth = await session(subject);
    const folder = createFolder(subject.registry, { name: "Empty body deletion" });
    const route = `/api/v1/folders/${folder.id}`;
    for (const [body, contentType, code] of [
      [Buffer.from("{broken"), "application/json", "JSON_BODY_INVALID"],
      [Buffer.alloc(0), "text/plain", "CONTENT_TYPE_INVALID"]
    ]) {
      const rejected = await dispatch(subject, "DELETE", route, {
        headers: { ...webHeaders(auth, randomUUID()), "content-type": contentType }, body
      });
      assert.equal(rejected.status, 400);
      assert.equal(payload(rejected).error.code, code);
    }
    const required = await dispatch(subject, "POST", "/api/v1/folders", {
      headers: webHeaders(auth, randomUUID()), body: Buffer.alloc(0)
    });
    assert.equal(payload(required).error.code, "JSON_BODY_INVALID");
    const deleted = await dispatch(subject, "DELETE", route, {
      headers: webHeaders(auth, randomUUID()), body: Buffer.alloc(0)
    });
    assert.equal(deleted.status, 200);
    assert.equal(payload(deleted).data.deleted, true);
  } finally {
    dispose(subject);
  }
});

test("JSON transport rejects malformed, oversized, and wrong-content-type bodies", async () => {
  const subject = fixture();
  try {
    const malformed = await dispatch(subject, "POST", "/api/v1/pairing-exchanges", {
      headers: { "content-type": "application/json" },
      body: "{broken"
    });
    assert.equal(malformed.status, 400);
    assert.equal(payload(malformed).error.code, "JSON_BODY_INVALID");
    const wrongType = await dispatch(subject, "POST", "/api/v1/pairing-exchanges", {
      headers: { "content-type": "text/plain" },
      body: "{}"
    });
    assert.equal(wrongType.status, 400);
    assert.equal(payload(wrongType).error.code, "CONTENT_TYPE_INVALID");
    const oversized = await dispatch(subject, "POST", "/api/v1/pairing-exchanges", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "x".repeat(1024 * 1024 + 1) })
    });
    assert.equal(oversized.status, 400);
    assert.equal(payload(oversized).error.code, "REQUEST_BODY_TOO_LARGE");
  } finally {
    dispose(subject);
  }
});
