const { RegistryError } = require("./errors.js");
const {
  MAX_COMMENT_LENGTH,
  entryId,
  normalizePagination,
  nowIso,
  positiveInteger,
  requireText
} = require("./values.js");

function addComment(registry, entryIdValue, body, { clock = Date } = {}) {
  const normalizedEntryId = ensureEntry(registry, entryIdValue);
  const normalizedBody = requireText(body, "comment", { maxLength: MAX_COMMENT_LENGTH });
  const createdAt = nowIso(clock);
  const result = registry.db.prepare(`
    INSERT INTO entry_comments (entry_id, body, created_at)
    VALUES (?, ?, ?)
  `).run(normalizedEntryId, normalizedBody, createdAt);
  return {
    id: Number(result.lastInsertRowid),
    entry_id: normalizedEntryId,
    body: normalizedBody,
    created_at: createdAt
  };
}

function listComments(registry, entryIdValue, options = {}) {
  const normalizedEntryId = ensureEntry(registry, entryIdValue);
  const pagination = normalizePagination(options);
  const total = Number(registry.db.prepare(`
    SELECT COUNT(*) AS count FROM entry_comments WHERE entry_id = ?
  `).get(normalizedEntryId).count);
  const items = registry.db.prepare(`
    SELECT id, entry_id, body, created_at
    FROM entry_comments
    WHERE entry_id = ?
    ORDER BY created_at ASC, id ASC
    LIMIT ? OFFSET ?
  `).all(normalizedEntryId, pagination.pageSize, pagination.offset).map((row) => ({
    id: Number(row.id),
    entry_id: Number(row.entry_id),
    body: row.body,
    created_at: row.created_at
  }));
  return {
    items,
    page: pagination.page,
    page_size: pagination.pageSize,
    total,
    total_pages: Math.ceil(total / pagination.pageSize)
  };
}

function ensureEntry(registry, value) {
  const id = entryId(value);
  if (!registry.db.prepare("SELECT 1 FROM entries WHERE id = ?").get(id)) {
    throw new RegistryError("ENTRY_NOT_FOUND", "Entry not found.", { entryId: id });
  }
  return id;
}

function ensureCommentId(value) {
  return positiveInteger(value, "comment_id");
}

module.exports = {
  addComment,
  ensureCommentId,
  listComments
};
