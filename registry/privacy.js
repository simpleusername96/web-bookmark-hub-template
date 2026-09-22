const {
  AGENT_ACCESS_LEVELS,
  AI_PROCESSING_MODES,
  DEFAULT_POLICY,
  VISIBILITIES
} = require("./constants.js");
const { RegistryError } = require("./errors.js");

function normalizePolicy(input = {}, { defaults = DEFAULT_POLICY, requireChange = false } = {}) {
  const provided = ["visibility", "agentAccess", "aiProcessing"]
    .filter((field) => input[field] !== undefined);
  if (requireChange && !provided.length) {
    throw new RegistryError("VALIDATION_ERROR", "At least one policy value is required.");
  }

  const visibility = input.visibility ?? defaults.visibility;
  assertChoice(visibility, VISIBILITIES, "visibility");
  const policy = policyForVisibility(visibility);
  validateLegacyMirror(input, "agentAccess", "agent_access", AGENT_ACCESS_LEVELS);
  validateLegacyMirror(input, "aiProcessing", "ai_processing", AI_PROCESSING_MODES);
  return policy;
}

function policyForVisibility(visibility) {
  assertChoice(visibility, VISIBILITIES, "visibility");
  return visibility === "normal"
    ? { visibility, agentAccess: "allowed", aiProcessing: "enabled" }
    : { visibility, agentAccess: "blocked", aiProcessing: "disabled" };
}

function validateLegacyMirror(input, property, field, allowed) {
  if (input[property] === undefined) return;
  assertChoice(input[property], allowed, field);
}

function assertSummaryEligible(entry) {
  if (entry.visibility === "private") {
    throw new RegistryError(
      "SUMMARY_PRIVATE_ENTRY",
      "Private entries cannot be included in an AI summary payload.",
      { entryId: entry.id }
    );
  }
  if (entry.agent_access === "blocked" || entry.agentAccess === "blocked") {
    throw new RegistryError(
      "AGENT_ACCESS_BLOCKED",
      "This entry blocks all agent payload access.",
      { entryId: entry.id }
    );
  }
  if (entry.ai_processing === "disabled" || entry.aiProcessing === "disabled") {
    throw new RegistryError(
      "AI_PROCESSING_DISABLED",
      "AI processing is disabled for this entry.",
      { entryId: entry.id }
    );
  }
}

function buildSummaryPayload({ entry, tags = [], comments = [] }) {
  // Eligibility is deliberately checked before a payload object exists.
  assertSummaryEligible(entry);

  const payload = {
    schema_version: 1,
    purpose: "entry_summary",
    entry: {
      id: entry.id,
      url_original: entry.url_original,
      url_canonical: entry.url_canonical,
      title: entry.title,
      kind: entry.kind,
      provider: entry.provider,
      source_domain: entry.source_domain,
      typed_metadata: entry.typed_metadata || {},
      saved_at: entry.saved_at,
      published_at: entry.published_at,
      updated_at: entry.updated_at,
      tags: tags.map((tag) => tag.name)
    }
  };

  const agentAccess = entry.agent_access || entry.agentAccess;
  if (agentAccess === "allowed") {
    payload.comments = comments.map((comment) => ({
      body: comment.body,
      created_at: comment.created_at
    }));
  }

  return payload;
}

function collectPayloadFields(value, prefix = "") {
  const fields = [];
  if (Array.isArray(value)) {
    if (prefix) {
      fields.push(prefix);
    }
    return fields;
  }
  if (!value || typeof value !== "object") {
    if (prefix) {
      fields.push(prefix);
    }
    return fields;
  }
  for (const [key, child] of Object.entries(value)) {
    const childPrefix = prefix ? `${prefix}.${key}` : key;
    fields.push(...collectPayloadFields(child, childPrefix));
  }
  return Array.from(new Set(fields)).sort();
}

function assertChoice(value, allowed, field) {
  if (!allowed.includes(value)) {
    throw new RegistryError("VALIDATION_ERROR", `${field} has an unsupported value.`, {
      field,
      value,
      allowed
    });
  }
}

module.exports = {
  assertSummaryEligible,
  buildSummaryPayload,
  collectPayloadFields,
  normalizePolicy,
  policyForVisibility
};
