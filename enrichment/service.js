"use strict";

const { createHash } = require("node:crypto");
const { RegistryError } = require("../registry/errors.js");
const { withTransaction } = require("../registry/database.js");
const { addEntry, editEntry, getEntry } = require("../registry/entries.js");
const { addComment } = require("../registry/comments.js");
const { addTags } = require("../registry/tags.js");
const { analyzeUrl } = require("../registry/url-policy.js");
const { resolveCapturePolicy } = require("../registry/capture-policy.js");
const { addRemoteImageReference, listVisualAssets } = require("../registry/visual-assets.js");
const { normalizeTimestamp } = require("../registry/values.js");
const { TEMPLATES, requireTemplate, matchTemplate } = require("./templates.js");
const { extractPage, normalizeFields, FIELD_KEYS } = require("./extract.js");
const { fetchPage } = require("./fetch-page.js");

const NOT_AVAILABLE = () => new RegistryError("ENRICH_NOT_AVAILABLE", "Entry is unavailable for this operation.");
function readable(entry) { return entry && !entry.deleted_at && entry.visibility === "normal" && ["metadata_only", "allowed"].includes(entry.agent_access); }
function enrichable(entry) { return readable(entry) && entry.agent_access === "allowed" && ["manual", "enabled"].includes(entry.ai_processing); }
function revisionKey(entry) {
  return createHash("sha256").update(JSON.stringify([entry.url_original, entry.url_canonical, entry.visibility, entry.agent_access, entry.ai_processing])).digest("hex");
}
function readEligible(registry, id, operation = "read", expected) {
  let entry;
  try { entry = getEntry(registry, id); } catch { throw NOT_AVAILABLE(); }
  if (!(operation === "read" ? readable(entry) : enrichable(entry))) throw NOT_AVAILABLE();
  if (expected && revisionKey(entry) !== expected) throw new RegistryError("ENRICH_ENTRY_CHANGED", "Entry URL or policy changed; select it again.");
  return entry;
}

// This is a projection, NOT a serialization of an Entry. Nested JSON, URLs,
// comments, folders, image references, history and counts are never copied.
function agentProjection(entry) {
  if (!readable(entry)) throw NOT_AVAILABLE();
  const enrichment = entry.typed_metadata?.enrichment;
  const fallbackTitle = enrichment?.schema_version === 1 && enrichment.source_url === entry.url_original && typeof enrichment.fields?.title?.value === "string" ? enrichment.fields.title.value.slice(0, 1000) : null;
  const output = { id: entry.id, title: entry.title || fallbackTitle, kind: entry.kind, saved_at: entry.saved_at, access: entry.agent_access };
  if (entry.agent_access === "allowed") {
    output.url = entry.url_original;
    const data = entry.typed_metadata?.enrichment;
    if (data?.schema_version === 1 && data.url_key === revisionUrlKey(entry)) {
      output.fields = Object.fromEntries(FIELD_KEYS.filter((k) => data.fields?.[k]).map((k) => [k, data.fields[k].value]));
      output.last_outcome = data.last_attempt?.status || null;
    }
  }
  return output;
}
function revisionUrlKey(entry) { return createHash("sha256").update(entry.url_original).digest("hex"); }

const RFC3339_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/i;
function normalizeAgentSavedFrom(value) {
  const text = String(value ?? "").trim();
  if (!RFC3339_TIMESTAMP.test(text)) throw new RegistryError("ENRICH_INVALID_FILTER", "saved_from must be an RFC3339 timestamp.");
  try {
    return normalizeTimestamp(text, "saved_from");
  } catch {
    throw new RegistryError("ENRICH_INVALID_FILTER", "saved_from must be an RFC3339 timestamp.");
  }
}

function agentList(registry, options = {}) {
  const { after = 0, limit = 50, note, enrichable } = options;
  const savedFrom = options.savedFrom !== undefined ? options.savedFrom : options.saved_from;
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RegistryError("ENRICH_INVALID_LIMIT", "Invalid page limits.");
  if (savedFrom !== undefined && options.savedFrom !== undefined && options.saved_from !== undefined) throw new RegistryError("ENRICH_INVALID_FILTER", "Use one saved_from filter.");
  const normalizedSavedFrom = savedFrom === undefined ? undefined : normalizeAgentSavedFrom(savedFrom);
  if (note !== undefined && note !== "empty") throw new RegistryError("ENRICH_INVALID_FILTER", "note must be empty.");
  if (enrichable !== undefined && typeof enrichable !== "boolean") throw new RegistryError("ENRICH_INVALID_FILTER", "enrichable must be true or false.");
  const where = ["deleted_at IS NULL", "visibility = 'normal'", "agent_access IN ('metadata_only', 'allowed')", "id > ?"];
  const params = [after];
  if (normalizedSavedFrom !== undefined) {
    where.push("saved_at >= ?");
    params.push(normalizedSavedFrom);
  }
  if (note === "empty") where.push("NOT EXISTS (SELECT 1 FROM entry_comments c WHERE c.entry_id = entries.id)");
  if (enrichable === true) {
    where.push("agent_access = 'allowed'", "ai_processing IN ('manual', 'enabled')");
  }
  const rows = registry.db.prepare(`SELECT id FROM entries WHERE ${where.join(" AND ")} ORDER BY id LIMIT ?`).all(...params, limit);
  const items = rows.map((r) => agentProjection(readEligible(registry, Number(r.id), enrichable === true ? "enrich" : "read")));
  return { items, next_after: items.length === limit ? items.at(-1).id : null };
}

