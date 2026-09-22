"use strict";

const { analyzeUrl, normalizeSourceDomain, validateKind } = require("./url-policy.js");
const { RegistryError } = require("./errors.js");
const { activeEntryPredicate } = require("./entry-status.js");
const { CONTENT_FOCUS_VALUES } = require("./constants.js");
const { descendantFolderIds, getFolder } = require("./folders.js");
const { resolveUrlGroupEntryIds } = require("./url-groups.js");
const {
  normalizePagination,
  normalizeTagName,
  normalizeTimestamp,
  parseStoredJson
} = require("./values.js");

function listEntries(registry, filters = {}) {
  const pagination = normalizePagination(filters);
  const sort = normalizeSort(filters.sort);
  const { whereSql, params } = buildEntryFilter(registry, filters);

  const orderSql = sortOrderSql(sort);
  const totalRow = registry.db.prepare(`SELECT COUNT(*) AS count FROM entries e ${whereSql}`).get(...params);
  const rows = registry.db.prepare(`
    SELECT e.*,
      (SELECT COUNT(*) FROM entry_comments c WHERE c.entry_id = e.id) AS comment_count,
      (SELECT COUNT(*) FROM entry_visual_assets v WHERE v.entry_id = e.id) AS visual_asset_count,
      (SELECT COUNT(*) FROM entry_visual_assets v WHERE v.entry_id = e.id AND v.source_kind = 'page_snapshot') AS snapshot_count,
      (SELECT COUNT(*) FROM summary_jobs j WHERE j.entry_id = e.id) AS summary_job_count,
      f.name AS folder_name,
      f.normalized_name AS folder_normalized_name,
      f.parent_id AS folder_parent_id,
      cover.id AS cover_id,
      cover.source_kind AS cover_source_kind,
      cover.source_url AS cover_source_url,
      cover.storage_kind AS cover_storage_kind,
      cover.status AS cover_status,
      cover.storage_path AS cover_storage_path,
      cover.media_type AS cover_media_type,
      cover.byte_size AS cover_byte_size,
      latest_summary.id AS latest_summary_id,
      latest_summary.summary_text AS latest_summary_text,
      latest_summary.model AS latest_summary_model,
      latest_summary.reasoning_effort AS latest_summary_reasoning_effort,
      latest_summary.input_sha256 AS latest_summary_input_sha256,
      latest_summary.created_at AS latest_summary_created_at
    FROM entries e
    LEFT JOIN folders f ON f.id = e.folder_id
    LEFT JOIN entry_visual_assets cover ON cover.entry_id = e.id AND cover.is_cover = 1
    LEFT JOIN summaries latest_summary ON latest_summary.id = (
      SELECT s.id FROM summaries s
      JOIN summary_jobs completed_summary_job ON completed_summary_job.id = s.job_id
      WHERE s.entry_id = e.id
        AND completed_summary_job.status = 'completed'
      ORDER BY s.created_at DESC, s.id DESC
      LIMIT 1
    )
    ${whereSql}
    ORDER BY ${orderSql}
    LIMIT ? OFFSET ?
  `).all(...params, pagination.pageSize, pagination.offset);
  const tagsByEntry = listTagsByEntry(registry, rows.map((row) => Number(row.id)));

  return {
    items: rows.map((row) => mapEntryRow(row, tagsByEntry.get(Number(row.id)) || [])),
    page: pagination.page,
    page_size: pagination.pageSize,
    total: Number(totalRow.count),
    total_pages: Math.ceil(Number(totalRow.count) / pagination.pageSize)
  };
}

function listEntryReferences(registry, filters = {}) {
  const { whereSql, params } = buildEntryFilter(registry, filters);
  return registry.db.prepare(`
    SELECT e.id, e.url_canonical, e.folder_id
    FROM entries e
    ${whereSql}
    ORDER BY e.id ASC
  `).all(...params).map((row) => ({
    id: Number(row.id),
    url_canonical: row.url_canonical,
    folder_id: row.folder_id === null ? null : Number(row.folder_id)
  }));
}

