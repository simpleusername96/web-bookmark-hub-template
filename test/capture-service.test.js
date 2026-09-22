"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { captureEntries, MAX_ASSETS_PER_ITEM, MAX_CAPTURE_ITEMS } = require("../registry/captures.js");
const { openRegistry } = require("../registry/database.js");
const { getEntry } = require("../registry/entries.js");
const { createFolder } = require("../registry/folders.js");
const { listComments } = require("../registry/comments.js");
const { listVisualAssets, removeVisualAsset } = require("../registry/visual-assets.js");

const UUIDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
  "55555555-5555-4555-8555-555555555555",
  "66666666-6666-4666-8666-666666666666"
];

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wbh-capture-service-"));
  return {
    directory,
    registry: openRegistry({ dbPath: path.join(directory, "registry.sqlite3") })
  };
}

function dispose(subject) {
  subject.registry.close();
  fs.rmSync(subject.directory, { recursive: true, force: true, maxRetries: 3 });
}

function request(overrides = {}) {
  return {
    channel: "web",
    adapter: "generic",
    requesterScope: "web:session-one",
    clientRequestId: UUIDS[0],
    items: [{ entryUrl: "https://example.test/page" }],
    ...overrides
  };
}

test("web, Chrome, and manifest captures preserve provenance and derive text or visual intent", () => {
  const subject = fixture();
  const previousFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = () => {
    fetchCalls += 1;
    throw new Error("capture service must not fetch");
  };
  try {
    const web = captureEntries(subject.registry, request({
      items: [{
        entryUrl: "https://example.test/raw?utm_source=kept-in-original#fragment",
        title: "Current tab",
        contentFocus: "visual",
        tags: ["saved", "Reference"],
        comment: "User note"
      }]
    }));
    const webEntry = getEntry(subject.registry, web.items[0].entry_id);
    assert.equal(webEntry.url_original, "https://example.test/raw?utm_source=kept-in-original#fragment");
    assert.equal(webEntry.url_canonical, "https://example.test/raw");
    assert.equal(webEntry.created_via, "web");
    assert.equal(webEntry.capture_adapter, "generic");
    assert.equal(webEntry.content_focus, "visual");
    assert.deepEqual(webEntry.tags.map((tag) => tag.normalized_name), ["reference", "saved"]);
    assert.equal(listComments(subject.registry, webEntry.id).items[0].body, "User note");
    assert.deepEqual(
      [webEntry.visibility, webEntry.agent_access, webEntry.ai_processing],
      ["private", "blocked", "disabled"]
    );

    const chrome = captureEntries(subject.registry, request({
      channel: "chrome",
      adapter: "generic-image-selector",
      requesterScope: "client:12",
      clientRequestId: UUIDS[1],
      items: [{
        entryUrl: "https://gallery.test/post?meaningful=1",
        title: "Old extension page title must be ignored",
        selectedAt: "2026-08-31T01:02:03.000Z",
        assetUrls: [
          "https://cdn.gallery.test/first.jpg",
          "https://cdn.gallery.test/second.jpg"
        ]
      }]
    }));
    const chromeEntry = getEntry(subject.registry, chrome.items[0].entry_id);
    assert.equal(chromeEntry.created_via, "chrome");
    assert.equal(chromeEntry.capture_adapter, "generic-image-selector");
    assert.equal(chromeEntry.content_focus, "visual");
    assert.equal(chromeEntry.title, null);
    assert.equal(chromeEntry.title_origin, "none");
    assert.equal(chromeEntry.saved_at, "2026-08-31T01:02:03.000Z");
    assert.deepEqual(
      listVisualAssets(subject.registry, chromeEntry.id).map((asset) => asset.source_url),
      ["https://cdn.gallery.test/first.jpg", "https://cdn.gallery.test/second.jpg"]
    );

    const imported = captureEntries(subject.registry, request({
      channel: "manifest_import",
      adapter: "legacy-manifest",
      requesterScope: "manifest:cli",
      clientRequestId: UUIDS[2],
      items: [{ entryUrl: "https://archive.test/item", publishedAt: "2025-01-01T00:00:00.000Z" }]
    }));
    assert.equal(getEntry(subject.registry, imported.items[0].entry_id).created_via, "manifest_import");
    assert.equal(fetchCalls, 0);
  } finally {
    global.fetch = previousFetch;
    dispose(subject);
  }
});

