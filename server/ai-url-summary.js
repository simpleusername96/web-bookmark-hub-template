"use strict";

const fs = require("node:fs/promises");
const { createReadStream } = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const { performance } = require("node:perf_hooks");

const { addAgentNote, readEligible, revisionKey } = require("../enrichment/service.js");
const { setAiTitle } = require("../registry/entries.js");
const { fetchPublicEvidence } = require("../enrichment/public-evidence.js");
const { renderPdfFirstPage } = require("../enrichment/pdf-first-page.js");
const { SUMMARY_MODEL, SUMMARY_REASONING_EFFORT } = require("../registry/constants.js");
const { RegistryError } = require("../registry/errors.js");
const { withTransaction } = require("../registry/database.js");
const { createSummaryJob, completeSummaryJob } = require("../registry/summaries.js");
const { startSummaryAttempt, finishSummaryAttempt } = require("../registry/ai-summary-attempts.js");
const { listVisualAssets, addLocalImage } = require("../registry/visual-assets.js");
const { downloadImageToStaging } = require("./remote-image-downloader.js");

const MODEL_TIMEOUT_MS = 5 * 60 * 1000;
const ELIGIBLE_WHERE = `deleted_at IS NULL AND visibility = 'normal'
  AND agent_access = 'allowed' AND ai_processing IN ('manual', 'enabled')`;
const NO_SUMMARY_WHERE = `NOT EXISTS (SELECT 1 FROM summaries s WHERE s.entry_id = entries.id)`;
const PENDING_WHERE = `${ELIGIBLE_WHERE} AND ${NO_SUMMARY_WHERE}
  AND NOT EXISTS (SELECT 1 FROM ai_summary_attempts a WHERE a.entry_id = entries.id)`;

function pendingIds(registry) {
  return registry.db.prepare(`SELECT id FROM entries WHERE ${PENDING_WHERE} ORDER BY id`)
    .all().map((row) => Number(row.id));
}

function isPendingId(registry, id) {
  return Boolean(registry.db.prepare(`SELECT 1 FROM entries WHERE id = ? AND ${PENDING_WHERE}`).get(id));
}

function isEligibleId(registry, id, explicit) {
  const where = explicit ? ELIGIBLE_WHERE : `${ELIGIBLE_WHERE} AND ${NO_SUMMARY_WHERE}`;
  return Boolean(registry.db.prepare(`SELECT 1 FROM entries WHERE id = ? AND ${where}`).get(id));
}

function isMissingSummaryEligibleId(registry, id) {
  return Boolean(registry.db.prepare(`SELECT 1 FROM entries WHERE id = ? AND ${ELIGIBLE_WHERE} AND ${NO_SUMMARY_WHERE}`).get(id));
}

