const { createHash } = require("node:crypto");

const {
  SUMMARY_MODEL,
  SUMMARY_REASONING_EFFORT
} = require("./constants.js");
const { RegistryError } = require("./errors.js");
const { withTransaction } = require("./database.js");
const { getEntry } = require("./entries.js");
const {
  assertSummaryEligible,
  buildSummaryPayload,
  collectPayloadFields
} = require("./privacy.js");
const {
  entryId,
  normalizePagination,
  nowIso,
  parseStoredJson,
  requireText
} = require("./values.js");

const JOB_STATUSES = Object.freeze(["queued", "running", "completed", "failed", "cancelled"]);

function prepareSummaryPayload(registry, entryIdValue) {
  const entry = getEntry(registry, entryIdValue);
  assertSummaryEligible(entry);

  const comments = entry.agent_access === "allowed"
    ? registry.db.prepare(`
        SELECT body, created_at
        FROM entry_comments
        WHERE entry_id = ?
        ORDER BY created_at ASC, id ASC
      `).all(entry.id).map((row) => ({ body: row.body, created_at: row.created_at }))
    : [];

  return buildSummaryPayload({
    entry,
    tags: entry.tags,
    comments
  });
}

function createSummaryJob(registry, entryIdValue, options = {}) {
  return withTransaction(registry.db, () => {
    const payload = prepareSummaryPayload(registry, entryIdValue);
    const payloadJson = JSON.stringify(payload);
    const inputSha256 = createHash("sha256").update(payloadJson).digest("hex");
    const inputFields = collectPayloadFields(payload);
    const entry = getEntry(registry, payload.entry.id);
    const requestedAt = nowIso(options.clock || Date);
    const requestedBy = requireText(options.requestedBy || "registry-cli", "requested_by", {
      maxLength: 120
    });
    const policySnapshot = {
      visibility: entry.visibility,
      agent_access: entry.agent_access,
      ai_processing: entry.ai_processing
    };

    const result = registry.db.prepare(`
      INSERT INTO summary_jobs (
        entry_id, status, model, reasoning_effort, input_sha256, input_fields_json,
        policy_snapshot_json, requested_by, requested_at, completed_at, failure_code
      ) VALUES (?, 'queued', ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
    `).run(
      entry.id,
      SUMMARY_MODEL,
      SUMMARY_REASONING_EFFORT,
      inputSha256,
      JSON.stringify(inputFields),
      JSON.stringify(policySnapshot),
      requestedBy,
      requestedAt
    );

    return getSummaryJob(registry, Number(result.lastInsertRowid));
  });
}

function completeSummaryJob(registry, jobIdValue, summaryText, options = {}) {
  return withTransaction(registry.db, () => {
    const job = getSummaryJob(registry, jobIdValue);
    if (job.status !== "queued" && job.status !== "running") {
      throw new RegistryError("SUMMARY_JOB_NOT_PENDING", "Summary job is no longer pending.");
    }
    const currentHash = createHash("sha256")
      .update(JSON.stringify(prepareSummaryPayload(registry, job.entry_id))).digest("hex");
    if (currentHash !== job.input_sha256) {
      throw new RegistryError("SUMMARY_INPUT_CHANGED", "Summary input changed before completion.");
    }
    const text = requireText(summaryText, "summary", { maxLength: 240 });
    const completedAt = nowIso(options.clock || Date);
    const result = registry.db.prepare(`
      INSERT INTO summaries (entry_id, job_id, summary_text, model, reasoning_effort, input_sha256, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(job.entry_id, job.id, text, job.model, job.reasoning_effort, job.input_sha256, completedAt);
    registry.db.prepare(`
      UPDATE summary_jobs SET status = 'completed', completed_at = ? WHERE id = ?
    `).run(completedAt, job.id);
    return { id: Number(result.lastInsertRowid), entry_id: job.entry_id, text, job_id: job.id };
  });
}

function listSummaryJobs(registry, filters = {}) {
  const pagination = normalizePagination(filters);
  const where = [];
  const params = [];
  if (filters.entryId !== undefined) {
    where.push("entry_id = ?");
    params.push(entryId(filters.entryId));
  }
  if (filters.status !== undefined) {
    if (!JOB_STATUSES.includes(filters.status)) {
      throw new RegistryError("VALIDATION_ERROR", "status has an unsupported value.", {
        field: "status",
        value: filters.status,
        allowed: JOB_STATUSES
      });
    }
    where.push("status = ?");
    params.push(filters.status);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = Number(registry.db.prepare(`
    SELECT COUNT(*) AS count FROM summary_jobs ${whereSql}
  `).get(...params).count);
  const items = registry.db.prepare(`
    SELECT * FROM summary_jobs
    ${whereSql}
    ORDER BY requested_at DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(...params, pagination.pageSize, pagination.offset).map(mapSummaryJobRow);
  return {
    items,
    page: pagination.page,
    page_size: pagination.pageSize,
    total,
    total_pages: Math.ceil(total / pagination.pageSize)
  };
}

function getSummaryJob(registry, jobIdValue) {
  const id = entryId(jobIdValue, "summary_job_id");
  const row = registry.db.prepare("SELECT * FROM summary_jobs WHERE id = ?").get(id);
  if (!row) {
    throw new RegistryError("SUMMARY_JOB_NOT_FOUND", "Summary job not found.", {
      summaryJobId: id
    });
  }
  return mapSummaryJobRow(row);
}

function mapSummaryJobRow(row) {
  return {
    id: Number(row.id),
    entry_id: Number(row.entry_id),
    status: row.status,
    model: row.model,
    reasoning_effort: row.reasoning_effort,
    input_sha256: row.input_sha256,
    input_fields: parseStoredJson(row.input_fields_json, []),
    policy_snapshot: parseStoredJson(row.policy_snapshot_json, {}),
    requested_by: row.requested_by,
    requested_at: row.requested_at,
    completed_at: row.completed_at,
    failure_code: row.failure_code
  };
}

module.exports = {
  JOB_STATUSES,
  createSummaryJob,
  completeSummaryJob,
  getSummaryJob,
  listSummaryJobs,
  prepareSummaryPayload
};