test("same request replays stable outcomes and a new request reuses the canonical Entry", () => {
  const subject = fixture();
  try {
    const originalRequest = request({
      items: [{
        entryUrl: "https://example.test/replay",
        title: "Original",
        assetUrls: ["https://images.example.test/replay.png"]
      }]
    });
    const first = captureEntries(subject.registry, originalRequest);
    const replay = captureEntries(subject.registry, originalRequest);
    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.equal(replay.request.id, first.request.id);
    assert.deepEqual(replay.items, first.items);
    assert.equal(subject.registry.db.prepare("SELECT COUNT(*) AS count FROM entries").get().count, 1);
    assert.equal(subject.registry.db.prepare("SELECT COUNT(*) AS count FROM entry_visual_assets").get().count, 1);

    assert.throws(
      () => captureEntries(subject.registry, request({
        items: [{ entryUrl: "https://example.test/replay", title: "Changed" }]
      })),
      (error) => error.code === "CAPTURE_REQUEST_CONFLICT"
    );

    const later = captureEntries(subject.registry, request({
      clientRequestId: UUIDS[1],
      items: [{ entryUrl: "https://example.test/replay", title: "Later intentional save" }]
    }));
    assert.equal(later.items[0].entry_id, first.items[0].entry_id);
    assert.equal(later.items[0].outcome_code, "already_saved");
    assert.deepEqual(later.items[0].assets, []);
    assert.equal(later.counts.entries_already_saved, 1);
    assert.equal(subject.registry.db.prepare("SELECT COUNT(*) AS count FROM entries").get().count, 1);
  } finally {
    dispose(subject);
  }
});

test("direct YouTube capture attaches one remote provider thumbnail without affecting other adapters", () => {
  const subject = fixture();
  try {
    const videoId = "7lCDEYXw3mM";
    const first = captureEntries(subject.registry, request({
      adapter: "web-add-url",
      items: [{ entryUrl: `https://www.youtube.com/watch?v=${videoId}&utm_source=ignored` }]
    }));
    const entryId = first.items[0].entry_id;
    const entry = getEntry(subject.registry, entryId);
    const assets = listVisualAssets(subject.registry, entryId);
    assert.equal(entry.kind, "video");
    assert.equal(entry.content_focus, "visual");
    assert.equal(assets.length, 1);
    assert.deepEqual(
      [assets[0].source_kind, assets[0].source_url, assets[0].storage_kind, assets[0].is_cover],
      ["provider_thumbnail", `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`, "remote", true]
    );

    const repeated = captureEntries(subject.registry, request({
      adapter: "web-add-url",
      clientRequestId: UUIDS[1],
      items: [{ entryUrl: `https://www.youtube.com/watch?v=${videoId}&utm_medium=repeated` }]
    }));
    assert.equal(repeated.items[0].entry_id, entryId);
    assert.equal(repeated.items[0].assets[0].outcome_code, "duplicate");
    assert.equal(listVisualAssets(subject.registry, entryId).length, 1);

    const selector = captureEntries(subject.registry, request({
      channel: "chrome",
      adapter: "generic-image-selector",
      requesterScope: "client:12",
      clientRequestId: UUIDS[2],
      items: [{ entryUrl: `https://www.youtube.com/watch?v=abcdefghijk` }]
    }));
    assert.equal(listVisualAssets(subject.registry, selector.items[0].entry_id).length, 0);

    const imported = captureEntries(subject.registry, request({
      channel: "manifest_import",
      adapter: "legacy-manifest",
      requesterScope: "manifest:cli",
      clientRequestId: UUIDS[3],
      items: [{ entryUrl: `https://www.youtube.com/watch?v=ABCDEFGHIJK` }]
    }));
    assert.equal(listVisualAssets(subject.registry, imported.items[0].entry_id).length, 0);
  } finally {
    dispose(subject);
  }
});

