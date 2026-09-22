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
  deleteCapturePolicyRule,
  previewCapturePolicyRule,
  resolveCapturePolicy,
  updateCapturePolicyRule
} = require("../registry/capture-policy.js");
const { openRegistry } = require("../registry/database.js");
const { getEntry } = require("../registry/entries.js");
const { createRule: createRuleFromApi } = require("../server/capture-policy-api.js");

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wbh-rule-tags-"));
  const registry = openRegistry({ dbPath: path.join(directory, "registry.sqlite3") });
  return {
    registry,
    dispose() {
      registry.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  };
}

function capture(registry, id, url, tags) {
  const result = captureEntries(registry, {
    channel: "web",
    requesterScope: "web:rule-tags",
    clientRequestId: id,
    items: [{ entryUrl: url, tags }]
  });
  return getEntry(registry, result.items[0].entry_id, { includeArchived: true });
}

function tagNames(entry) {
  return entry.tags.map((tag) => tag.name);
}

test("URL rules persist normalized default tags and matching captures merge them additively", () => {
  const state = fixture();
  try {
    const rule = createCapturePolicyRule(state.registry, {
      urlPrefix: "https://github.com/openai/",
      visibility: "normal",
      agentAccess: "metadata_only",
      aiProcessing: "manual",
      kind: "code",
      tags: ["OpenAI", "reference", "openai"]
    });
    assert.deepEqual(rule.tags.map((tag) => tag.name), ["OpenAI", "reference"]);
    assert.deepEqual(resolveCapturePolicy(
      state.registry,
      "https://github.com/openai/openai-node"
    ).defaultTags, ["OpenAI", "reference"]);

    const first = capture(
      state.registry,
      "11111111-1111-4111-8111-111111111111",
      "https://github.com/openai/openai-node",
      ["reference", "node"]
    );
    assert.deepEqual(tagNames(first), ["node", "OpenAI", "reference"]);
    assert.equal(first.kind, "code");

    updateCapturePolicyRule(state.registry, rule.id, { tags: ["future-only"] });
    assert.deepEqual(tagNames(getEntry(state.registry, first.id)), ["node", "OpenAI", "reference"]);

    const second = capture(
      state.registry,
      "22222222-2222-4222-8222-222222222222",
      "https://github.com/openai/openai-python",
      []
    );
    assert.deepEqual(tagNames(second), ["future-only"]);

    capture(
      state.registry,
      "33333333-3333-4333-8333-333333333333",
      "https://github.com/openai/openai-node",
      []
    );
    assert.deepEqual(tagNames(getEntry(state.registry, first.id)), ["node", "OpenAI", "reference"]);
  } finally {
    state.dispose();
  }
});

test("previewed apply adds missing rule tags without removing Entry tags", () => {
  const state = fixture();
  try {
    const existing = capture(
      state.registry,
      "44444444-4444-4444-8444-444444444444",
      "https://example.test/project/a",
      ["keep-me"]
    );
    const rule = createCapturePolicyRule(state.registry, {
      urlPrefix: "https://example.test/project/",
      visibility: "private",
      agentAccess: "blocked",
      aiProcessing: "disabled",
      tags: ["project-x", "reference"]
    });
    const preview = previewCapturePolicyRule(state.registry, rule.id);
    assert.equal(preview.match_count, 1);
    assert.equal(preview.would_update_count, 1);
    assert.equal(preview.tag_update_count, 1);

    const applied = applyCapturePolicyRule(state.registry, rule.id, {
      actor: { type: "user", id: "test" }
    });
    assert.equal(applied.updated_count, 1);
    assert.deepEqual(tagNames(getEntry(state.registry, existing.id)), ["keep-me", "project-x", "reference"]);
    assert.equal(previewCapturePolicyRule(state.registry, rule.id).would_update_count, 0);
  } finally {
    state.dispose();
  }
});

test("rule deletion keeps Entry tags and removes tags owned only by that rule", () => {
  const state = fixture();
  try {
    const rule = createCapturePolicyRule(state.registry, {
      urlPrefix: "https://cleanup.test/",
      visibility: "private",
      agentAccess: "blocked",
      aiProcessing: "disabled",
      tags: ["rule-only"]
    });
    assert.equal(state.registry.db.prepare("SELECT COUNT(*) AS count FROM tags WHERE normalized_name = 'rule-only'").get().count, 1);
    deleteCapturePolicyRule(state.registry, rule.id);
    assert.equal(state.registry.db.prepare("SELECT COUNT(*) AS count FROM tags WHERE normalized_name = 'rule-only'").get().count, 0);
  } finally {
    state.dispose();
  }
});

test("capture-policy API accepts tags and rejects malformed rule tag values", () => {
  const state = fixture();
  try {
    const rule = createRuleFromApi(state.registry, {
      url_prefix: "https://api.test/reference/",
      visibility: "normal",
      tags: ["api", "reference"]
    });
    assert.deepEqual(rule.tags.map((tag) => tag.name), ["api", "reference"]);
    assert.throws(() => createRuleFromApi(state.registry, {
      url_prefix: "https://api.test/bad/",
      visibility: "normal",
      tags: "not-an-array"
    }), { code: "VALIDATION_ERROR" });
  } finally {
    state.dispose();
  }
});