function addAgentNote(registry, id, expected, text, options = {}) {
  if (typeof text !== "string") throw new RegistryError("ENRICH_INVALID_NOTE", "Note text must be a string.");
  return withTransaction(registry.db, () => {
    const entry = readEligible(registry, id, "enrich", expected);
    if (registry.db.prepare("SELECT 1 FROM entry_comments WHERE entry_id = ? LIMIT 1").get(entry.id)) {
      throw new RegistryError("ENRICH_NOTE_EXISTS", "Entry already has a comment.");
    }
    let comment;
    try {
      comment = addComment(registry, entry.id, text, options);
    } catch (error) {
      if (error?.code === "VALIDATION_ERROR") throw new RegistryError("ENRICH_INVALID_NOTE", "Note text is empty or too long.");
      throw error;
    }
    return { id: entry.id, body: comment.body, created_at: comment.created_at };
  });
}

function createFromUrl(registry, url, { allowNew = false } = {}) {
  const analyzed = analyzeUrl(url);
  const existing = registry.db.prepare("SELECT id FROM entries WHERE url_canonical = ? ORDER BY id LIMIT 1").get(analyzed.url_canonical);
  if (existing) return readEligible(registry, Number(existing.id), "enrich");
  requireTemplate(url);
  if (!allowNew) throw new RegistryError("ENRICH_NEW_URL_REQUIRES_CONSENT", "Save the card first, or explicitly use --allow-new for a new Normal/full-AI Entry.");
  const policy = resolveCapturePolicy(registry, url);
  // Explicitly supplied new links opt into Normal/full-AI only in the absence
  // of a matching user rule. A restrictive existing rule always wins.
  const chosen = policy.rule_id ? policy : { visibility: "normal", agentAccess: "allowed", aiProcessing: "enabled" };
  if (chosen.visibility !== "normal" || chosen.agentAccess !== "allowed" || !["manual", "enabled"].includes(chosen.aiProcessing)) throw NOT_AVAILABLE();
  return withTransaction(registry.db, () => {
    const entry = addEntry(registry, { url, ...chosen, kind: chosen.kind || requireTemplate(url).kind }).entry;
    if (policy.defaultTags.length) addTags(registry, entry.id, policy.defaultTags);
    return getEntry(registry, entry.id);
  });
}

function validatePlanOptions({ site, limit = 20, mode = "pending" } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RegistryError("ENRICH_INVALID_LIMIT", "Use a limit from 1 to 100.");
  if (!["pending", "retry", "refresh"].includes(mode)) throw new RegistryError("ENRICH_INVALID_MODE", "Mode must be pending, retry or refresh.");
  if (site && !TEMPLATES.some((t) => t.id === site)) throw new RegistryError("ENRICH_INVALID_SITE", "Unknown site.");
}

function planEntries(registry, { entryId, site, limit = 20, mode = "pending" } = {}) {
  validatePlanOptions({ site, limit, mode });
  const ids = entryId ? [{ id: Number(entryId) }] : registry.db.prepare("SELECT id FROM entries WHERE deleted_at IS NULL AND visibility='normal' AND agent_access='allowed' AND ai_processing IN ('manual','enabled') ORDER BY id").all();
  const items = [];
  for (const row of ids) {
    const entry = readEligible(registry, Number(row.id), "enrich");
    const template = matchTemplate(entry.url_original);
    if (!template) {
      if (entryId) requireTemplate(entry.url_original);
      continue;
    }
    if (site && template.id !== site) continue;
    const saved = entry.typed_metadata?.enrichment;
    const current = saved?.schema_version === 1 && saved.url_key === revisionUrlKey(entry) ? saved : null;
    const status = current?.last_attempt?.status;
    if (!entryId && mode === "pending" && current && current.template_version === template.version) continue;
    if (!entryId && mode === "retry" && !["partial", "failed"].includes(status)) continue;
    items.push({ id: entry.id, url: entry.url_original, site: template.id, category: template.category, previous_status: status || null });
    if (items.length >= limit) break;
  }
  return { items, mode, limit };
}