function buildEntryFilter(registry, filters) {
  const where = filters.includeArchived ? [] : [activeEntryPredicate("e")];
  const params = [];

  addFilter(where, params, "e.kind = ?", filters.kind && validateKind(filters.kind));
  addFilter(where, params, "e.provider = ?", normalizedFilter(filters.provider, "provider", true));
  if (filters.sourceDomain !== undefined) {
    const sourceDomain = normalizeSourceDomain(normalizedFilter(filters.sourceDomain, "source_domain"));
    addFilter(where, params, "e.source_domain = ?", sourceDomain);
  }
  addChoiceFilter(where, params, "e.visibility = ?", filters.visibility, ["normal", "private"], "visibility");
  addChoiceFilter(where, params, "e.agent_access = ?", filters.agentAccess, ["blocked", "metadata_only", "allowed"], "agent_access");
  addChoiceFilter(where, params, "e.content_focus = ?", filters.contentFocus, CONTENT_FOCUS_VALUES, "content_focus");
  if (filters.preview !== undefined) {
    const preview = normalizedFilter(filters.preview, "preview", true);
    if (!["with", "without"].includes(preview)) {
      throw new RegistryError("VALIDATION_ERROR", "preview has an unsupported value.", {
        field: "preview",
        value: preview,
        allowed: ["with", "without"]
      });
    }
    const renderableCover = `EXISTS (
      SELECT 1 FROM entry_visual_assets preview_cover
      WHERE preview_cover.entry_id = e.id
        AND preview_cover.is_cover = 1
        AND (
          (preview_cover.storage_kind = 'local' AND preview_cover.status = 'ready')
          OR (preview_cover.storage_kind = 'remote' AND preview_cover.status = 'referenced')
        )
    )`;
    where.push(preview === "with" ? renderableCover : `NOT ${renderableCover}`);
  }

  if (filters.urlGroupId !== undefined) {
    const entryIds = resolveUrlGroupEntryIds(registry, filters.urlGroupId);
    where.push(`e.id IN (${entryIds.map(() => "?").join(", ")})`);
    params.push(...entryIds);
  }

  if (filters.folderId !== undefined && filters.unfiled) {
    throw new RegistryError("VALIDATION_ERROR", "folder_id and unfiled cannot be combined.", {
      fields: ["folder_id", "unfiled"]
    });
  }
  if (filters.includeDescendants && filters.folderId === undefined) {
    throw new RegistryError("VALIDATION_ERROR", "include_descendants requires folder_id.", {
      field: "include_descendants"
    });
  }
  if (filters.folderId !== undefined) {
    const folderId = getFolder(registry, filters.folderId).id;
    const folderIds = filters.includeDescendants
      ? [folderId, ...descendantFolderIds(registry, folderId)]
      : [folderId];
    where.push(`e.folder_id IN (${folderIds.map(() => "?").join(", ")})`);
    params.push(...folderIds);
  } else if (filters.unfiled) {
    where.push("e.folder_id IS NULL");
  }

  if (filters.savedFrom) {
    where.push("e.saved_at >= ?");
    params.push(normalizeTimestamp(filters.savedFrom, "saved_from"));
  }
  if (filters.savedTo) {
    where.push("e.saved_at <= ?");
    params.push(normalizeTimestamp(filters.savedTo, "saved_to", { endOfDay: true }));
  }
  if (filters.tag) {
    const normalizedTag = normalizeTagName(filters.tag).normalizedName;
    where.push(`EXISTS (
      SELECT 1 FROM entry_tags et
      JOIN tags t ON t.id = et.tag_id
      WHERE et.entry_id = e.id AND t.normalized_name = ?
    )`);
    params.push(normalizedTag);
  }
  if (filters.search !== undefined) {
    const search = normalizedFilter(filters.search, "search");
    if (search.length > 1000) {
      throw new RegistryError("VALIDATION_ERROR", "search is too long.", {
        field: "search",
        maxLength: 1000
      });
    }
    const pattern = `%${escapeLikePattern(search)}%`;
    where.push(`(
      (e.title_origin IN ('user','ai') AND COALESCE(e.title, '') LIKE ? ESCAPE '\\' COLLATE NOCASE)
      OR e.url_original LIKE ? ESCAPE '\\' COLLATE NOCASE
      OR e.url_canonical LIKE ? ESCAPE '\\' COLLATE NOCASE
      OR e.provider LIKE ? ESCAPE '\\' COLLATE NOCASE
      OR e.source_domain LIKE ? ESCAPE '\\' COLLATE NOCASE
      OR EXISTS (
        SELECT 1 FROM entry_tags search_et
        JOIN tags search_t ON search_t.id = search_et.tag_id
        WHERE search_et.entry_id = e.id
          AND search_t.name LIKE ? ESCAPE '\\' COLLATE NOCASE
      )
      OR EXISTS (
        SELECT 1 FROM entry_comments search_comment
        WHERE search_comment.entry_id = e.id
          AND search_comment.body LIKE ? ESCAPE '\\' COLLATE NOCASE
      )
    )`);
    params.push(pattern, pattern, pattern, pattern, pattern, pattern, pattern);
  }

  return {
    whereSql: where.length ? `WHERE ${where.join(" AND ")}` : "",
    params
  };
}

