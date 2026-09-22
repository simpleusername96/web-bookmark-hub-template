"use strict";

const { RegistryError } = require("./errors.js");
const { entryId, nowIso, optionalText, parseStoredJson } = require("./values.js");

const ACTIONS = Object.freeze(["created", "updated", "archived", "restored"]);
const ACTOR_TYPES = Object.freeze(["user", "agent", "system"]);

function recordEntryRevision(registry, entryIdValue, action, changes, options = {}) {
  const normalizedEntryId = entryId(entryIdValue);
  if (!ACTIONS.includes(action)) {
    throw new RegistryError("INTERNAL_ERROR", "Entry revision action is invalid.");
  }
  const actor = normalizeActor(options.actor);
  const reason = options.reason === undefined || options.reason === null
    ? null
    : optionalText(options.reason, "reason", { maxLength: 1000 });
  const next = registry.db.prepare(`
    SELECT COALESCE(MAX(revision_number), 0) + 1 AS revision_number
    FROM entry_revisions
    WHERE entry_id = ?
  `).get(normalizedEntryId);
  registry.db.prepare(`
    INSERT INTO entry_revisions (
      entry_id, revision_number, action, actor_type, actor_id, changes_json, reason, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    normalizedEntryId,
    Number(next.revision_number),
    action,
    actor.type,
    actor.id,
    JSON.stringify(changes || {}),
    reason,
    nowIso(options.clock || Date)
  );
}

function listEntryRevisions(registry, entryIdValue) {
  const normalizedEntryId = entryId(entryIdValue);
  const exists = registry.db.prepare("SELECT id FROM entries WHERE id = ?").get(normalizedEntryId);
  if (!exists) {
    throw new RegistryError("ENTRY_NOT_FOUND", "Entry not found.", { entryId: normalizedEntryId });
  }
  return registry.db.prepare(`
    SELECT id, entry_id, revision_number, action, actor_type, actor_id,
      changes_json, reason, created_at
    FROM entry_revisions
    WHERE entry_id = ?
    ORDER BY revision_number DESC
  `).all(normalizedEntryId).map((row) => ({
    id: Number(row.id),
    entry_id: Number(row.entry_id),
    revision_number: Number(row.revision_number),
    action: row.action,
    actor_type: row.actor_type,
    actor_id: row.actor_id,
    changes: parseStoredJson(row.changes_json, {}),
    reason: row.reason,
    created_at: row.created_at
  }));
}

function buildEntryChanges(before, after) {
  const changes = {};
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const key of keys) {
    const beforeValue = before ? before[key] : null;
    const afterValue = after ? after[key] : null;
    if (JSON.stringify(beforeValue) !== JSON.stringify(afterValue)) {
      changes[key] = { before: beforeValue, after: afterValue };
    }
  }
  return changes;
}

function normalizeActor(value) {
  const type = value?.type === undefined ? "user" : String(value.type).trim();
  if (!ACTOR_TYPES.includes(type)) {
    throw new RegistryError("VALIDATION_ERROR", "actor type is invalid.", {
      field: "actor_type",
      allowed: ACTOR_TYPES
    });
  }
  const id = value?.id === undefined || value?.id === null
    ? null
    : optionalText(value.id, "actor_id", { maxLength: 200 });
  return { type, id };
}

module.exports = {
  ACTIONS,
  ACTOR_TYPES,
  buildEntryChanges,
  listEntryRevisions,
  normalizeActor,
  recordEntryRevision
};
