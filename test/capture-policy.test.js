"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { captureEntries } = require("../registry/captures.js");
const {
  applyCapturePolicyRule,
  createCapturePolicyRule,
  getCapturePolicy,
  initializeSelectedImageStorage,
  previewCapturePolicyRule,
  resolveCapturePolicy,
  updateCapturePolicy,
  updateCapturePolicyRule
} = require("../registry/capture-policy.js");
const { openRegistry } = require("../registry/database.js");
const { addEntry, getEntry, listEntryRevisions } = require("../registry/entries.js");

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wbh-capture-policy-"));
  const registry = openRegistry({ dbPath: path.join(directory, "registry.sqlite3") });
  return {
    registry,
    dispose() {
      registry.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  };
}

test("capture policy uses explicit override, deepest segment-safe rule, then global default", () => {
  const state = fixture();
  try {
    assert.equal(getCapturePolicy(state.registry).visibility, "private");
    updateCapturePolicy(state.registry, {
      visibility: "normal",
      agentAccess: "metadata_only",
      aiProcessing: "manual"
    });
    const root = createCapturePolicyRule(state.registry, {
      hostname: "www.example.test",
      pathPrefix: "/images",
      visibility: "private",
      agentAccess: "blocked",
      aiProcessing: "disabled"
    });
    const deep = createCapturePolicyRule(state.registry, {
      hostname: "example.test",
      pathPrefix: "/images/private",
      visibility: "private",
      agentAccess: "metadata_only",
      aiProcessing: "manual"
    });
    assert.equal(root.hostname, "example.test");
    const moved = updateCapturePolicyRule(state.registry, root.id, { urlPrefix: "https://rules.example.test/renamed/" });
    assert.deepEqual([moved.hostname, moved.path_prefix], ["rules.example.test", "/renamed"]);
    updateCapturePolicyRule(state.registry, root.id, { urlPrefix: "https://example.test/images" });
    assert.equal(resolveCapturePolicy(state.registry, "https://example.test/images/a").rule_id, root.id);
    assert.equal(resolveCapturePolicy(state.registry, "https://example.test/images/private/a").rule_id, deep.id);
    assert.equal(resolveCapturePolicy(state.registry, "https://example.test/images2/a").source, "default");
    const explicit = resolveCapturePolicy(state.registry, "https://example.test/images/private/a", {
      visibility: "normal",
      agentAccess: "allowed",
      aiProcessing: "enabled"
    });
    assert.deepEqual(
      [explicit.source, explicit.visibility, explicit.agentAccess, explicit.aiProcessing],
      ["explicit", "normal", "allowed", "enabled"]
    );
  } finally {
    state.dispose();
  }
});

test("selected-image storage initializes once and then remains user-controlled", () => {
  const state = fixture();
  try {
    assert.equal(getCapturePolicy(state.registry).selected_image_storage, null);
    assert.equal(
      initializeSelectedImageStorage(state.registry, "local_copy").selected_image_storage,
      "local_copy"
    );
    assert.equal(
      initializeSelectedImageStorage(state.registry, "reference_only").selected_image_storage,
      "local_copy"
    );
    assert.equal(
      updateCapturePolicy(state.registry, { selectedImageStorage: "reference_only" }).selected_image_storage,
      "reference_only"
    );
    assert.equal(
      initializeSelectedImageStorage(state.registry, "local_copy").selected_image_storage,
      "reference_only"
    );
    assert.throws(
      () => updateCapturePolicy(state.registry, { selectedImageStorage: "download_all" }),
      { code: "VALIDATION_ERROR" }
    );
  } finally {
    state.dispose();
  }
});

test("capture rule kind follows explicit, deepest rule, then URL-derived precedence", () => {
  const state = fixture();
  try {
    const root = createCapturePolicyRule(state.registry, {
      hostname: "example.test",
      pathPrefix: "/items",
      kind: "article",
      visibility: "private",
      agentAccess: "blocked",
      aiProcessing: "disabled"
    });
    const deep = createCapturePolicyRule(state.registry, {
      hostname: "example.test",
      pathPrefix: "/items/code",
      kind: "code",
      visibility: "private",
      agentAccess: "blocked",
      aiProcessing: "disabled"
    });
    assert.equal(root.kind, "article");
    assert.deepEqual(
      [resolveCapturePolicy(state.registry, "https://example.test/items/code/a").kind, resolveCapturePolicy(state.registry, "https://example.test/items/code/a").rule_id],
      ["code", deep.id]
    );
    assert.deepEqual(
      [resolveCapturePolicy(state.registry, "https://example.test/items/code/a", { kind: "image" }).kind, resolveCapturePolicy(state.registry, "https://example.test/items/code/a", { kind: "image" }).kind_source],
      ["image", "explicit"]
    );
    assert.equal(resolveCapturePolicy(state.registry, "https://example.test/other").kind, undefined);
  } finally {
    state.dispose();
  }
});

test("rules are prospective until an explicit previewed apply records Entry revisions", () => {
  const state = fixture();
  try {
    const first = addEntry(state.registry, { url: "https://example.test/images/a" }).entry;
    addEntry(state.registry, { url: "https://example.test/other/a" });
    const rule = createCapturePolicyRule(state.registry, {
      hostname: "example.test",
      pathPrefix: "/images",
      visibility: "normal",
      agentAccess: "metadata_only",
      aiProcessing: "manual",
      kind: "research"
    });
    assert.equal(getEntry(state.registry, first.id).visibility, "private");
    assert.deepEqual(previewCapturePolicyRule(state.registry, rule.id).entry_ids, [first.id]);
    const applied = applyCapturePolicyRule(state.registry, rule.id, {
      actor: { type: "user", id: "settings" }
    });
    assert.equal(applied.updated_count, 1);
    assert.equal(getEntry(state.registry, first.id).visibility, "normal");
    assert.equal(getEntry(state.registry, first.id).kind, "research");
    assert.deepEqual(
      listEntryRevisions(state.registry, first.id).map((revision) => revision.action),
      ["updated", "created"]
    );
  } finally {
    state.dispose();
  }
});

test("capture requests resolve Registry rules and fingerprint explicit policy", () => {
  const state = fixture();
  try {
    createCapturePolicyRule(state.registry, {
      hostname: "example.test",
      pathPrefix: "/images",
      visibility: "normal",
      agentAccess: "metadata_only",
      aiProcessing: "manual"
    });
    const result = captureEntries(state.registry, {
      channel: "web",
      requesterScope: "web:test",
      clientRequestId: "11111111-1111-4111-8111-111111111111",
      items: [{ entryUrl: "https://example.test/images/a" }]
    });
    const entry = getEntry(state.registry, result.items[0].entry_id);
    assert.deepEqual(
      [entry.visibility, entry.agent_access, entry.ai_processing],
      ["normal", "allowed", "enabled"]
    );
    assert.throws(() => captureEntries(state.registry, {
      channel: "web",
      requesterScope: "web:test",
      clientRequestId: "11111111-1111-4111-8111-111111111111",
      items: [{
        entryUrl: "https://example.test/images/a",
        visibility: "private"
      }]
    }), (error) => error.code === "CAPTURE_REQUEST_CONFLICT");
  } finally {
    state.dispose();
  }
});