function mapEntryRow(row, tags = []) {
  return {
    id: Number(row.id),
    url_original: row.url_original,
    url_canonical: row.url_canonical,
    title: row.title_origin === "capture_caption" ? null : row.title,
    title_origin: row.title_origin,
    kind: row.kind,
    kind_source: row.kind_source,
    provider: row.provider,
    source_domain: row.source_domain,
    creator_handle: analyzeUrl(row.url_canonical).creator_handle,
    typed_metadata: parseStoredJson(row.typed_metadata_json, {}),
    saved_at: row.saved_at,
    published_at: row.published_at,
    updated_at: row.updated_at,
    visibility: row.visibility,
    agent_access: row.agent_access,
    ai_processing: row.ai_processing,
    content_focus: row.content_focus,
    created_via: row.created_via,
    capture_adapter: row.capture_adapter,
    capture_request_id: row.capture_request_id === null || row.capture_request_id === undefined
      ? null
      : Number(row.capture_request_id),
    capture_item_index: row.capture_item_index === null || row.capture_item_index === undefined
      ? null
      : Number(row.capture_item_index),
    deleted_at: row.deleted_at ?? null,
    folder_id: row.folder_id === null || row.folder_id === undefined ? null : Number(row.folder_id),
    folder: row.folder_id === null || row.folder_id === undefined ? null : {
      id: Number(row.folder_id),
      name: row.folder_name,
      normalized_name: row.folder_normalized_name,
      parent_id: row.folder_parent_id === null || row.folder_parent_id === undefined
        ? null
        : Number(row.folder_parent_id)
    },
    cover_image: row.cover_id === null || row.cover_id === undefined ? null : {
      id: Number(row.cover_id),
      source_kind: row.cover_source_kind,
      source_url: row.cover_source_url,
      storage_kind: row.cover_storage_kind,
      status: row.cover_status,
      storage_path: row.cover_storage_path,
      media_type: row.cover_media_type,
      byte_size: row.cover_byte_size === null || row.cover_byte_size === undefined
        ? null
        : Number(row.cover_byte_size)
    },
    latest_summary: row.latest_summary_id === null || row.latest_summary_id === undefined ? null : {
      id: Number(row.latest_summary_id),
      text: row.latest_summary_text,
      model: row.latest_summary_model,
      reasoning_effort: row.latest_summary_reasoning_effort,
      input_sha256: row.latest_summary_input_sha256,
      created_at: row.latest_summary_created_at
    },
    record_created_at: row.record_created_at,
    record_updated_at: row.record_updated_at,
    tags,
    comment_count: Number(row.comment_count || 0),
    visual_asset_count: Number(row.visual_asset_count || 0),
    snapshot_count: Number(row.snapshot_count || 0),
    summary_job_count: Number(row.summary_job_count || 0)
  };
}

