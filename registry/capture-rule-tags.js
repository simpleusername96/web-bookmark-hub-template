"use strict";

const { RegistryError } = require("./errors.js");
const { uniqueTags } = require("./tags.js");
const { entryId, nowIso } = require("./values.js");

const MAX_CAPTURE_RULE_TAGS = 20;

function normalizeCaptureRuleTags(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new RegistryError("VALIDATION_ERROR", "Capture rule tags must be an array.", {
      field: "tags"
    });
  }
  if (value.length > MAX_CAPTURE_RULE_TAGS) {
    throw new RegistryError("VALIDATION_ERROR", "Capture rule has too many tags.", {
      field: "tags",
      max: MAX_CAPTURE_RULE_TAGS
    });
  }
  return uniqueTags(value);
}

function listCaptureRuleTags(registry, ruleIdValue) {
  const ruleId = ensureRule(registry, ruleIdValue);
  return registry.db.prepare(`
    SELECT t.id, t.name, t.normalized_name, rt.position
    FROM capture_policy_rule_tags rt
    JOIN tags t ON t.id = rt.tag_id
    WHERE rt.rule_id = ?
    ORDER BY rt.position ASC, t.normalized_name ASC, t.id ASC
  `).all(ruleId).map((row) => ({
    id: Number(row.id),
    name: row.name,
    normalized_name: row.normalized_name,
    position: Number(row.position)
  }));
}

function replaceCaptureRuleTags(registry, ruleIdValue, value, { clock = Date } = {}) {
  const ruleId = ensureRule(registry, ruleIdValue);
  const tags = normalizeCaptureRuleTags(value) || [];
  const timestamp = nowIso(clock);
  registry.db.prepare("DELETE FROM capture_policy_rule_tags WHERE rule_id = ?").run(ruleId);
  tags.forEach((tag, position) => {
    registry.db.prepare(`
      INSERT INTO tags (name, normalized_name, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(normalized_name) DO NOTHING
    `).run(tag.name, tag.normalizedName, timestamp);
    const stored = registry.db.prepare("SELECT id FROM tags WHERE normalized_name = ?").get(tag.normalizedName);
    registry.db.prepare(`
      INSERT INTO capture_policy_rule_tags (rule_id, tag_id, position)
      VALUES (?, ?, ?)
    `).run(ruleId, stored.id, position);
  });
  cleanupUnusedTags(registry);
  return listCaptureRuleTags(registry, ruleId);
}

function mergeTagNames(...groups) {
  return uniqueTags(groups.flat().filter((value) => value !== undefined && value !== null))
    .map((tag) => tag.name);
}

function cleanupUnusedTags(registry) {
  registry.db.prepare(`
    DELETE FROM tags
    WHERE NOT EXISTS (SELECT 1 FROM entry_tags et WHERE et.tag_id = tags.id)
      AND NOT EXISTS (SELECT 1 FROM capture_policy_rule_tags rt WHERE rt.tag_id = tags.id)
  `).run();
}

function ensureRule(registry, value) {
  const id = entryId(value, "capture_policy_rule_id");
  if (!registry.db.prepare("SELECT 1 FROM capture_policy_rules WHERE id = ?").get(id)) {
    throw new RegistryError("CAPTURE_POLICY_RULE_NOT_FOUND", "Capture policy rule not found.", {
      ruleId: id
    });
  }
  return id;
}

module.exports = {
  MAX_CAPTURE_RULE_TAGS,
  cleanupUnusedTags,
  listCaptureRuleTags,
  mergeTagNames,
  normalizeCaptureRuleTags,
  replaceCaptureRuleTags
};
