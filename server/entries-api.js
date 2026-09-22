"use strict";

const { addComment, listComments } = require("../registry/comments.js");
const { captureEntries } = require("../registry/captures.js");
const { deleteEntry, normalizeEntryIds } = require("../registry/entry-deletion.js");
const {
  editEntry,
  getEntry,
  listEntries,
  listEntryRevisions,
  restoreEntry
} = require("../registry/entries.js");
const { RegistryError } = require("../registry/errors.js");
const { batchEntries, batchEntriesMatching, selectionSnapshot } = require("../registry/entry-batch.js");

const ENTRY_BODY_FIELDS = new Set([
  "url", "title", "kind", "published_at", "folder_id", "content_focus", "tags", "comment",
  "visibility"
]);
const ENTRY_EDIT_FIELDS = new Set([
  "url", "title", "kind", "typed_metadata", "published_at", "updated_at", "folder_id",
  "content_focus", "tags", "visibility", "reason"
]);
const ENTRY_BATCH_FIELDS = new Set(["entry_ids", "query", "expected_count", "expected_digest", "operation", "value", "reason"]);
const ENTRY_BATCH_QUERY_FIELDS = new Set([
  "search", "kind", "provider", "source_domain", "visibility", "agent_access", "content_focus", "preview",
  "folder_id", "include_descendants", "unfiled", "saved_from", "saved_to", "tag", "url_group_id"
]);

function batchEntriesFromApi(registry, body, { requesterScope, clock = Date } = {}) {
  assertPlainObject(body, "Batch request body must be an object.");
  assertAllowedFields(body, ENTRY_BATCH_FIELDS);
  if (body.query !== undefined) {
    if (body.entry_ids !== undefined) {
      throw new RegistryError("VALIDATION_ERROR", "Batch request must use either entry_ids or query, not both.");
    }
    assertPlainObject(body.query, "Batch query must be an object.");
    assertAllowedFields(body.query, ENTRY_BATCH_QUERY_FIELDS);
    return batchEntriesMatching(registry, {
      filters: entryFiltersFromObject(body.query),
      expected_count: body.expected_count,
      expected_digest: body.expected_digest,
      operation: body.operation,
      value: body.value,
      reason: body.reason
    }, {
      actor: { type: "user", id: requesterScope },
      clock
    });
  }
  if (body.expected_count !== undefined || body.expected_digest !== undefined) {
    throw new RegistryError("VALIDATION_ERROR", "expected_count and expected_digest require query.", { field: "expected_count" });
  }
  return batchEntries(registry, body, {
    actor: { type: "user", id: requesterScope },
    clock
  });
}

function selectionSnapshotFromQuery(registry, searchParams) {
  const snapshot = selectionSnapshot(registry, entryFiltersFromQuery(searchParams));
  return {
    expected_count: snapshot.expected_count,
    expected_digest: snapshot.expected_digest
  };
}

function selectedEntryIdsFromApi(registry, body) {
  if (body.entry_ids !== undefined) {
    if (body.query !== undefined || body.expected_count !== undefined || body.expected_digest !== undefined) {
      throw new RegistryError("VALIDATION_ERROR", "Use either entry_ids or a query snapshot.");
    }
    return normalizeEntryIds(body.entry_ids);
  }
  assertPlainObject(body.query, "Selected summary query must be an object.");
  assertAllowedFields(body.query, ENTRY_BATCH_QUERY_FIELDS);
  const count = body.expected_count;
  const digest = body.expected_digest;
  if (!Number.isSafeInteger(count) || count < 1 || !/^[0-9a-f]{64}$/.test(digest || "")) {
    throw new RegistryError("VALIDATION_ERROR", "A valid selection snapshot is required.");
  }
  const snapshot = selectionSnapshot(registry, entryFiltersFromObject(body.query));
  if (snapshot.expected_count !== count || snapshot.expected_digest !== digest) {
    throw new RegistryError("BATCH_QUERY_CHANGED", "The selected results changed. Review them and try again.");
  }
  return snapshot.ids;
}

function entryFiltersFromObject(value) {
  return {
    search: value.search,
    kind: value.kind,
    provider: value.provider,
    sourceDomain: value.source_domain,
    visibility: value.visibility,
    agentAccess: value.agent_access,
    contentFocus: value.content_focus,
    preview: value.preview,
    folderId: value.folder_id,
    includeDescendants: optionalBodyBoolean(value.include_descendants, "include_descendants"),
    unfiled: optionalBodyBoolean(value.unfiled, "unfiled"),
    savedFrom: value.saved_from,
    savedTo: value.saved_to,
    tag: value.tag,
    urlGroupId: value.url_group_id
  };
}

function optionalBodyBoolean(value, field) {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new RegistryError("VALIDATION_ERROR", `${field} must be true or false.`, { field });
  return value;
}

function listEntriesFromQuery(registry, searchParams) {
  return listEntries(registry, {
    ...entryFiltersFromQuery(searchParams),
    sort: queryValue(searchParams, "sort"),
    page: queryValue(searchParams, "page"),
    pageSize: queryValue(searchParams, "page_size")
  });
}

