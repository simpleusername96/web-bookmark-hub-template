"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const { extractPublicEvidence } = require("../enrichment/public-evidence.js");
const { getEntry } = require("../registry/entries.js");
const { RegistryError } = require("../registry/errors.js");

const MAX_HTML_BYTES = 768 * 1024;
const MAX_SCREENSHOT_BYTES = 3 * 1024 * 1024;
const STALE_AFTER_MS = 60 * 60 * 1000;
const BODY_FIELDS = new Set(["url", "capturedAt", "html", "screenshotDataUrl"]);

async function stageShortcutEvidence(registry, aiUrlSummary, entryIdValue, body, options = {}) {
  const entryId = positiveEntryId(entryIdValue);
  const entry = eligibleEntry(registry, entryId);
  const input = normalizeBody(body, entry);
  const stagingRoot = path.join(path.resolve(registry.dataDir), "shortcut-enrichment-staging");
  await sweepStaleStaging(stagingRoot, options.now?.() ?? Date.now());
  const stagingDirectory = path.join(stagingRoot, randomUUID());
  const htmlFile = path.join(stagingDirectory, "page.html");
  const screenshotFile = input.screenshot ? path.join(stagingDirectory, "viewport.jpg") : null;
  await fs.mkdir(stagingDirectory, { recursive: true });
  const cleanup = () => fs.rm(stagingDirectory, { recursive: true, force: true });
  try {
    await Promise.all([
      fs.writeFile(htmlFile, input.html, { encoding: "utf8", flag: "wx" }),
      screenshotFile ? fs.writeFile(screenshotFile, input.screenshot, { flag: "wx" }) : null
    ]);
    const evidence = {
      ...extractPublicEvidence(input.html, entry.url_original),
      entry_id: entry.id,
      url: entry.url_original,
      observed_at: input.capturedAt,
      content_source: "verified_page_context"
    };
    await fs.rm(htmlFile, { force: true });
    const fallbackImageFile = evidence.image_url ? null : screenshotFile;
    if (!fallbackImageFile && screenshotFile) await fs.rm(screenshotFile, { force: true });
    const context = {
      entryId: entry.id,
      verifiedEvidence: evidence,
      fallbackImageFile,
      capturedAt: input.capturedAt,
      requireMissingSummary: true,
      redactInputOnFailure: true,
      cleanup
    };
    const queued = aiUrlSummary.start({ entryIds: [entry.id], entryContext: context });
    if (!queued.newly_queued) await cleanup();
    return {
      queued: queued.status === "running",
      deduplicated: queued.newly_queued === 0,
      screenshot_fallback: Boolean(fallbackImageFile)
    };
  } catch (error) {
    await cleanup().catch(() => {});
    throw error;
  }
}

function eligibleEntry(registry, entryId) {
  const entry = getEntry(registry, entryId, { includeArchived: true });
  const allowed = !entry.deleted_at && entry.visibility === "normal"
    && entry.agent_access === "allowed" && ["manual", "enabled"].includes(entry.ai_processing);
  if (!allowed) {
    throw new RegistryError("SHORTCUT_ENRICHMENT_POLICY_BLOCKED", "Entry policy does not allow shortcut enrichment.");
  }
  if (entry.latest_summary) {
    throw new RegistryError("SHORTCUT_ENRICHMENT_COMPLETE", "Entry already has an AI summary.");
  }
  return entry;
}

function normalizeBody(body, entry) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new RegistryError("SHORTCUT_EVIDENCE_INVALID", "Shortcut evidence body must be an object.");
  }
  for (const key of Object.keys(body)) {
    if (!BODY_FIELDS.has(key)) throw new RegistryError("SHORTCUT_EVIDENCE_FIELD_UNKNOWN", "Shortcut evidence contains an unknown field.");
  }
  let url;
  try { url = new URL(String(body.url || "")).href; }
  catch { throw new RegistryError("SHORTCUT_EVIDENCE_URL_INVALID", "Shortcut evidence URL is invalid."); }
  if (url !== entry.url_original) {
    throw new RegistryError("SHORTCUT_EVIDENCE_ITEM_MISMATCH", "Shortcut evidence URL no longer matches the Entry.");
  }
  const html = typeof body.html === "string" ? body.html : "";
  const htmlBytes = Buffer.byteLength(html);
  if (!htmlBytes || htmlBytes > MAX_HTML_BYTES) {
    throw new RegistryError("SHORTCUT_EVIDENCE_HTML_INVALID", "Shortcut HTML is empty or exceeds its size limit.", {
      maxBytes: MAX_HTML_BYTES
    });
  }
  const captured = new Date(String(body.capturedAt || ""));
  if (!Number.isFinite(captured.getTime())) {
    throw new RegistryError("SHORTCUT_EVIDENCE_TIMESTAMP_INVALID", "Shortcut capture timestamp is invalid.");
  }
  return {
    html,
    capturedAt: captured.toISOString(),
    screenshot: decodeScreenshot(body.screenshotDataUrl)
  };
}

function decodeScreenshot(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new RegistryError("SHORTCUT_EVIDENCE_SCREENSHOT_INVALID", "Shortcut screenshot is invalid.");
  }
  const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) throw new RegistryError("SHORTCUT_EVIDENCE_SCREENSHOT_INVALID", "Shortcut screenshot must be a JPEG data URL.");
  const buffer = Buffer.from(match[1], "base64");
  if (!buffer.length || buffer.length > MAX_SCREENSHOT_BYTES || buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[2] !== 0xff) {
    throw new RegistryError("SHORTCUT_EVIDENCE_SCREENSHOT_INVALID", "Shortcut screenshot is invalid or exceeds its size limit.", {
      maxBytes: MAX_SCREENSHOT_BYTES
    });
  }
  return buffer;
}

async function sweepStaleStaging(stagingRoot, now = Date.now()) {
  let entries;
  try { entries = await fs.readdir(stagingRoot, { withFileTypes: true }); }
  catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
    const target = path.join(stagingRoot, entry.name);
    const stat = await fs.stat(target).catch(() => null);
    if (stat && now - stat.mtimeMs >= STALE_AFTER_MS) await fs.rm(target, { recursive: true, force: true });
  }));
}

function positiveEntryId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new RegistryError("ENTRY_ID_INVALID", "Entry ID must be a positive integer.");
  return id;
}

module.exports = { stageShortcutEvidence };