function createAiUrlSummaryService(options = {}) {
  const { registry } = options;
  if (!registry) throw new RegistryError("INTERNAL_ERROR", "AI URL summary service requires a Registry.");
  const repoRoot = path.resolve(options.repoRoot || path.join(__dirname, ".."));
  const dependencies = {
    addLocalImage: options.addLocalImage || addLocalImage,
    downloadImage: options.downloadImage || downloadImageToStaging,
    fetchEvidence: options.fetchEvidence || fetchPublicEvidence,
    renderPdfFirstPage: options.renderPdfFirstPage || renderPdfFirstPage,
    summarize: options.summarize || ((input, context) => runCodexSummary(input, {
      repoRoot,
      dataDir: registry.dataDir,
      entryId: context.entryId,
      imageFile: context.imageFile,
      redactInputOnFailure: context.redactInputOnFailure,
      spawnImpl: options.spawnImpl,
      timeoutMs: options.modelTimeoutMs
    })),
    writeReport: options.writeReport || writeRunReport
  };
  let activeRun = null;
  let lastRun = null;
  let progress = null;
  let queuedIds = [];
  let scheduledIds = new Set();
  let explicitIds = new Set();
  let activeEntryId = null;
  let entryContexts = new Map();

  function status() {
    const pending = pendingIds(registry);
    return {
      status: activeRun ? "running" : "idle",
      eligible_count: pending.length,
      available_count: pending.filter((id) => !scheduledIds.has(id)).length,
      queued_count: activeRun
        ? Math.max(queuedIds.length - progress.processed - (activeEntryId ? 1 : 0), 0)
        : 0,
      progress: progress ? { ...progress } : null,
      model: SUMMARY_MODEL,
      reasoning_effort: SUMMARY_REASONING_EFFORT,
      last_run: lastRun ? publicRun(lastRun) : null
    };
  }

  function start(runOptions = {}) {
    const candidates = chooseCandidates(registry, runOptions);
    if (activeRun) {
      if (runOptions.repairEntryIds?.length) throw busyError();
      const newlyQueued = enqueueCandidates(candidates, runOptions.entryIds !== undefined, runOptions);
      return { ...status(), newly_queued: newlyQueued };
    }
    if (!candidates.length) throw new RegistryError("AI_SUMMARY_NOTHING_ELIGIBLE", "No selected Normal URL needs a summary.");
    beginRun(runOptions, candidates);
    activeRun.then(
      async (run) => { lastRun = run; await cleanupRemainingContexts(); clearRun(); },
      async (error) => {
        lastRun = failedRun(error, options.clock);
        await cleanupRemainingContexts();
        clearRun();
      }
    );
    return { ...status(), newly_queued: candidates.length };
  }

  async function runNow(runOptions = {}) {
    if (activeRun) throw busyError();
    const candidates = chooseCandidates(registry, runOptions);
    beginRun(runOptions, candidates);
    try {
      lastRun = await activeRun;
      return lastRun;
    } catch (error) {
      lastRun = failedRun(error, options.clock);
      throw error;
    } finally {
      await cleanupRemainingContexts();
      clearRun();
    }
  }

  function enqueueCandidates(candidates, explicit, runOptions = {}) {
    let added = 0;
    for (const id of candidates) {
      if (explicit) explicitIds.add(id);
      if (scheduledIds.has(id)) continue;
      scheduledIds.add(id);
      queuedIds.push(id);
      const context = contextForEntry(runOptions, id);
      if (context) entryContexts.set(id, context);
      added += 1;
    }
    progress.total = queuedIds.length;
    return added;
  }

  function beginRun(runOptions, candidates) {
    queuedIds = [];
    scheduledIds = new Set();
    explicitIds = new Set();
    entryContexts = new Map();
    progress = { processed: 0, total: 0 };
    enqueueCandidates([...new Set(candidates)], runOptions.entryIds !== undefined, runOptions);
    activeRun = execute({ ...runOptions, candidates: queuedIds });
  }

  function clearRun() {
    activeRun = null;
    progress = null;
    queuedIds = [];
    scheduledIds = new Set();
    explicitIds = new Set();
    activeEntryId = null;
    entryContexts = new Map();
  }

  async function cleanupRemainingContexts() {
    const contexts = [...entryContexts.values()];
    entryContexts.clear();
    await Promise.allSettled(contexts.map((context) => Promise.resolve(context.cleanup?.())));
  }

  async function execute(runOptions) {
    const startedAt = nowIso(options.clock);
    const repairEntryIds = normalizeIds(runOptions.repairEntryIds);
    const candidates = runOptions.candidates;
    const items = [];
    for (const entryId of repairEntryIds) {
      items.push(await processEntry(registry, readEligible(registry, entryId, "enrich"), {
        ...dependencies,
        clock: options.clock,
        mediaOnly: true
      }));
    }
    let nextIndex = 0;
    while (true) {
      while (nextIndex < candidates.length) {
        const id = candidates[nextIndex++];
        activeEntryId = id;
        const explicit = explicitIds.has(id);
        const entryContext = entryContexts.get(id) || null;
        let attemptId = null;
        const metrics = { evidence_ms: null, media_ms: null, model_ms: null, usage: null };
        const started = performance.now();
        try {
          const eligible = entryContext?.requireMissingSummary
            ? isMissingSummaryEligibleId(registry, id)
            : explicit ? isEligibleId(registry, id, true) : isPendingId(registry, id);
          if (eligible) {
            attemptId = startSummaryAttempt(registry, id, options.clock);
            items.push(await processEntry(registry, readEligible(registry, id, "enrich"), {
              ...dependencies,
              clock: options.clock,
              mediaOnly: false,
              explicit,
              providedEvidence: entryContext?.verifiedEvidence
                || (runOptions.verifiedEvidence?.entry_id === id ? runOptions.verifiedEvidence : null),
              fallbackImageFile: entryContext?.fallbackImageFile || null,
              fallbackCapturedAt: entryContext?.capturedAt || null,
              requireMissingSummary: entryContext?.requireMissingSummary === true,
              redactInputOnFailure: entryContext?.redactInputOnFailure === true,
              metrics
            }));
          } else {
            items.push({ entry_id: id, mode: "summary", status: "skipped", errors: ["AI_SUMMARY_NO_LONGER_PENDING"] });
          }
        } catch (error) {
          items.push({ entry_id: id, mode: "summary", status: "failed", errors: [errorCode(error, "AI_ENTRY_FAILED")] });
        } finally {
          if (attemptId !== null) {
            metrics.total_ms = Math.round(performance.now() - started);
            finishSummaryAttempt(registry, attemptId, items.at(-1), metrics, options.clock);
          }
          entryContexts.delete(id);
          await Promise.resolve(entryContext?.cleanup?.()).catch(() => {});
        }
        if (progress) {
          progress.processed += 1;
        }
        activeEntryId = null;
      }
      const run = {
        started_at: startedAt,
        completed_at: nowIso(options.clock),
        requested_entries: candidates.length,
        repair_entries: repairEntryIds.length,
        counts: countOutcomes(items),
        items
      };
      run.report_file = await dependencies.writeReport(registry, run);
      if (nextIndex === candidates.length) return run;
    }
  }

  return { runNow, start, status };
}