test("a new capture reconciles selected assets for an existing active Entry without rewriting authored metadata", async () => {
  const subject = fixture();
  try {
    const entryUrl = "https://example.test/existing-assets";
    const first = captureEntries(subject.registry, request({
      clientRequestId: UUIDS[0],
      items: [{
        entryUrl,
        title: "Original title",
        tags: ["original"],
        comment: "Original note",
        assetUrls: ["https://images.example.test/first.png"]
      }]
    }));
    const entryId = first.items[0].entry_id;

    const second = captureEntries(subject.registry, request({
      clientRequestId: UUIDS[1],
      items: [{
        entryUrl,
        title: "Ignored replacement",
        tags: ["ignored"],
        comment: "Ignored note",
        assetUrls: ["https://images.example.test/second.png"]
      }]
    }));
    assert.equal(second.items[0].outcome_code, "already_saved");
    assert.equal(second.items[0].assets[0].outcome_code, "attached");
    assert.equal(getEntry(subject.registry, entryId).title, "Original title");
    assert.deepEqual(getEntry(subject.registry, entryId).tags.map((tag) => tag.normalized_name), ["original"]);
    assert.deepEqual(listComments(subject.registry, entryId).items.map((comment) => comment.body), ["Original note"]);
    assert.equal(listVisualAssets(subject.registry, entryId).length, 2);

    const duplicate = captureEntries(subject.registry, request({
      clientRequestId: UUIDS[2],
      items: [{ entryUrl, assetUrls: ["https://images.example.test/second.png"] }]
    }));
    assert.equal(duplicate.items[0].outcome_code, "already_saved");
    assert.equal(duplicate.items[0].assets[0].outcome_code, "duplicate");
    assert.equal(listVisualAssets(subject.registry, entryId).length, 2);

    const secondAsset = listVisualAssets(subject.registry, entryId).find((asset) => asset.source_url.endsWith("/second.png"));
    await removeVisualAsset(subject.registry, secondAsset.id);
    const reattached = captureEntries(subject.registry, request({
      clientRequestId: UUIDS[3],
      items: [{ entryUrl, assetUrls: ["https://images.example.test/second.png"] }]
    }));
    assert.equal(reattached.items[0].outcome_code, "already_saved");
    assert.equal(reattached.items[0].assets[0].outcome_code, "attached");
    assert.equal(
      listVisualAssets(subject.registry, entryId)
        .some((asset) => asset.source_url.endsWith("/second.png")),
      true
    );
  } finally {
    dispose(subject);
  }
});

test("legacy archived Entry reuse remains non-mutating", () => {
  const subject = fixture();
  try {
    const entryUrl = "https://example.test/legacy-archived";
    const first = captureEntries(subject.registry, request({
      clientRequestId: UUIDS[4],
      items: [{ entryUrl }]
    }));
    subject.registry.db.prepare("UPDATE entries SET deleted_at = ? WHERE id = ?")
      .run("2026-01-01T00:00:00.000Z", first.items[0].entry_id);

    const reused = captureEntries(subject.registry, request({
      clientRequestId: UUIDS[5],
      items: [{ entryUrl, assetUrls: ["https://images.example.test/ignored.png"] }]
    }));
    assert.equal(reused.items[0].outcome_code, "already_saved");
    assert.deepEqual(reused.items[0].assets, []);
    assert.equal(listVisualAssets(subject.registry, first.items[0].entry_id).length, 0);
  } finally {
    dispose(subject);
  }
});

