"use strict";

const { withTransaction } = require("./database.js");
const { editEntry, getEntry } = require("./entries.js");
const { RegistryError } = require("./errors.js");
const { normalizePolicy } = require("./privacy.js");
const {
  cleanupUnusedTags,
  listCaptureRuleTags,
  mergeTagNames,
  normalizeCaptureRuleTags,
  replaceCaptureRuleTags
} = require("./capture-rule-tags.js");
const { analyzeUrl, normalizeSourceDomain, validateKind } = require("./url-policy.js");
const { entryId, nowIso } = require("./values.js");

const SELECTED_IMAGE_STORAGE = Object.freeze(["reference_only", "local_copy"]);

function getCapturePolicy(registry) {
  const row = registry.db.prepare(`
    SELECT visibility, agent_access, ai_processing, selected_image_storage, created_at, updated_at
    FROM capture_policy_defaults WHERE id = 1
  `).get();
  return mapPolicy(row);
}

function updateCapturePolicy(registry, changes, { clock = Date } = {}) {
  const current = getCapturePolicy(registry);
  const hasPolicyChange = ["visibility", "agentAccess", "aiProcessing"]
    .some((field) => Object.prototype.hasOwnProperty.call(changes, field));
  const hasStorageChange = Object.prototype.hasOwnProperty.call(changes, "selectedImageStorage");
  if (!hasPolicyChange && !hasStorageChange) {
    throw new RegistryError("VALIDATION_ERROR", "At least one capture default is required.");
  }
  const policy = normalizePolicy(changes, { defaults: current });
  const selectedImageStorage = hasStorageChange
    ? normalizeSelectedImageStorage(changes.selectedImageStorage)
    : current.selected_image_storage;
  const updatedAt = nowIso(clock);
  registry.db.prepare(`
    UPDATE capture_policy_defaults
    SET visibility = ?, agent_access = ?, ai_processing = ?, selected_image_storage = ?, updated_at = ?
    WHERE id = 1
  `).run(policy.visibility, policy.agentAccess, policy.aiProcessing, selectedImageStorage, updatedAt);
  return getCapturePolicy(registry);
}

function initializeSelectedImageStorage(registry, value, { clock = Date } = {}) {
  const selectedImageStorage = normalizeSelectedImageStorage(value);
  registry.db.prepare(`
    UPDATE capture_policy_defaults
    SET selected_image_storage = ?, updated_at = ?
    WHERE id = 1 AND selected_image_storage IS NULL
  `).run(selectedImageStorage, nowIso(clock));
  return getCapturePolicy(registry);
}

function listCapturePolicyRules(registry) {
  return registry.db.prepare(`
    SELECT * FROM capture_policy_rules ORDER BY position ASC, id ASC
  `).all().map((row) => mapRule(registry, row));
}