function contextForEntry(runOptions, entryId) {
  if (runOptions.entryContext?.entryId === entryId) return runOptions.entryContext;
  if (runOptions.verifiedEvidence?.entry_id === entryId) {
    return { entryId, verifiedEvidence: runOptions.verifiedEvidence };
  }
  return null;
}

async function processEntry(registry, entry, options) {
  const expected = revisionKey(entry);
  const outcome = {
    entry_id: entry.id,
    url: entry.url_original,
    mode: options.mediaOnly ? "media_repair" : "summary",
    status: "failed",
    summary_applied: false,
    title_applied: false,
    visual_asset_id: null,
    media_kind: "none",
    errors: []
  };
  let evidence;
  const metrics = options.metrics || {};
  const evidenceStarted = performance.now();
  try {
    if (options.providedEvidence) {
      readEligible(registry, entry.id, "enrich", expected);
      if (options.providedEvidence.url !== entry.url_original) {
        throw new RegistryError("AI_EVIDENCE_ITEM_MISMATCH", "Verified evidence URL no longer matches the Entry.");
      }
      evidence = options.providedEvidence;
      outcome.evidence_source = "verified_page_context";
    } else {
      evidence = await options.fetchEvidence(entry.url_original, {
        beforeRequest: () => readEligible(registry, entry.id, "enrich", expected)
      });
      outcome.evidence_source = evidence.kind === "pdf" ? "pdf_first_page" : "public_html";
    }
    outcome.media_kind = evidence.media_kind;
    if (evidence.sufficient === false && !options.fallbackImageFile) {
      outcome.errors.push(evidence.reason || "AI_EVIDENCE_INSUFFICIENT");
    }
  } catch (error) {
    outcome.errors.push(errorCode(error, "AI_EVIDENCE_FAILED"));
    return outcome;
  } finally {
    metrics.evidence_ms = Math.round(performance.now() - evidenceStarted);
  }

  const assetsBefore = listVisualAssets(registry, entry.id);
  const hasLocalBefore = assetsBefore.some(isReadyLocalAsset);
  const remoteCover = assetsBefore.find((asset) => asset.is_cover && asset.storage_kind === "remote" && asset.source_url);
  const imageUrl = remoteCover?.source_url
    || evidence.image_url
    || assetsBefore.find((asset) => asset.source_url)?.source_url
    || null;
  if ((!hasLocalBefore || remoteCover) && imageUrl) {
    const mediaStarted = performance.now();
    let staged;
    try {
      staged = await options.downloadImage(registry, imageUrl);
      const attached = await options.addLocalImage(registry, entry.id, staged.filePath, {
        sourceKind: remoteCover?.source_kind || "provider_thumbnail",
        sourceUrl: staged.finalUrl || imageUrl,
        makeCover: Boolean(remoteCover),
        capturedAt: nowIso(options.clock),
        assertCurrent: () => readEligible(registry, entry.id, "enrich", expected)
      });
      outcome.visual_asset_id = attached.asset.id;
    } catch (error) {
      outcome.errors.push(errorCode(error, "AI_MEDIA_STORE_FAILED"));
    } finally {
      if (staged?.filePath) await fs.rm(staged.filePath, { force: true }).catch(() => {});
      metrics.media_ms = Math.round(performance.now() - mediaStarted);
    }
  } else if (!hasLocalBefore && options.fallbackImageFile) {
    const mediaStarted = performance.now();
    try {
      const attached = await options.addLocalImage(registry, entry.id, options.fallbackImageFile, {
        sourceKind: "page_snapshot",
        makeCover: true,
        capturedAt: options.fallbackCapturedAt || nowIso(options.clock),
        assertCurrent: () => readEligible(registry, entry.id, "enrich", expected)
      });
      outcome.visual_asset_id = attached.asset.id;
    } catch (error) {
      outcome.errors.push(errorCode(error, "AI_MEDIA_STORE_FAILED"));
    } finally {
      metrics.media_ms = Math.round(performance.now() - mediaStarted);
    }
  } else if (!hasLocalBefore && evidence.media_expected) {
    outcome.errors.push("AI_MEDIA_MISSING");
  }

  if (!options.mediaOnly && (evidence.sufficient !== false || options.fallbackImageFile)) {
    let pdfPage;
    try {
      if (!isProcessEligible(registry, entry.id, options)) {
        throw new RegistryError("AI_SUMMARY_NO_LONGER_PENDING", "Entry already has a summary or is no longer eligible.");
      }
      if (evidence.kind === "pdf") {
        const renderStarted = performance.now();
        try {
          pdfPage = await options.renderPdfFirstPage(evidence.pdf_bytes, registry.dataDir);
        } finally {
          metrics.media_ms = Math.round(performance.now() - renderStarted);
        }
      }
      const modelStarted = performance.now();
      let result;
      try {
        result = await options.summarize({
          url: entry.url_original,
          saved_title: entry.title || null,
          entry_kind: entry.kind,
          evidence_kind: evidence.kind || "generic",
          content_source: evidence.content_source || null,
          content: evidence.content || null,
          page_title: evidence.title,
          description: /(?:^|\.)pinterest\.[^/]+$/i.test(new URL(entry.url_original).hostname)
            ? null : evidence.description,
          media_kind: evidence.media_kind
        }, {
          entryId: entry.id,
          imageFile: pdfPage?.filePath || (evidence.sufficient === false ? options.fallbackImageFile : null),
          redactInputOnFailure: options.redactInputOnFailure
        });
      } finally {
        metrics.model_ms = Math.round(performance.now() - modelStarted);
      }
      metrics.usage = result.usage || null;
      outcome.session_record = result.session_record || null;
      withTransaction(registry.db, () => {
        if (!isProcessEligible(registry, entry.id, options)) {
          throw new RegistryError("AI_SUMMARY_NO_LONGER_PENDING", "Entry already has a summary or is no longer eligible.");
        }
        const current = readEligible(registry, entry.id, "enrich", expected);
        if (current.title !== entry.title) {
          throw new RegistryError("AI_SUMMARY_INPUT_CHANGED", "Entry title changed during summarization.");
        }
        const job = createSummaryJob(registry, entry.id, {
          requestedBy: "ai-url-summary", clock: options.clock || Date
        });
        completeSummaryJob(registry, job.id, result.summary, { clock: options.clock || Date });
        if (!registry.db.prepare("SELECT 1 FROM entry_comments WHERE entry_id = ? LIMIT 1").get(entry.id)) {
          addAgentNote(registry, entry.id, expected, result.summary, { clock: options.clock || Date });
        }
        if (canReceiveAiTitle(current) && result.title) {
          setAiTitle(registry, entry.id, result.title, {
            expectedUrl: entry.url_original, clock: options.clock || Date
          });
          outcome.title_applied = true;
        }
      });
      outcome.summary_applied = true;
    } catch (error) {
      outcome.title_applied = false;
      if (error?.details?.session_record) outcome.session_record = error.details.session_record;
      if (error?.details?.usage) metrics.usage = error.details.usage;
      outcome.errors.push(errorCode(error, "AI_MODEL_FAILED"));
    } finally {
      await pdfPage?.cleanup();
    }
  }

  const requiredSummaryDone = options.mediaOnly || outcome.summary_applied;
  const requiredMediaDone = !evidence.media_expected
    || Boolean(outcome.visual_asset_id)
    || listVisualAssets(registry, entry.id).some(isReadyLocalAsset);
  const requiredTitleDone = options.mediaOnly || Boolean(!canReceiveAiTitle(entry) || outcome.title_applied);
  outcome.status = requiredSummaryDone && requiredMediaDone && requiredTitleDone && outcome.errors.length === 0
    ? "complete"
    : (outcome.summary_applied || outcome.visual_asset_id) ? "partial" : "failed";
  return outcome;
}

