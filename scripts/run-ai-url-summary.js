#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const { openRegistry } = require("../registry/database.js");
const { createAiUrlSummaryService } = require("../server/ai-url-summary.js");
const { routeEvidence } = require("../enrichment/evidence-route.js");
const { listVisualAssets } = require("../registry/visual-assets.js");

async function main(argv = process.argv.slice(2), streams = {}) {
  const output = streams.stdout || process.stdout;
  const errorOutput = streams.stderr || process.stderr;
  const options = parseArgs(argv);
  const registry = openRegistry({ dbPath: options.dbPath, env: streams.env || process.env });
  try {
    const service = createAiUrlSummaryService({ registry });
    const verifiedEvidence = options.evidenceFile
      ? loadVerifiedEvidence(registry, options.entryId, options.evidenceFile) : null;
    const result = await service.runNow({
      limit: options.limit,
      repairEntryIds: options.repairEntryIds,
      entryIds: options.entryId ? [options.entryId]
        : options.repairEntryIds.length && options.limit === undefined ? [] : undefined,
      verifiedEvidence
    });
    output.write(`${JSON.stringify({ ok: true, data: result }, null, 2)}\n`);
    return result.counts.failed > 0 ? 2 : 0;
  } catch (error) {
    errorOutput.write(`${JSON.stringify({ ok: false, error: { code: error.code || "AI_SUMMARY_INTERNAL", message: error.message } }, null, 2)}\n`);
    return 1;
  } finally {
    registry.close();
  }
}

function parseArgs(argv) {
  const result = { dbPath: undefined, limit: undefined, repairEntryIds: [], entryId: undefined, evidenceFile: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!["--db", "--limit", "--repair-entry", "--entry", "--evidence-file"].includes(argument)) {
      throw new Error(`Unsupported option: ${argument}`);
    }
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
    if (argument === "--db") result.dbPath = value;
    if (argument === "--limit") result.limit = Number(value);
    if (argument === "--repair-entry") result.repairEntryIds.push(Number(value));
    if (argument === "--entry") result.entryId = Number(value);
    if (argument === "--evidence-file") result.evidenceFile = value;
  }
  if (result.entryId !== undefined && (!Number.isSafeInteger(result.entryId) || result.entryId < 1)) {
    throw new Error("--entry must be a positive Entry ID.");
  }
  if (result.evidenceFile && !result.entryId) throw new Error("--evidence-file requires --entry.");
  if (result.entryId && (result.limit !== undefined || result.repairEntryIds.length)) {
    throw new Error("--entry cannot be combined with --limit or --repair-entry.");
  }
  return result;
}

function loadVerifiedEvidence(registry, entryId, filePath) {
  const entry = registry.db.prepare(`
    SELECT url_original FROM entries WHERE id = ? AND deleted_at IS NULL
      AND visibility = 'normal' AND agent_access = 'allowed'
      AND ai_processing IN ('manual', 'enabled')
  `).get(entryId);
  if (!entry) throw new Error("The selected Entry is not eligible for AI evidence.");
  if (fs.statSync(filePath).size > 16 * 1024) throw new Error("Verified evidence file is too large.");
  const source = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const keys = Object.keys(source).sort().join(",");
  if (keys !== "content,entry_id,media_kind,observed_at,page_title,url"
    || source.entry_id !== entryId || source.url !== entry.url_original
    || typeof source.observed_at !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(source.observed_at)
    || !Number.isFinite(Date.parse(source.observed_at))
    || !["none", "image", "video", "gif"].includes(source.media_kind)
    || (source.page_title !== null && (typeof source.page_title !== "string" || source.page_title.length > 1000))
    || (source.content !== null && (typeof source.content !== "string" || source.content.length > 3000))
    || !(source.page_title?.trim() || source.content?.trim())) {
    throw new Error("Verified evidence must identify this exact Entry and contain bounded page content.");
  }
  if (source.media_kind !== "none" && !listVisualAssets(registry, entryId).some((asset) =>
    asset.is_cover && asset.storage_kind === "local" && asset.status === "ready"
      && fs.existsSync(asset.file_path))) {
    throw new Error("Verified media evidence requires an existing ready local cover.");
  }
  return {
    entry_id: entryId, url: source.url, observed_at: source.observed_at,
    kind: routeEvidence(source.url).kind, content_source: "verified_page_context",
    title: source.page_title, content: source.content, description: null,
    sufficient: true, reason: null, image_url: null,
    media_kind: source.media_kind, media_expected: source.media_kind !== "none"
  };
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main, parseArgs, loadVerifiedEvidence };