function createCapturePolicyRule(registry, input, { clock = Date } = {}) {
  const scope = normalizeRuleScope(input);
  const policy = normalizePolicy(input);
  const kind = normalizeRuleKind(input.kind);
  const captureMode = normalizeCaptureMode(input.captureMode);
  const tags = normalizeCaptureRuleTags(input.tags) || [];
  const enabled = normalizeEnabled(input.enabled, true);
  const position = input.position === undefined
    ? Number(registry.db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS value FROM capture_policy_rules").get().value)
    : normalizePosition(input.position);
  const timestamp = nowIso(clock);
  try {
    return withTransaction(registry.db, () => {
      const result = registry.db.prepare(`
        INSERT INTO capture_policy_rules (
          hostname, path_prefix, kind, visibility, agent_access, ai_processing,
          enabled, position, created_at, updated_at, capture_mode
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        scope.hostname,
        scope.pathPrefix,
        kind,
        policy.visibility,
        policy.agentAccess,
        policy.aiProcessing,
        enabled ? 1 : 0,
        position,
        timestamp,
        timestamp,
        captureMode
      );
      const ruleId = Number(result.lastInsertRowid);
      replaceCaptureRuleTags(registry, ruleId, tags.map((tag) => tag.name), { clock });
      return getRule(registry, ruleId);
    });
  } catch (error) {
    if (String(error.message).includes("UNIQUE")) {
      throw new RegistryError("CAPTURE_POLICY_RULE_CONFLICT", "A rule already exists for this hostname, path and save method.");
    }
    throw error;
  }
}

function updateCapturePolicyRule(registry, id, changes, { clock = Date } = {}) {
  const current = getRule(registry, id);
  const scope = changes.urlPrefix !== undefined
    ? normalizeRuleScope({ urlPrefix: changes.urlPrefix })
    : normalizeRuleScope({
      hostname: changes.hostname ?? current.hostname,
      pathPrefix: changes.pathPrefix ?? current.path_prefix
    });
  const policy = normalizePolicy(changes, { defaults: current });
  const captureMode = normalizeCaptureMode(changes.captureMode === undefined ? current.capture_mode : changes.captureMode);
  const kind = Object.prototype.hasOwnProperty.call(changes, "kind")
    ? normalizeRuleKind(changes.kind)
    : current.kind;
  const tags = Object.prototype.hasOwnProperty.call(changes, "tags")
    ? normalizeCaptureRuleTags(changes.tags)
    : undefined;
  const enabled = Object.prototype.hasOwnProperty.call(changes, "enabled")
    ? normalizeEnabled(changes.enabled, current.enabled)
    : current.enabled;
  const position = Object.prototype.hasOwnProperty.call(changes, "position")
    ? normalizePosition(changes.position)
    : current.position;
  try {
    return withTransaction(registry.db, () => {
      registry.db.prepare(`
        UPDATE capture_policy_rules
        SET hostname = ?, path_prefix = ?, kind = ?, visibility = ?, agent_access = ?,
          ai_processing = ?, enabled = ?, position = ?, updated_at = ?, capture_mode = ?
        WHERE id = ?
      `).run(
        scope.hostname,
        scope.pathPrefix,
        kind,
        policy.visibility,
        policy.agentAccess,
        policy.aiProcessing,
        enabled ? 1 : 0,
        position,
        nowIso(clock),
        captureMode,
        current.id
      );
      if (tags !== undefined) {
        replaceCaptureRuleTags(registry, current.id, tags.map((tag) => tag.name), { clock });
      }
      return getRule(registry, current.id);
    });
  } catch (error) {
    if (String(error.message).includes("UNIQUE")) {
      throw new RegistryError("CAPTURE_POLICY_RULE_CONFLICT", "A rule already exists for this hostname, path and save method.");
    }
    throw error;
  }
}

function deleteCapturePolicyRule(registry, id) {
  return withTransaction(registry.db, () => {
    const current = getRule(registry, id);
    registry.db.prepare("DELETE FROM capture_policy_rules WHERE id = ?").run(current.id);
    cleanupUnusedTags(registry);
    return current;
  });
}

function resolveCapturePolicy(registry, url, explicit = {}, captureMode = "page") {
  const parsed = parsePolicyUrl(url);
  const rule = matchingRules(registry, parsed, normalizeCaptureMode(captureMode))[0] || null;
  const fallback = rule || getCapturePolicy(registry);
  const policy = normalizePolicy(explicit, { defaults: fallback });
  const explicitKind = explicit.kind === undefined || explicit.kind === null || explicit.kind === ""
    ? undefined
    : validateKind(explicit.kind);
  return {
    visibility: policy.visibility,
    agentAccess: policy.agentAccess,
    aiProcessing: policy.aiProcessing,
    source: hasExplicitPolicy(explicit) ? "explicit" : (rule ? "rule" : "default"),
    rule_id: rule?.id ?? null,
    kind: explicitKind ?? rule?.kind ?? undefined,
    kind_source: explicitKind !== undefined ? "explicit" : (rule?.kind ? "rule" : "derived"),
    defaultTags: rule ? rule.tags.map((tag) => tag.name) : []
  };
}

function previewCapturePolicyRule(registry, id) {
  const rule = getRule(registry, id);
  const rows = registry.db.prepare(`
    SELECT e.id, e.url_canonical,
      (EXISTS (SELECT 1 FROM entry_visual_assets a
        WHERE a.entry_id = e.id AND a.source_kind = 'browser_selected')
       OR EXISTS (SELECT 1 FROM capture_request_items ci JOIN capture_requests cr ON cr.id = ci.request_id
        WHERE ci.entry_id = e.id AND cr.adapter NOT IN ('current-tab', 'web-add-url')
          AND json_array_length(ci.details_json, '$.assets') > 0)) AS has_selected_images
    FROM entries e
    WHERE e.deleted_at IS NULL AND e.source_domain = ?
    ORDER BY id ASC
  `).all(rule.hostname);
  const entryIds = rows
    .filter((row) => ruleMatchesUrl(rule, parsePolicyUrl(row.url_canonical)) &&
      (rule.capture_mode === "all" || rule.capture_mode === (row.has_selected_images ? "selected_images" : "page")))
    .map((row) => Number(row.id));
  let wouldUpdateCount = 0;
  let tagUpdateCount = 0;
  for (const matchedEntryId of entryIds) {
    const current = getEntry(registry, matchedEntryId);
    const changes = entryChangesForRule(current, rule);
    if (Object.keys(changes).length) wouldUpdateCount += 1;
    if (Object.prototype.hasOwnProperty.call(changes, "tags")) tagUpdateCount += 1;
  }
  return {
    rule,
    entry_ids: entryIds,
    match_count: entryIds.length,
    would_update_count: wouldUpdateCount,
    tag_update_count: tagUpdateCount
  };
}

function applyCapturePolicyRule(registry, id, options = {}) {
  return withTransaction(registry.db, () => {
    const preview = previewCapturePolicyRule(registry, id);
    let updatedCount = 0;
    for (const matchedEntryId of preview.entry_ids) {
      const current = getEntry(registry, matchedEntryId);
      const changes = entryChangesForRule(current, preview.rule);
      if (!Object.keys(changes).length) continue;
      editEntry(registry, matchedEntryId, changes, {
        actor: options.actor,
        reason: options.reason || `Applied capture policy rule ${preview.rule.id}.`,
        clock: options.clock || Date
      });
      updatedCount += 1;
    }
    return {
      rule: preview.rule,
      updated_count: updatedCount,
      entry_ids: preview.entry_ids,
      match_count: preview.match_count,
      tag_update_count: preview.tag_update_count
    };
  });
}

function entryChangesForRule(current, rule) {
  const changes = {};
  if (current.visibility !== rule.visibility
      || current.agent_access !== rule.agent_access
      || current.ai_processing !== rule.ai_processing) {
    changes.visibility = rule.visibility;
    changes.agentAccess = rule.agent_access;
    changes.aiProcessing = rule.ai_processing;
  }
  if (rule.kind !== null && current.kind !== rule.kind) changes.kind = rule.kind;
  const currentNormalized = new Set((current.tags || []).map((tag) => tag.normalized_name));
  const missingTags = (rule.tags || []).filter((tag) => !currentNormalized.has(tag.normalized_name));
  if (missingTags.length) {
    changes.tags = mergeTagNames(
      (current.tags || []).map((tag) => tag.name),
      rule.tags.map((tag) => tag.name)
    );
  }
  return changes;
}

function matchingRules(registry, parsed, captureMode) {
  return listCapturePolicyRules(registry)
    .filter((rule) => rule.enabled && ruleMatchesUrl(rule, parsed) &&
      (rule.capture_mode === "all" || rule.capture_mode === captureMode))
    .sort((left, right) => right.path_prefix.length - left.path_prefix.length ||
      Number(left.capture_mode === "all") - Number(right.capture_mode === "all") || left.position - right.position || left.id - right.id);
}

function ruleMatchesUrl(rule, parsed) {
  return rule.hostname === parsed.hostname && pathMatches(parsed.pathname, rule.path_prefix);
}

function pathMatches(pathname, pathPrefix) {
  return pathPrefix === "/" || pathname === pathPrefix || pathname.startsWith(`${pathPrefix}/`);
}

function parsePolicyUrl(value) {
  const analyzed = analyzeUrl(value);
  const parsed = new URL(analyzed.url_original);
  return {
    hostname: normalizeSourceDomain(parsed.hostname),
    pathname: normalizePathPrefix(parsed.pathname)
  };
}

function normalizeRuleScope(input) {
  if (input.urlPrefix !== undefined) {
    const parsed = parsePolicyUrl(input.urlPrefix);
    return { hostname: parsed.hostname, pathPrefix: parsed.pathname };
  }
  const hostname = normalizeSourceDomain(input.hostname);
  if (!hostname || /[/?#:@]/u.test(hostname)) {
    throw new RegistryError("VALIDATION_ERROR", "hostname is invalid.", { field: "hostname" });
  }
  return { hostname, pathPrefix: normalizePathPrefix(input.pathPrefix) };
}

function normalizePathPrefix(value) {
  let pathPrefix = String(value || "/").trim();
  if (!pathPrefix.startsWith("/") || pathPrefix.includes("?") || pathPrefix.includes("#")) {
    throw new RegistryError("VALIDATION_ERROR", "path_prefix is invalid.", { field: "path_prefix" });
  }
  pathPrefix = pathPrefix.replace(/\/{2,}/gu, "/");
  if (pathPrefix.length > 1) pathPrefix = pathPrefix.replace(/\/+$/u, "");
  return pathPrefix || "/";
}

function getRule(registry, id) {
  const normalizedId = entryId(id, "capture_policy_rule_id");
  const row = registry.db.prepare("SELECT * FROM capture_policy_rules WHERE id = ?").get(normalizedId);
  if (!row) {
    throw new RegistryError("CAPTURE_POLICY_RULE_NOT_FOUND", "Capture policy rule not found.", {
      ruleId: normalizedId
    });
  }
  return mapRule(registry, row);
}

function mapPolicy(row) {
  return {
    visibility: row.visibility,
    agent_access: row.agent_access,
    ai_processing: row.ai_processing,
    selected_image_storage: row.selected_image_storage ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function mapRule(registry, row) {
  return {
    id: Number(row.id),
    hostname: row.hostname,
    path_prefix: row.path_prefix,
    capture_mode: row.capture_mode,
    kind: row.kind ?? null,
    tags: listCaptureRuleTags(registry, Number(row.id)),
    visibility: row.visibility,
    agent_access: row.agent_access,
    ai_processing: row.ai_processing,
    enabled: Boolean(row.enabled),
    position: Number(row.position),
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function normalizeEnabled(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new RegistryError("VALIDATION_ERROR", "enabled must be a boolean.", { field: "enabled" });
  }
  return value;
}

function normalizePosition(value) {
  const position = Number(value);
  if (!Number.isSafeInteger(position) || position < 0) {
    throw new RegistryError("VALIDATION_ERROR", "position must be a non-negative integer.", {
      field: "position"
    });
  }
  return position;
}

function normalizeCaptureMode(value = "all") {
  if (!["all", "page", "selected_images"].includes(value)) {
    throw new RegistryError("VALIDATION_ERROR", "Save method is invalid.", { field: "capture_mode" });
  }
  return value;
}

function normalizeRuleKind(value) {
  if (value === undefined || value === null || value === "") return null;
  return validateKind(String(value).trim().toLowerCase());
}

function normalizeSelectedImageStorage(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!SELECTED_IMAGE_STORAGE.includes(normalized)) {
    throw new RegistryError("VALIDATION_ERROR", "selected_image_storage has an unsupported value.", {
      field: "selected_image_storage",
      value,
      allowed: SELECTED_IMAGE_STORAGE
    });
  }
  return normalized;
}

function hasExplicitPolicy(input) {
  return ["visibility", "agentAccess", "aiProcessing"]
    .some((field) => input[field] !== undefined);
}

module.exports = {
  applyCapturePolicyRule,
  createCapturePolicyRule,
  deleteCapturePolicyRule,
  getCapturePolicy,
  initializeSelectedImageStorage,
  listCapturePolicyRules,
  pathMatches,
  previewCapturePolicyRule,
  resolveCapturePolicy,
  ruleMatchesUrl,
  updateCapturePolicy,
  updateCapturePolicyRule
};