function isReadyLocalAsset(asset) {
  return asset.storage_kind === "local" && asset.status === "ready";
}

function isProcessEligible(registry, entryId, options) {
  return options.requireMissingSummary
    ? isMissingSummaryEligibleId(registry, entryId)
    : isEligibleId(registry, entryId, options.explicit);
}

function canReceiveAiTitle(entry) {
  if (!entry.title) return true;
  const bareUrl = entry.url_original.replace(/^https?:\/\//i, "").replace(/\/$/, "");
  return entry.title.trim().replace(/\/$/, "") === bareUrl;
}

async function runCodexSummary(input, options = {}) {
  const repoRoot = path.resolve(options.repoRoot || path.join(__dirname, ".."));
  const dataDir = path.resolve(options.dataDir || path.join(repoRoot, "data"));
  const sessionRecord = path.join("ai-summary-sessions", `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`);
  const sessionDir = path.join(dataDir, sessionRecord);
  await fs.mkdir(sessionDir, { recursive: true });
  const outputFile = path.join(sessionDir, "response.json");
  const eventsFile = path.join(sessionDir, "events.jsonl");
  const stderrFile = path.join(sessionDir, "stderr.log");
  const promptFile = path.join(repoRoot, "enrichment", "ai-summary-prompt.md");
  const schemaFile = path.join(repoRoot, "enrichment", "ai-summary-output.schema.json");
  const prompt = `${await fs.readFile(promptFile, "utf8")}\nEvidence JSON:\n${JSON.stringify(input)}\n`;
  await fs.writeFile(path.join(sessionDir, "prompt.txt"), prompt, { flag: "wx" });
  await fs.copyFile(schemaFile, path.join(sessionDir, "output.schema.json"));
  const codexArgs = [
    "exec",
    "-",
    "--ephemeral",
    "--json",
    "--ignore-user-config",
    "--sandbox", "read-only",
    "--model", SUMMARY_MODEL,
    "--config", `model_reasoning_effort=\"${SUMMARY_REASONING_EFFORT}\"`,
    "--output-schema", schemaFile,
    "--output-last-message", outputFile,
    "--color", "never",
    "--cd", repoRoot
  ];
  if (options.imageFile) codexArgs.push("--image", options.imageFile);
  const invocation = codexInvocation(codexArgs, options);
  const startedAt = new Date();
  let eventsHandle;
  let stderrHandle;
  let result;
  let failure;
  let usage;
  let durationMs;
  try {
    eventsHandle = await fs.open(eventsFile, "wx");
    stderrHandle = await fs.open(stderrFile, "wx");
    await spawnCodex(invocation.command, invocation.args, prompt, {
      spawnImpl: options.spawnImpl || spawn,
      timeoutMs: positiveInteger(options.timeoutMs, MODEL_TIMEOUT_MS),
      stdoutFd: eventsHandle.fd,
      stderrFd: stderrHandle.fd
    });
    const parsed = JSON.parse(await fs.readFile(outputFile, "utf8"));
    result = validateSummary(parsed);
  } catch (error) {
    failure = error instanceof RegistryError && error.code.startsWith("AI_MODEL_")
      ? error : new RegistryError("AI_MODEL_OUTPUT_INVALID", "Codex returned invalid summary JSON.");
  } finally {
    await eventsHandle?.close();
    await stderrHandle?.close();
    const completedAt = new Date();
    durationMs = completedAt - startedAt;
    usage = eventsHandle ? await readCodexUsage(eventsFile) : null;
    if (failure) {
      if (options.redactInputOnFailure) {
        await Promise.all([
          fs.rm(path.join(sessionDir, "prompt.txt"), { force: true }),
          fs.rm(outputFile, { force: true })
        ]);
      }
      await fs.writeFile(path.join(sessionDir, "session.json"), `${JSON.stringify({
        entry_id: options.entryId || null,
        model: SUMMARY_MODEL,
        reasoning_effort: SUMMARY_REASONING_EFFORT,
        started_at: startedAt.toISOString(),
        completed_at: completedAt.toISOString(),
        duration_ms: durationMs,
        status: "failed",
        error_code: failure.code,
        exit_code: failure.details?.exitCode ?? null,
        usage
      }, null, 2)}\n`, "utf8");
    } else {
      await fs.rm(sessionDir, { recursive: true });
    }
  }
  if (failure) {
    failure.details = { ...failure.details, session_record: sessionRecord, usage };
    throw failure;
  }
  return { ...result, usage };
}

async function readCodexUsage(eventsFile) {
  let usage = null;
  const lines = readline.createInterface({ input: createReadStream(eventsFile), crlfDelay: Infinity });
  for await (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event.type === "turn.completed" && event.usage) usage = event.usage;
    } catch { /* Keep the raw event line for later inspection. */ }
  }
  return usage;
}