function applyExtraction(registry, id, expected, result, options = {}) {
  return withTransaction(registry.db, () => {
    const entry = readEligible(registry, id, "enrich", expected);
    const template = requireTemplate(entry.url_original);
    const now = options.now || new Date().toISOString();
    const old = entry.typed_metadata?.enrichment;
    const prior = old?.schema_version === 1 && old.url_key === revisionUrlKey(entry) ? old : null;
    const fields = { ...(prior?.fields || {}) };
    const values = normalizeFields(result.fields || {}, entry.url_original);
    const observed = result.observed_at || now;
    if (!Number.isFinite(Date.parse(observed)) || Date.parse(observed) > Date.parse(now) + 1000) throw new RegistryError("ENRICH_INVALID_FIELDS", "Invalid observation time.");
    if (Date.parse(prior?.last_attempt?.at) > Date.parse(observed)) throw new RegistryError("ENRICH_ENTRY_CHANGED", "A newer enrichment attempt exists; inspect the Entry again.");
    const successful = Object.keys(values);
    const status = result.error ? "failed" : successful.includes("title") ? ((result.missing?.length || result.warnings?.length) ? "partial" : "complete") : "failed";
    for (const [key, value] of Object.entries(values)) {
      fields[key] = { value, observed_at: observed, source: String(result.sources?.[key] || "manual").slice(0, 120), stale: false };
    }
    for (const key of Object.keys(fields)) if (!successful.includes(key)) fields[key] = { ...fields[key], stale: true };
    const data = {
      schema_version: 1, url_key: revisionUrlKey(entry), source_url: entry.url_original,
      template_id: template.id, template_version: template.version, category: template.category,
      fields, last_attempt: { at: now, status, code: result.error || (status === "failed" ? "ENRICH_NO_DATA" : null),
        missing: FIELD_KEYS.filter((k) => result.missing?.includes(k)), warnings: (result.warnings || []).slice(0, 12).map((v) => String(v).slice(0, 100)) }
    };
    if (prior?.managed_asset_id) data.managed_asset_id = prior.managed_asset_id;
    // First preview only. Refresh does not replace user covers, resurrect removed
    // images, or accumulate a new asset on every rotating CDN URL.
    if (values.image_url && !prior?.managed_asset_id && !entry.cover_image && !listVisualAssets(registry, id).length) {
      data.managed_asset_id = addRemoteImageReference(registry, id, values.image_url, { sourceKind: "provider_thumbnail" }).asset.id;
    }
    data.category_applied = prior?.category_applied === true;
    if (!data.category_applied && values.title) {
      addTags(registry, id, [template.category]);
      data.category_applied = true;
    }
    const valueChanged = JSON.stringify(prior?.fields && Object.fromEntries(Object.entries(prior.fields).map(([k, v]) => [k, [v.value, v.stale]]))) !== JSON.stringify(Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, [v.value, v.stale]])));
    // Merge against the CURRENT row inside the transaction; never write a stale
    // whole-metadata snapshot captured before the network request.
    if (JSON.stringify(old) !== JSON.stringify(data)) editEntry(registry, id, { typedMetadata: { ...entry.typed_metadata, enrichment: data } }, { actor: { type: "system", id: "entry-enrichment" }, reason: "Bounded link enrichment." });
    return { id: entry.id, status, outcome: valueChanged ? "updated" : "unchanged", code: data.last_attempt.code, fields: successful, missing: data.last_attempt.missing };
  });
}

async function inspectEntry(registry, id, options = {}) {
  const entry = readEligible(registry, id, "enrich");
  const key = revisionKey(entry);
  const page = await (options.fetchPage || fetchPage)(entry.url_original, { ...options, beforeRequest: () => readEligible(registry, id, "enrich", key) });
  readEligible(registry, id, "enrich", key);
  return { ...page, id: entry.id, expected: key, observed_at: options.now || new Date().toISOString() };
}

async function enrichEntry(registry, id, options = {}) {
  const entry = readEligible(registry, id, "enrich"), key = revisionKey(entry);
  requireTemplate(entry.url_original);
  try {
    const page = await inspectEntry(registry, id, options);
    const result = extractPage(page.html, page.url);
    return applyExtraction(registry, id, key, { ...result, observed_at: page.observed_at }, options);
  } catch (error) {
    if (["ENRICH_NOT_AVAILABLE", "ENRICH_ENTRY_CHANGED"].includes(error?.code)) throw error;
    const code = error instanceof RegistryError && /^ENRICH_/.test(error.code) ? error.code : "ENRICH_INTERNAL";
    return applyExtraction(registry, id, key, { fields: {}, error: code }, options);
  }
}

async function runEntries(registry, options = {}) {
  const plan = planEntries(registry, options), results = [], paused = new Set();
  for (const item of plan.items) {
    if (paused.has(item.site)) { results.push({ id: item.id, status: "deferred", code: "ENRICH_SITE_PAUSED" }); continue; }
    try {
      const result = await enrichEntry(registry, item.id, options);
      results.push(result);
      if (["ENRICH_RATE_LIMITED", "ENRICH_ACCESS_REQUIRED"].includes(result.code)) paused.add(item.site);
    } catch (error) {
      results.push({ status: "skipped", code: ["ENRICH_NOT_AVAILABLE", "ENRICH_ENTRY_CHANGED"].includes(error?.code) ? error.code : "ENRICH_INTERNAL" });
    }
  }
  return { results, partial: results.some((r) => !["complete"].includes(r.status)) };
}

module.exports = { addAgentNote, agentList, agentProjection, applyExtraction, createFromUrl, enrichEntry, enrichable, inspectEntry, normalizeAgentSavedFrom, planEntries, readEligible, readable, revisionKey, revisionUrlKey, runEntries, validatePlanOptions };
