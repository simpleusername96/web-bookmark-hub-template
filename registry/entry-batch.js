"use strict";

const { createHash } = require("node:crypto");
const { withTransaction } = require("./database.js");
const { deleteEntries, normalizeEntryIds } = require("./entry-deletion.js");
const { editEntry, getEntry } = require("./entries.js");
const { listEntries } = require("./entry-query.js");
const { RegistryError } = require("./errors.js");
const { normalizeTagName } = require("./values.js");

const OPERATIONS = Object.freeze([
  "set_folder", "add_tags", "remove_tags", "set_kind", "set_content_focus", "set_policy", "delete"
]);
const MAX_QUERY_BATCH_ENTRIES = 10000;

async function batchEntries(registry, input, options = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new RegistryError("VALIDATION_ERROR", "Batch request must be an object.");
  }
  const ids = normalizeEntryIds(input.entry_ids);
  return executeBatch(registry, input, ids, options);
}

async function batchEntriesMatching(registry, input, options = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new RegistryError("VALIDATION_ERROR", "Batch request must be an object.");
  }
  const expectedCount = Number(input.expected_count);
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 1) {
    throw new RegistryError("VALIDATION_ERROR", "expected_count must be a positive integer.", { field: "expected_count" });
  }
  const expectedDigest = String(input.expected_digest || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expectedDigest)) {
    throw new RegistryError("VALIDATION_ERROR", "expected_digest must be a SHA-256 digest.", { field: "expected_digest" });
  }
  const operation = String(input.operation || "").trim();
  if (!OPERATIONS.includes(operation)) {
    throw new RegistryError("VALIDATION_ERROR", "Batch operation is invalid.", { field: "operation", allowed: OPERATIONS });
  }
  const initial = selectionSnapshot(registry, input.filters || {});
  assertSelectionUnchanged(initial, expectedCount, expectedDigest);
  const verify = () => assertSelectionUnchanged(
    selectionSnapshot(registry, input.filters || {}), expectedCount, expectedDigest
  );
  if (operation === "delete") {
    return executeBatch(registry, input, initial.ids, {
      ...options, maxIds: MAX_QUERY_BATCH_ENTRIES, includeEntries: false, precondition: verify
    });
  }
  return executeBatch(registry, input, initial.ids, {
    ...options, maxIds: MAX_QUERY_BATCH_ENTRIES, includeEntries: false, precondition: verify
  });
}

function matchingEntryIds(registry, filters) {
  const first = listEntries(registry, { ...filters, page: 1, pageSize: 100 });
  if (first.total > MAX_QUERY_BATCH_ENTRIES) {
    throw new RegistryError("BATCH_QUERY_LIMIT", `Bulk actions support up to ${MAX_QUERY_BATCH_ENTRIES} matching Entries.`, {
      max: MAX_QUERY_BATCH_ENTRIES,
      actual_count: first.total
    });
  }
  const ids = first.items.map((entry) => entry.id);
  for (let page = 2; page <= first.total_pages; page += 1) {
    ids.push(...listEntries(registry, { ...filters, page, pageSize: 100 }).items.map((entry) => entry.id));
  }
  return ids.sort((left, right) => left - right);
}

function selectionSnapshot(registry, filters = {}) {
  const ids = matchingEntryIds(registry, filters);
  return {
    expected_count: ids.length,
    expected_digest: digestEntryIds(ids),
    ids
  };
}

function digestEntryIds(ids) {
  return createHash("sha256").update(ids.join(","), "utf8").digest("hex");
}

function assertSelectionUnchanged(snapshot, expectedCount, expectedDigest) {
  if (snapshot.expected_count !== expectedCount || snapshot.expected_digest !== expectedDigest) {
    throw new RegistryError("BATCH_QUERY_CHANGED", "The result set changed. Review it and try again.", {
      expected_count: expectedCount,
      actual_count: snapshot.expected_count
    });
  }
  return snapshot;
}