function codexInvocation(args, options = {}) {
  if (options.command) return { command: options.command, args };
  if (process.platform !== "win32") return { command: "codex", args };
  const script = options.codexCliScript || path.join(
    path.dirname(process.execPath), "node_modules", "@openai", "codex", "bin", "codex.js"
  );
  return { command: process.execPath, args: [script, ...args] };
}

function spawnCodex(command, args, prompt, options) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = options.spawnImpl(command, args, {
        cwd: path.resolve(__dirname, ".."),
        env: process.env,
        stdio: ["pipe", options.stdoutFd, options.stderrFd],
        windowsHide: true
      });
    } catch {
      reject(new RegistryError("AI_MODEL_START_FAILED", "Codex CLI could not start."));
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      reject(new RegistryError("AI_MODEL_TIMEOUT", "Codex summary timed out."));
    }, options.timeoutMs);
    child.once("error", () => {
      clearTimeout(timer);
      reject(new RegistryError("AI_MODEL_START_FAILED", "Codex CLI could not start."));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new RegistryError("AI_MODEL_EXIT_FAILED", "Codex summary failed.", { exitCode: code }));
    });
    child.stdin.on("error", () => { /* Early CLI exit is reported through the close event. */ });
    child.stdin.end(prompt);
  });
}

function validateSummary(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "summary,title") {
    throw new RegistryError("AI_MODEL_OUTPUT_INVALID", "Codex summary output has invalid fields.");
  }
  const summary = String(value.summary || "").replace(/\s+/g, " ").trim();
  if (summary.length < 20 || summary.length > 240) {
    throw new RegistryError("AI_MODEL_OUTPUT_INVALID", "Codex summary length is invalid.");
  }
  const title = value.title === null ? null : typeof value.title === "string"
    ? value.title.replace(/\s+/g, " ").trim() : "";
  if (title !== null && (title.length < 3 || title.length > 120)) {
    throw new RegistryError("AI_MODEL_OUTPUT_INVALID", "Codex title length is invalid.");
  }
  return { title, summary };
}

