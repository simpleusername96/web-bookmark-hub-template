"use strict";

function startSummaryAttempt(registry, entryId, clock = Date) {
  const startedAt = new Date(clock.now()).toISOString();
  const result = registry.db.prepare(`
    INSERT INTO ai_summary_attempts (entry_id, source, started_at, status)
    VALUES (?, 'pipeline', ?, 'running')
  `).run(entryId, startedAt);
  return Number(result.lastInsertRowid);
}

function finishSummaryAttempt(registry, attemptId, outcome, metrics, clock = Date) {
  const usage = metrics.usage || {};
  registry.db.prepare(`
    UPDATE ai_summary_attempts
    SET completed_at = ?, status = ?, error_code = ?, total_ms = ?,
        evidence_ms = ?, media_ms = ?, model_ms = ?, input_tokens = ?,
        cached_input_tokens = ?, output_tokens = ?
    WHERE id = ? AND status = 'running'
  `).run(
    new Date(clock.now()).toISOString(), outcome.status, outcome.errors?.[0] || null,
    metrics.total_ms, metrics.evidence_ms, metrics.media_ms, metrics.model_ms,
    usage.input_tokens ?? null, usage.cached_input_tokens ?? null,
    usage.output_tokens ?? null, attemptId
  );
}

module.exports = { startSummaryAttempt, finishSummaryAttempt };