async function executeBatch(registry, input, ids, options = {}) {
  const operation = String(input.operation || "").trim();
  if (!OPERATIONS.includes(operation)) {
    throw new RegistryError("VALIDATION_ERROR", "Batch operation is invalid.", { field: "operation", allowed: OPERATIONS });
  }
  if (operation === "delete") {
    const result = await deleteEntries(registry, ids, {
      maxIds: options.maxIds,
      precondition: options.precondition
    });
    const output = { operation, matched: ids.length, changed: result.deleted, entries: [], ...result };
    if (options.includeEntries === false) {
      delete output.entry_ids;
      delete output.entries;
    }
    return output;
  }
  return withTransaction(registry.db, () => {
    const effectiveIds = typeof options.precondition === "function" ? options.precondition().ids : ids;
    const entries = effectiveIds.map((id) => getEntry(registry, id));
    const changed = [];
    for (const entry of entries) {
      const next = applyOperation(registry, entry, operation, input.value, {
        actor: options.actor,
        reason: input.reason,
        clock: options.clock || Date
      });
      if (next) changed.push(next);
    }
    const result = {
      operation,
      matched: entries.length,
      changed: changed.length,
      entries: effectiveIds.map((id) => getEntry(registry, id))
    };
    if (options.includeEntries === false) delete result.entries;
    return result;
  });
}

function applyOperation(registry, entry, operation, value, options) {
  if (operation === "set_folder") {
    const folderId = value?.folder_id === undefined ? null : value.folder_id;
    if ((entry.folder_id ?? null) === (folderId ?? null)) return null;
    return editEntry(registry, entry.id, { folderId }, options);
  }
  if (operation === "set_kind") {
    if (entry.kind === value?.kind && entry.kind_source === "user") return null;
    return editEntry(registry, entry.id, { kind: value?.kind }, options);
  }
  if (operation === "set_content_focus") {
    if (entry.content_focus === value?.content_focus) return null;
    return editEntry(registry, entry.id, { contentFocus: value?.content_focus }, options);
  }
  if (operation === "set_policy") {
    const changes = {};
    if (value && Object.prototype.hasOwnProperty.call(value, "visibility") && value.visibility !== entry.visibility) changes.visibility = value.visibility;
    if (value && Object.prototype.hasOwnProperty.call(value, "agent_access") && value.agent_access !== entry.agent_access) changes.agentAccess = value.agent_access;
    if (value && Object.prototype.hasOwnProperty.call(value, "ai_processing") && value.ai_processing !== entry.ai_processing) changes.aiProcessing = value.ai_processing;
    if (!Object.keys(changes).length) return null;
    return editEntry(registry, entry.id, changes, options);
  }
  const requested = normalizeTags(value?.tags);
  const existing = entry.tags.map((tag) => ({ name: tag.name, normalized: tag.normalized_name }));
  const requestedNames = new Map(requested.map((tag) => [tag.normalized, tag.name]));
  const nextTags = operation === "add_tags"
    ? [...existing.map((tag) => tag.name), ...requested.filter((tag) => !existing.some((current) => current.normalized === tag.normalized)).map((tag) => tag.name)]
    : existing.filter((tag) => !requestedNames.has(tag.normalized)).map((tag) => tag.name);
  if (nextTags.length === existing.length && nextTags.every((tag, index) => tag === existing[index].name)) return null;
  return editEntry(registry, entry.id, { tags: nextTags }, options);
}

function normalizeTags(value) {
  if (!Array.isArray(value) || !value.length) {
    throw new RegistryError("VALIDATION_ERROR", "Batch tags must be a non-empty array.", { field: "value.tags" });
  }
  const tags = value.map((tag) => normalizeTagName(tag)).map((tag) => ({ name: tag.name, normalized: tag.normalizedName }));
  return [...new Map(tags.map((tag) => [tag.normalized, tag])).values()];
}

module.exports = {
  MAX_QUERY_BATCH_ENTRIES,
  OPERATIONS,
  batchEntries,
  batchEntriesMatching,
  digestEntryIds,
  selectionSnapshot
};
