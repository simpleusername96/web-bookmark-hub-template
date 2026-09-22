const { normalizePagination, positiveInteger } = require("./values.js");
const { activeEntryPredicate } = require("./entry-status.js");

function topTags(registry, options = {}) {
  const limit = normalizeLimit(options.limit);
  return registry.db.prepare(`
    SELECT t.id, t.name, t.normalized_name, COUNT(et.entry_id) AS entry_count
    FROM tags t
    JOIN entry_tags et ON et.tag_id = t.id
    JOIN entries e ON e.id = et.entry_id AND ${activeEntryPredicate("e")}
    GROUP BY t.id, t.name, t.normalized_name
    ORDER BY entry_count DESC, t.normalized_name ASC, t.id ASC
    LIMIT ?
  `).all(limit).map((row) => ({
    id: Number(row.id),
    name: row.name,
    normalized_name: row.normalized_name,
    entry_count: Number(row.entry_count)
  }));
}

function topSourceDomains(registry, options = {}) {
  const limit = normalizeLimit(options.limit);
  const threshold = positiveInteger(options.threshold ?? 3, "threshold");
  return registry.db.prepare(`
    SELECT source_domain, COUNT(*) AS entry_count
    FROM entries e
    WHERE ${activeEntryPredicate("e")}
    GROUP BY source_domain
    HAVING COUNT(*) >= ?
    ORDER BY entry_count DESC, source_domain ASC
    LIMIT ?
  `).all(threshold, limit).map((row) => ({
    source_domain: row.source_domain,
    entry_count: Number(row.entry_count)
  }));
}

function normalizeLimit(value) {
  const { pageSize } = normalizePagination({ page: 1, pageSize: value ?? 5 });
  return pageSize;
}

module.exports = {
  topSourceDomains,
  topTags
};