test("partial batches and asset failures are explicit, bounded, replayable, and URL-free in the ledger", () => {
  const subject = fixture();
  try {
    const input = request({
      channel: "chrome",
      requesterScope: "client:99",
      clientRequestId: UUIDS[3],
      items: [
        {
          entryUrl: "https://private.example.test/post?id=secret",
          assetUrls: [
            "https://images.example.test/good.png",
            "https://user:pass@images.example.test/credential.png",
            "data:image/png;base64,AAAA"
          ]
        },
        null,
        { title: "missing URL" },
        { entryUrl: "https://user:pass@example.test/private" }
      ]
    });
    const first = captureEntries(subject.registry, input);
    assert.deepEqual(first.items.map((item) => item.outcome_code), [
      "created_with_asset_skips",
      "CAPTURE_ITEM_INVALID",
      "CAPTURE_ITEM_URL_REQUIRED",
      "URL_CREDENTIALS_NOT_ALLOWED"
    ]);
    assert.deepEqual(first.items[0].assets.map((asset) => asset.outcome_code), [
      "attached",
      "VISUAL_ASSET_SOURCE_URL_INVALID",
      "VISUAL_ASSET_SOURCE_URL_INVALID"
    ]);
    assert.deepEqual(first.counts, {
      entries_created: 1,
      entries_already_saved: 0,
      items_skipped: 3,
      remote_references_added: 1,
      remote_references_reused: 0,
      local_images_added: 0,
      local_images_reused: 0,
      assets_skipped: 2
    });
    const replay = captureEntries(subject.registry, input);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.items, first.items);

    const ledger = subject.registry.db.prepare(`
      SELECT r.payload_sha256, i.details_json
      FROM capture_requests r
      JOIN capture_request_items i ON i.request_id = r.id
      ORDER BY i.item_index
    `).all();
    const serializedLedger = JSON.stringify(ledger);
    assert.equal(serializedLedger.includes("private.example.test"), false);
    assert.equal(serializedLedger.includes("images.example.test"), false);
    assert.equal(serializedLedger.includes("user:pass"), false);
    assert.ok(ledger.every((row) => /^[0-9a-f]{64}$/.test(row.payload_sha256)));

    assert.throws(
      () => captureEntries(subject.registry, request({ items: Array(MAX_CAPTURE_ITEMS + 1).fill({ entryUrl: "https://limit.test/item" }) })),
      (error) => error.code === "CAPTURE_ITEM_LIMIT_EXCEEDED"
    );
    const assetLimit = captureEntries(subject.registry, request({
      clientRequestId: UUIDS[4],
      items: [{
        entryUrl: "https://limit.test/assets",
        assetUrls: Array(MAX_ASSETS_PER_ITEM + 1).fill("https://images.limit.test/a.png")
      }]
    }));
    assert.equal(assetLimit.items[0].outcome_code, "CAPTURE_ASSET_LIMIT_EXCEEDED");
    assert.equal(assetLimit.items[0].entry_id, null);
  } finally {
    dispose(subject);
  }
});

test("Folder placement is only explicit while trusted capture policy overrides are accepted", () => {
  const subject = fixture();
  try {
    const folder = createFolder(subject.registry, { name: "Explicit" });
    const result = captureEntries(subject.registry, request({
      clientRequestId: UUIDS[5],
      items: [
        { entryUrl: "https://folder.test/explicit", folderId: folder.id },
        {
          entryUrl: "https://folder.test/unfiled",
          bucket: "Should not exist",
          collection: "Ignored legacy group",
          urlGroupId: "not-authoritative",
          createdVia: "legacy",
          visibility: "normal",
          agentAccess: "allowed"
        }
      ]
    }));
    assert.equal(getEntry(subject.registry, result.items[0].entry_id).folder_id, folder.id);
    assert.equal(getEntry(subject.registry, result.items[1].entry_id).folder_id, null);
    assert.deepEqual(
      [
        getEntry(subject.registry, result.items[1].entry_id).created_via,
        getEntry(subject.registry, result.items[1].entry_id).visibility,
        getEntry(subject.registry, result.items[1].entry_id).agent_access
      ],
      ["web", "normal", "allowed"]
    );
    assert.equal(subject.registry.db.prepare("SELECT COUNT(*) AS count FROM folders").get().count, 1);
  } finally {
    dispose(subject);
  }
});

test("unexpected storage failure rolls back the request, Entries, and outcomes together", () => {
  const subject = fixture();
  try {
    subject.registry.db.exec(`
      CREATE TRIGGER force_unexpected_capture_failure
      BEFORE INSERT ON entries
      BEGIN SELECT RAISE(ABORT, 'synthetic unexpected failure'); END;
    `);
    assert.throws(
      () => captureEntries(subject.registry, request()),
      /synthetic unexpected failure/
    );
    assert.equal(subject.registry.db.prepare("SELECT COUNT(*) AS count FROM capture_requests").get().count, 0);
    assert.equal(subject.registry.db.prepare("SELECT COUNT(*) AS count FROM capture_request_items").get().count, 0);
    assert.equal(subject.registry.db.prepare("SELECT COUNT(*) AS count FROM entries").get().count, 0);
  } finally {
    dispose(subject);
  }
});
