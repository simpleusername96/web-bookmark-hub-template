const { analyzeUrl, validateKind } = require("./url-policy.js");
const { RegistryError } = require("./errors.js");
const { normalizePolicy } = require("./privacy.js");
const {
  CONTENT_FOCUS_VALUES,
  DEFAULT_CONTENT_FOCUS,
  ENTRY_CREATION_CHANNELS
} = require("./constants.js");
const { getFolder } = require("./folders.js");
const { withTransaction } = require("./database.js");
const {
  listEntries,
  mapEntryRow,
  mapTagRow,
  normalizeSort
} = require("./entry-query.js");
const {
  buildEntryChanges,
  listEntryRevisions,
  recordEntryRevision
} = require("./entry-revisions.js");
const { uniqueTags } = require("./tags.js");
const {
  entryId,
  normalizeMetadata,
  normalizeTimestamp,
  nowIso,
  optionalText
} = require("./values.js");

function addEntry(registry, input, options = {}) {
  return withTransaction(registry.db, () => addEntryWithinTransaction(registry, input, options));
}

function addEntryWithinTransaction(registry, input, { clock = Date, provenance, actor, reason } = {}) {
  const analyzed = analyzeUrl(input.url, { kindOverride: input.kind });
  const existing = findEntryByCanonicalUrl(registry, analyzed.url_canonical);
  if (existing) {
    return {
      outcome_code: "already_saved",
      entry: getEntry(registry, existing.id, { includeArchived: true })
    };
  }
  const policy = normalizePolicy({
    visibility: input.visibility,
    agentAccess: input.agentAccess,
    aiProcessing: input.aiProcessing
  });
  const title = optionalText(input.title, "title") ?? null;
  const metadata = normalizeMetadata(input.typedMetadata ?? {}) ?? {};
  const savedAt = input.savedAt
    ? normalizeTimestamp(input.savedAt, "saved_at")
    : nowIso(clock);
  const recordAt = nowIso(clock);
  const publishedAt = normalizeOptionalTimestamp(input.publishedAt, "published_at");
  const updatedAt = normalizeOptionalTimestamp(input.updatedAt, "updated_at");
  const contentFocus = normalizeContentFocus(input.contentFocus ?? DEFAULT_CONTENT_FOCUS);
  const folderId = normalizeFolderId(registry, input.folderId);
  const creation = normalizeCreationProvenance(provenance);
  const titleOrigin = normalizeTitleOrigin(title, creation);

  const result = registry.db.prepare(`
    INSERT INTO entries (
      url_original, url_canonical, title, title_origin, kind, kind_source, provider, source_domain,
      typed_metadata_json, saved_at, published_at, updated_at,
      visibility, agent_access, ai_processing, content_focus, folder_id,
      created_via, capture_adapter, capture_request_id, capture_item_index,
      record_created_at, record_updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    analyzed.url_original,
    analyzed.url_canonical,
    title,
    titleOrigin,
    analyzed.kind,
    analyzed.kind_source,
    analyzed.provider,
    analyzed.source_domain,
    JSON.stringify(metadata),
    savedAt,
    publishedAt,
    updatedAt,
    policy.visibility,
    policy.agentAccess,
    policy.aiProcessing,
    contentFocus,
    folderId,
    creation.createdVia,
    creation.captureAdapter,
    creation.captureRequestId,
    creation.captureItemIndex,
    recordAt,
    recordAt
  );

  const entry = getEntry(registry, Number(result.lastInsertRowid));
  recordEntryRevision(registry, entry.id, "created", buildEntryChanges(null, editableSnapshot(entry)), {
    actor: actor || { type: "user", id: creation.createdVia },
    reason,
    clock
  });
  return {
    outcome_code: "created",
    entry
  };
}

function getEntry(registry, id, options = {}) {
  const normalizedId = entryId(id);
  const row = registry.db.prepare(`
    SELECT
      e.*,
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
    WHERE e.id = ? ${options.includeArchived ? "" : "AND e.deleted_at IS NULL"}
  `).get(normalizedId);
  if (!row) {
    throw new RegistryError("ENTRY_NOT_FOUND", "Entry not found.", { entryId: normalizedId });
  }

  const tags = registry.db.prepare(`
    SELECT t.id, t.name, t.normalized_name, et.added_at
    FROM tags t
    JOIN entry_tags et ON et.tag_id = t.id
    WHERE et.entry_id = ?
    ORDER BY t.normalized_name ASC, t.id ASC
  `).all(normalizedId).map(mapTagRow);

  return mapEntryRow(row, tags);
}

function editEntry(registry, id, changes, options = {}) {
  return withTransaction(registry.db, () => {
    const { clock = Date, actor, reason } = options;
    const current = getEntry(registry, id);
    const assignments = [];
    const values = [];
    let hasRelationalChange = false;

    if (Object.prototype.hasOwnProperty.call(changes, "url")) {
      const analyzed = analyzeUrl(changes.url, {
        kindOverride: Object.prototype.hasOwnProperty.call(changes, "kind")
          ? changes.kind ?? undefined
          : (current.kind_source === "user" ? current.kind : undefined)
      });
      const duplicate = registry.db.prepare(`
        SELECT id FROM entries
        WHERE id != ? AND url_canonical = ?
        ORDER BY id ASC LIMIT 1
      `).get(current.id, analyzed.url_canonical);
      if (duplicate) {
        throw new RegistryError("ENTRY_URL_CONFLICT", "Another Entry already uses this URL.", {
          entryId: Number(duplicate.id)
        });
      }
      assignments.push(
        "url_original = ?", "url_canonical = ?", "provider = ?", "source_domain = ?"
      );
      values.push(
        analyzed.url_original, analyzed.url_canonical, analyzed.provider, analyzed.source_domain
      );
      if (!Object.prototype.hasOwnProperty.call(changes, "kind") && current.kind_source !== "user") {
        assignments.push("kind = ?", "kind_source = 'derived'");
        values.push(analyzed.kind);
      }
    }
    if (Object.prototype.hasOwnProperty.call(changes, "title")) {
      const nextTitle = optionalText(changes.title, "title") ?? null;
      assignments.push("title = ?", "title_origin = ?");
      values.push(nextTitle, nextTitle === null ? "none" : "user");
    }
    if (Object.prototype.hasOwnProperty.call(changes, "kind")) {
      if (changes.kind === null) {
        const analyzed = analyzeUrl(changes.url ?? current.url_original);
        assignments.push("kind = ?", "kind_source = 'derived'");
        values.push(analyzed.kind);
      } else {
        assignments.push("kind = ?", "kind_source = 'user'");
        values.push(validateKind(changes.kind));
      }
    }
    if (Object.prototype.hasOwnProperty.call(changes, "typedMetadata")) {
      assignments.push("typed_metadata_json = ?");
      values.push(JSON.stringify(normalizeMetadata(changes.typedMetadata)));
    }
    if (Object.prototype.hasOwnProperty.call(changes, "publishedAt")) {
      assignments.push("published_at = ?");
      values.push(normalizeOptionalTimestamp(changes.publishedAt, "published_at"));
    }
    if (Object.prototype.hasOwnProperty.call(changes, "updatedAt")) {
      assignments.push("updated_at = ?");
      values.push(normalizeOptionalTimestamp(changes.updatedAt, "updated_at"));
    }
    if (Object.prototype.hasOwnProperty.call(changes, "contentFocus")) {
      assignments.push("content_focus = ?");
      values.push(normalizeContentFocus(changes.contentFocus));
    }
    if (Object.prototype.hasOwnProperty.call(changes, "folderId")) {
      assignments.push("folder_id = ?");
      values.push(normalizeFolderId(registry, changes.folderId));
    }

    const hasPolicyChange = ["visibility", "agentAccess", "aiProcessing"]
      .some((field) => Object.prototype.hasOwnProperty.call(changes, field));
    if (hasPolicyChange) {
      const policy = normalizePolicy({
        visibility: changes.visibility,
        agentAccess: changes.agentAccess,
        aiProcessing: changes.aiProcessing
      }, {
        defaults: {
          visibility: current.visibility,
          agentAccess: current.agent_access,
          aiProcessing: current.ai_processing
        },
        requireChange: true
      });
      assignments.push("visibility = ?", "agent_access = ?", "ai_processing = ?");
      values.push(policy.visibility, policy.agentAccess, policy.aiProcessing);
    }

    if (Object.prototype.hasOwnProperty.call(changes, "tags")) {
      if (!Array.isArray(changes.tags)) {
        throw new RegistryError("VALIDATION_ERROR", "tags must be an array.", { field: "tags" });
      }
      const tags = uniqueTags(changes.tags);
      const addedAt = nowIso(clock);
      registry.db.prepare("DELETE FROM entry_tags WHERE entry_id = ?").run(current.id);
      for (const tag of tags) {
        registry.db.prepare(`
          INSERT INTO tags (name, normalized_name, created_at)
          VALUES (?, ?, ?)
          ON CONFLICT(normalized_name) DO NOTHING
        `).run(tag.name, tag.normalizedName, addedAt);
        const row = registry.db.prepare("SELECT id FROM tags WHERE normalized_name = ?").get(tag.normalizedName);
        registry.db.prepare(`
          INSERT INTO entry_tags (entry_id, tag_id, added_at) VALUES (?, ?, ?)
        `).run(current.id, row.id, addedAt);
      }
      registry.db.prepare(`
        DELETE FROM tags
        WHERE NOT EXISTS (SELECT 1 FROM entry_tags WHERE tag_id = tags.id)
          AND NOT EXISTS (SELECT 1 FROM capture_policy_rule_tags WHERE tag_id = tags.id)
      `).run();
      hasRelationalChange = true;
    }

    if (!assignments.length && !hasRelationalChange) {
      throw new RegistryError("VALIDATION_ERROR", "No editable Entry fields were provided.");
    }
    assignments.push("record_updated_at = ?");
    values.push(nowIso(clock), current.id);
    registry.db.prepare(`UPDATE entries SET ${assignments.join(", ")} WHERE id = ?`).run(...values);
    const updated = getEntry(registry, current.id);
    const revisionChanges = buildEntryChanges(editableSnapshot(current), editableSnapshot(updated));
    if (!Object.keys(revisionChanges).length) {
      throw new RegistryError("VALIDATION_ERROR", "Entry edit did not change any values.");
    }
    recordEntryRevision(registry, current.id, "updated", revisionChanges, {
      actor,
      reason,
      clock
    });
    return updated;
  });
}

function setAiTitle(registry, id, title, options = {}) {
  return withTransaction(registry.db, () => {
    const current = getEntry(registry, id);
    const value = optionalText(title, "title", { maxLength: 120 });
    const bareUrl = current.url_original.replace(/^https?:\/\//i, "").replace(/\/$/, "");
    const urlPlaceholder = current.title?.trim().replace(/\/$/, "") === bareUrl;
    if (!value || (current.title && !urlPlaceholder) || current.visibility !== "normal" || current.agent_access !== "allowed"
      || !["manual", "enabled"].includes(current.ai_processing)
      || (options.expectedUrl && current.url_original !== options.expectedUrl)) {
      throw new RegistryError("AI_TITLE_CONFLICT", "Entry can no longer receive an AI title.");
    }
    registry.db.prepare("UPDATE entries SET title = ?, title_origin = 'ai', record_updated_at = ? WHERE id = ?")
      .run(value, nowIso(options.clock || Date), current.id);
    const updated = getEntry(registry, current.id);
    recordEntryRevision(registry, current.id, "updated",
      buildEntryChanges(editableSnapshot(current), editableSnapshot(updated)), {
        actor: { type: "agent", id: "ai-url-summary" }, clock: options.clock || Date,
        reason: "AI-authored title from bounded URL evidence."
      });
    return updated;
  });
}

function setEntryPolicy(registry, id, changes, options = {}) {
  return editEntry(registry, id, changes, options);
}

function archiveEntry(registry, id, options = {}) {
  return changeArchivedState(registry, id, true, options);
}

function restoreEntry(registry, id, options = {}) {
  return changeArchivedState(registry, id, false, options);
}

function changeArchivedState(registry, id, archive, options = {}) {
  return withTransaction(registry.db, () => {
    const { clock = Date, actor, reason } = options;
    const current = getEntry(registry, id, { includeArchived: true });
    if (archive === Boolean(current.deleted_at)) {
      throw new RegistryError("ENTRY_STATE_CONFLICT", archive
        ? "Entry is already archived."
        : "Entry is already active.");
    }
    if (!archive) {
      const conflict = registry.db.prepare(`
        SELECT id FROM entries WHERE id != ? AND deleted_at IS NULL AND url_canonical = ?
        ORDER BY id ASC LIMIT 1
      `).get(current.id, current.url_canonical);
      if (conflict) {
        throw new RegistryError("ENTRY_URL_CONFLICT", "Another active Entry already uses this URL.", {
          entryId: Number(conflict.id)
        });
      }
    }
    const deletedAt = archive ? nowIso(clock) : null;
    registry.db.prepare(`
      UPDATE entries SET deleted_at = ?, record_updated_at = ? WHERE id = ?
    `).run(deletedAt, nowIso(clock), current.id);
    const updated = getEntry(registry, current.id, { includeArchived: true });
    recordEntryRevision(
      registry,
      current.id,
      archive ? "archived" : "restored",
      buildEntryChanges(editableSnapshot(current), editableSnapshot(updated)),
      { actor, reason, clock }
    );
    return updated;
  });
}

function findEntryByCanonicalUrl(registry, urlCanonical) {
  return registry.db.prepare(`
    SELECT id, deleted_at FROM entries WHERE url_canonical = ? ORDER BY id ASC LIMIT 1
  `).get(urlCanonical) || null;
}

function normalizeOptionalTimestamp(value, field) {
  if (value === undefined) {
    return null;
  }
  return normalizeTimestamp(value, field, { optional: true });
}

function normalizeContentFocus(value) {
  const normalized = String(value || "").trim().toLocaleLowerCase("en-US");
  if (!CONTENT_FOCUS_VALUES.includes(normalized)) {
    throw new RegistryError("VALIDATION_ERROR", "content_focus has an unsupported value.", {
      field: "content_focus",
      value: normalized,
      allowed: CONTENT_FOCUS_VALUES
    });
  }
  return normalized;
}

function normalizeFolderId(registry, value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  return getFolder(registry, value).id;
}

function editableSnapshot(entry) {
  return {
    url: entry.url_original,
    title: entry.title,
    title_origin: entry.title_origin,
    kind: entry.kind,
    kind_source: entry.kind_source,
    typed_metadata: entry.typed_metadata,
    published_at: entry.published_at,
    updated_at: entry.updated_at,
    visibility: entry.visibility,
    agent_access: entry.agent_access,
    ai_processing: entry.ai_processing,
    folder_id: entry.folder_id,
    content_focus: entry.content_focus,
    deleted_at: entry.deleted_at,
    tags: entry.tags.map((tag) => tag.name)
  };
}

function normalizeCreationProvenance(value) {
  if (value === undefined) {
    return {
      createdVia: "cli",
      captureAdapter: null,
      captureRequestId: null,
      captureItemIndex: null
    };
  }
  const createdVia = String(value.createdVia || "").trim();
  if (!ENTRY_CREATION_CHANNELS.includes(createdVia) || createdVia === "legacy") {
    throw new RegistryError("INTERNAL_ERROR", "Entry creation provenance is invalid.");
  }
  const captureRequestId = value.captureRequestId === undefined || value.captureRequestId === null
    ? null
    : entryId(value.captureRequestId, "capture_request_id");
  const captureItemIndex = value.captureItemIndex === undefined || value.captureItemIndex === null
    ? null
    : Number(value.captureItemIndex);
  if ((captureRequestId === null) !== (captureItemIndex === null) ||
      (captureItemIndex !== null && (!Number.isSafeInteger(captureItemIndex) || captureItemIndex < 0))) {
    throw new RegistryError("INTERNAL_ERROR", "Entry capture provenance is incomplete.");
  }
  const captureAdapter = value.captureAdapter === undefined || value.captureAdapter === null
    ? null
    : optionalText(value.captureAdapter, "capture_adapter", { maxLength: 120 });
  return { createdVia, captureAdapter, captureRequestId, captureItemIndex };
}

function normalizeTitleOrigin(title, creation) {
  if (title === null) return "none";
  if (creation.captureAdapter === "current-tab") return "page";
  if (["pinterest-pin-grid", "x-media"].includes(creation.captureAdapter)) {
    return "capture_caption";
  }
  return creation.createdVia === "chrome" ? "page" : "user";
}

module.exports = {
  addEntry,
  archiveEntry,
  editEntry,
  findEntryByCanonicalUrl,
  getEntry,
  listEntryRevisions,
  listEntries,
  mapEntryRow,
  normalizeCreationProvenance,
  normalizeContentFocus,
  normalizeSort,
  restoreEntry,
  setAiTitle,
  setEntryPolicy
};