function mapTagRow(row) {
  return {
    id: Number(row.id),
    name: row.name,
    normalized_name: row.normalized_name,
    added_at: row.added_at
  };
}

function listTagsByEntry(registry, entryIds) {
  const tagsByEntry = new Map();
  if (!entryIds.length) {
    return tagsByEntry;
  }
  const placeholders = entryIds.map(() => "?").join(", ");
  const rows = registry.db.prepare(`
    SELECT et.entry_id, t.id, t.name, t.normalized_name, et.added_at
    FROM entry_tags et
    JOIN tags t ON t.id = et.tag_id
    WHERE et.entry_id IN (${placeholders})
    ORDER BY et.entry_id ASC, t.normalized_name ASC, t.id ASC
  `).all(...entryIds);
  for (const row of rows) {
    const id = Number(row.entry_id);
    const tags = tagsByEntry.get(id) || [];
    tags.push(mapTagRow(row));
    tagsByEntry.set(id, tags);
  }
  return tagsByEntry;
}

function normalizedFilter(value, field, lower = false) {
  if (value === undefined) {
    return undefined;
  }
  const text = String(value).trim();
  if (!text) {
    throw new RegistryError("VALIDATION_ERROR", `${field} cannot be empty.`, { field });
  }
  return lower ? text.toLocaleLowerCase("en-US") : text;
}

function normalizeSort(value) {
  const input = value === undefined
    ? "newest"
    : String(value).trim().toLocaleLowerCase("en-US");
  const normalized = input === "title" ? "title_asc" : input;
  const allowed = ["newest", "oldest", "updated_desc", "updated_asc", "title_asc", "title_desc", "source_asc", "source_desc"];
  if (!allowed.includes(normalized)) {
    throw new RegistryError("VALIDATION_ERROR", "sort has an unsupported value.", {
      field: "sort",
      value: normalized,
      allowed
    });
  }
  return normalized;
}

function sortOrderSql(sort) {
  if (sort === "oldest") {
    return "e.saved_at ASC, e.id ASC";
  }
  const titleExpression = "COALESCE(NULLIF(CASE WHEN e.title_origin IN ('user','ai') THEN e.title END, ''), e.url_original) COLLATE NOCASE";
  if (sort === "title" || sort === "title_asc") {
    return `${titleExpression} ASC, e.id ASC`;
  }
  if (sort === "title_desc") {
    return `${titleExpression} DESC, e.id DESC`;
  }
  if (sort === "source_asc") {
    return `e.source_domain COLLATE NOCASE ASC, ${titleExpression} ASC, e.id ASC`;
  }
  if (sort === "source_desc") {
    return `e.source_domain COLLATE NOCASE DESC, ${titleExpression} DESC, e.id DESC`;
  }
  if (sort === "updated_desc") {
    return "e.record_updated_at DESC, e.id DESC";
  }
  if (sort === "updated_asc") {
    return "e.record_updated_at ASC, e.id ASC";
  }
  return "e.saved_at DESC, e.id DESC";
}

function escapeLikePattern(value) {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function addFilter(where, params, sql, value) {
  if (value !== undefined && value !== null && value !== "") {
    where.push(sql);
    params.push(value);
  }
}

function addChoiceFilter(where, params, sql, value, allowed, field) {
  if (value === undefined) {
    return;
  }
  if (!allowed.includes(value)) {
    throw new RegistryError("VALIDATION_ERROR", `${field} has an unsupported value.`, {
      field,
      value,
      allowed
    });
  }
  where.push(sql);
  params.push(value);
}

module.exports = {
  listEntryReferences,
  listEntries,
  listTagsByEntry,
  mapEntryRow,
  mapTagRow,
  normalizeSort,
  sortOrderSql
};