async function writeRunReport(registry, run) {
  const directory = path.join(path.resolve(registry.dataDir), "enrichment-runs");
  await fs.mkdir(directory, { recursive: true });
  const filename = `${run.started_at.replace(/[:.]/g, "-")}-ai-url-summary.json`;
  await fs.writeFile(path.join(directory, filename), `${JSON.stringify(run, null, 2)}\n`, "utf8");
  return filename;
}

function publicRun(run) {
  return {
    started_at: run.started_at,
    completed_at: run.completed_at,
    requested_entries: run.requested_entries,
    repair_entries: run.repair_entries,
    counts: run.counts,
    report_file: run.report_file || null
  };
}

function failedRun(error, clock) {
  const now = nowIso(clock);
  return {
    started_at: now,
    completed_at: now,
    requested_entries: 0,
    repair_entries: 0,
    counts: { complete: 0, partial: 0, failed: 1 },
    report_file: null,
    error_code: errorCode(error, "AI_SUMMARY_INTERNAL")
  };
}

function countOutcomes(items) {
  const counts = { complete: 0, partial: 0, failed: 0 };
  for (const item of items) {
    if (item.status === "skipped") counts.skipped = (counts.skipped || 0) + 1;
    else counts[item.status] += 1;
  }
  return counts;
}

