const { RegistryError } = require("./errors.js");
const { entryId, normalizeTagName } = require("./values.js");

function addTags(registry, entryIdValue, tagNames, { clock = Date } = {}) {
  const normalizedEntryId = ensureEntry(registry, entryIdValue);
  const normalizedTags = uniqueTags(tagNames);
  if (!normalizedTags.length) {
    throw new RegistryError("VALIDATION_ERROR", "At least one tag is required.");
  }
  const current = listTags(registry, normalizedEntryId);
  const existing = new Set(current.map((tag) => tag.normalized_name));
  const additions = normalizedTags.filter((tag) => !existing.has(tag.normalizedName));
  if (!additions.length) return current;
  require("./entries.js").editEntry(registry, normalizedEntryId, {
    tags: [...current.map((tag) => tag.name), ...additions.map((tag) => tag.name)]
  }, { clock });
  return listTags(registry, normalizedEntryId);
}

function removeTags(registry, entryIdValue, tagNames, { clock = Date } = {}) {
  const normalizedEntryId = ensureEntry(registry, entryIdValue);
  const normalizedTags = uniqueTags(tagNames);
  if (!normalizedTags.length) {
    throw new RegistryError("VALIDATION_ERROR", "At least one tag is required.");
  }
  const current = listTags(registry, normalizedEntryId);
  const requested = new Set(normalizedTags.map((tag) => tag.normalizedName));
  const removed = current.filter((tag) => requested.has(tag.normalized_name)).map((tag) => tag.name);
  const present = new Set(current.map((tag) => tag.normalized_name));
  const missing = normalizedTags.filter((tag) => !present.has(tag.normalizedName)).map((tag) => tag.name);
  if (removed.length) {
    require("./entries.js").editEntry(registry, normalizedEntryId, {
      tags: current.filter((tag) => !requested.has(tag.normalized_name)).map((tag) => tag.name)
    }, { clock });
  }

  return {
    entry_id: normalizedEntryId,
    removed,
    missing,
    tags: listTags(registry, normalizedEntryId)
  };
}

function listTags(registry, entryIdValue) {
  const normalizedEntryId = ensureEntry(registry, entryIdValue);
  return registry.db.prepare(`
    SELECT t.id, t.name, t.normalized_name, et.added_at
    FROM tags t
    JOIN entry_tags et ON et.tag_id = t.id
    WHERE et.entry_id = ?
    ORDER BY t.normalized_name ASC, t.id ASC
  `).all(normalizedEntryId).map((row) => ({
    id: Number(row.id),
    name: row.name,
    normalized_name: row.normalized_name,
    added_at: row.added_at
  }));
}

function suggestTags(registry, options = {}) {
  const queryText = String(options.query || "").trim();
  if (!queryText) return [];
  const query = normalizeTagName(queryText).normalizedName;
  const limit = Number(options.limit ?? 8);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 8) {
    throw new RegistryError("VALIDATION_ERROR", "tag suggestion limit must be between 1 and 8.", {
      field: "limit",
      max: 8
    });
  }
  const excluded = uniqueTags((Array.isArray(options.exclude) ? options.exclude : [options.exclude])
    .filter((value) => String(value || "").trim()))
    .map((tag) => tag.normalizedName);
  const exclusionSql = excluded.length
    ? `AND t.normalized_name NOT IN (${excluded.map(() => "?").join(", ")})`
    : "";
  return registry.db.prepare(`
    SELECT t.id, t.name, t.normalized_name, COUNT(et.entry_id) AS entry_count
    FROM tags t
    JOIN entry_tags et ON et.tag_id = t.id
    WHERE instr(t.normalized_name, ?) > 0
      ${exclusionSql}
    GROUP BY t.id, t.name, t.normalized_name
    ORDER BY
      CASE WHEN substr(t.normalized_name, 1, length(?)) = ? THEN 0 ELSE 1 END ASC,
      entry_count DESC,
      t.normalized_name ASC,
      t.id ASC
    LIMIT ?
  `).all(query, ...excluded, query, query, limit).map((row) => ({
    id: Number(row.id),
    name: row.name,
    normalized_name: row.normalized_name,
    entry_count: Number(row.entry_count)
  }));
}

function uniqueTags(values) {
  const list = Array.isArray(values) ? values : [values];
  const byNormalized = new Map();
  for (const value of list) {
    if (value === undefined || value === null) {
      continue;
    }
    const tag = normalizeTagName(value);
    if (!byNormalized.has(tag.normalizedName)) {
      byNormalized.set(tag.normalizedName, tag);
    }
  }
  return Array.from(byNormalized.values());
}

function ensureEntry(registry, value) {
  const id = entryId(value);
  if (!registry.db.prepare("SELECT 1 FROM entries WHERE id = ?").get(id)) {
    throw new RegistryError("ENTRY_NOT_FOUND", "Entry not found.", { entryId: id });
  }
  return id;
}

module.exports = {
  addTags,
  listTags,
  removeTags,
  suggestTags,
  uniqueTags
};