function entryFiltersFromQuery(searchParams) {
  return {
    search: queryValue(searchParams, "search"),
    kind: queryValue(searchParams, "kind"),
    provider: queryValue(searchParams, "provider"),
    sourceDomain: queryValue(searchParams, "source_domain"),
    visibility: queryValue(searchParams, "visibility"),
    agentAccess: queryValue(searchParams, "agent_access"),
    contentFocus: queryValue(searchParams, "content_focus"),
    preview: queryValue(searchParams, "preview"),
    folderId: queryValue(searchParams, "folder_id"),
    includeDescendants: queryBoolean(searchParams, "include_descendants"),
    unfiled: queryBoolean(searchParams, "unfiled"),
    savedFrom: queryValue(searchParams, "saved_from"),
    savedTo: queryValue(searchParams, "saved_to"),
    tag: queryValue(searchParams, "tag"),
    urlGroupId: queryValue(searchParams, "url_group_id")
  };
}

function createEntryFromApi(registry, body, { requesterScope, clientRequestId, clock = Date }) {
  assertPlainObject(body, "Entry request body must be an object.");
  assertAllowedFields(body, ENTRY_BODY_FIELDS);
  const capture = captureEntries(registry, {
    channel: "web",
    adapter: "web-add-url",
    requesterScope,
    clientRequestId,
    items: [{
      entryUrl: body.url,
      title: body.title,
      kind: body.kind,
      publishedAt: body.published_at,
      folderId: body.folder_id,
      contentFocus: body.content_focus,
      tags: body.tags,
      comment: body.comment,
      visibility: body.visibility
    }]
  }, { clock });
  const item = capture.items[0];
  if (!item || item.entry_id === null) {
    throw new RegistryError(item?.outcome_code || "VALIDATION_ERROR", "Entry could not be created.");
  }
  return {
    entry: getEntry(registry, item.entry_id, { includeArchived: item.outcome_code === "already_saved" }),
    outcome_code: item.outcome_code,
    replayed: capture.replayed,
    request_id: capture.request.id
  };
}

function editEntryFromApi(registry, entryId, body, { requesterScope, clock = Date } = {}) {
  assertPlainObject(body, "Entry edit body must be an object.");
  assertAllowedFields(body, ENTRY_EDIT_FIELDS);
  const changes = {};
  const mappings = {
    url: "url",
    title: "title",
    kind: "kind",
    typed_metadata: "typedMetadata",
    published_at: "publishedAt",
    updated_at: "updatedAt",
    folder_id: "folderId",
    content_focus: "contentFocus",
    tags: "tags",
    visibility: "visibility"
  };
  for (const [apiField, registryField] of Object.entries(mappings)) {
    if (own(body, apiField)) changes[registryField] = body[apiField];
  }
  return editEntry(registry, entryId, changes, {
    actor: { type: "user", id: requesterScope },
    reason: body.reason,
    clock
  });
}

async function deleteEntryFromApi(registry, entryId, body) {
  assertLifecycleBody(body);
  return deleteEntry(registry, entryId);
}

function restoreEntryFromApi(registry, entryId, body, options = {}) {
  assertLifecycleBody(body);
  return restoreEntry(registry, entryId, {
    actor: { type: "user", id: options.requesterScope },
    reason: body.reason,
    clock: options.clock || Date
  });
}

function assertLifecycleBody(body) {
  assertPlainObject(body, "Entry lifecycle body must be an object.");
  assertAllowedFields(body, new Set(["reason"]));
}

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function listEntryComments(registry, entryId, searchParams) {
  return listComments(registry, entryId, {
    page: queryValue(searchParams, "page"),
    pageSize: queryValue(searchParams, "page_size")
  });
}

function addEntryComment(registry, entryId, body, { clock = Date } = {}) {
  assertPlainObject(body, "Comment request body must be an object.");
  assertAllowedFields(body, new Set(["text"]));
  return addComment(registry, entryId, body.text, { clock });
}

function queryValue(searchParams, name) {
  return searchParams.has(name) ? searchParams.get(name) : undefined;
}

function queryBoolean(searchParams, name) {
  if (!searchParams.has(name)) return undefined;
  const value = searchParams.get(name);
  if (["1", "true"].includes(value)) return true;
  if (["0", "false"].includes(value)) return false;
  throw new RegistryError("VALIDATION_ERROR", `${name} must be true or false.`, { field: name });
}

function assertPlainObject(value, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RegistryError("VALIDATION_ERROR", message);
  }
}

function assertAllowedFields(value, allowed) {
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length) {
    throw new RegistryError("VALIDATION_ERROR", "Request body contains unsupported fields.", {
      fields: unexpected.sort()
    });
  }
}

module.exports = {
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
  selectionSnapshotFromQuery,
  selectedEntryIdsFromApi,
  restoreEntryFromApi
};