function chooseCandidates(registry, options = {}) {
  const selected = options.entryIds === undefined ? pendingIds(registry) : normalizeIds(options.entryIds);
  const allowed = new Set(options.entryIds === undefined ? selected
    : registry.db.prepare(`SELECT id FROM entries WHERE ${ELIGIBLE_WHERE}`).all().map((row) => Number(row.id)));
  const eligible = [...new Set(selected.filter((id) => allowed.has(id)))];
  if (options.limit === undefined) return eligible;
  const limit = Number(options.limit);
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RegistryError("AI_SUMMARY_LIMIT_INVALID", "Limit must be a positive integer.");
  }
  return eligible.slice(0, limit);
}

function normalizeIds(values) {
  if (values === undefined) return [];
  if (!Array.isArray(values)) throw new RegistryError("AI_SUMMARY_IDS_INVALID", "Entry IDs must be an array.");
  return values.map((value) => {
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id < 1) throw new RegistryError("AI_SUMMARY_IDS_INVALID", "Entry ID is invalid.");
    return id;
  });
}

function busyError() {
  return new RegistryError("AI_SUMMARY_BUSY", "An AI URL summary run is already active.");
}

function errorCode(error, fallback) {
  return typeof error?.code === "string" && error.code ? error.code : fallback;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nowIso(clock = Date) {
  const value = typeof clock?.now === "function" ? clock.now() : Date.now();
  return new Date(value).toISOString();
}

module.exports = {
  createAiUrlSummaryService,
  pendingIds,
  processEntry,
  runCodexSummary,
  validateSummary
};
