"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const test = require("node:test");

const { extractPublicEvidence } = require("../enrichment/public-evidence.js");
const { renderPdfFirstPage } = require("../enrichment/pdf-first-page.js");
const { addEntry, editEntry, getEntry } = require("../registry/entries.js");
const { openRegistry } = require("../registry/database.js");
const { addComment, listComments } = require("../registry/comments.js");
const { completeSummaryJob, createSummaryJob, listSummaryJobs } = require("../registry/summaries.js");
const { addLocalImage, addRemoteImageReference, listVisualAssets } = require("../registry/visual-assets.js");
const {
  createAiUrlSummaryService,
  runCodexSummary,
  validateSummary
} = require("../server/ai-url-summary.js");
const { loadVerifiedEvidence, parseArgs } = require("../scripts/run-ai-url-summary.js");

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wbh-ai-summary-"));
  const registry = openRegistry({ dbPath: path.join(directory, "registry.sqlite3") });
  return { directory, registry };
}

function addEligible(registry, suffix = "1") {
  return addEntry(registry, {
    url: `https://example.test/posts/${suffix}`,
    title: `Saved title ${suffix}`,
    visibility: "normal",
    agentAccess: "allowed",
    aiProcessing: "enabled"
  }).entry;
}

function downloader(subject) {
  return async (_registry, sourceUrl) => {
    const staging = path.join(subject.registry.dataDir, "capture-staging");
    fs.mkdirSync(staging, { recursive: true });
    const filePath = path.join(staging, "download.png");
    fs.writeFileSync(filePath, PNG);
    return { filePath, finalUrl: sourceUrl, byteSize: PNG.length };
  };
}

function dispose(subject) {
  subject.registry.close();
  fs.rmSync(subject.directory, { recursive: true, force: true, maxRetries: 3 });
}

test("public evidence prioritizes a video poster over social image metadata", () => {
  const evidence = extractPublicEvidence(`
    <html><head>
      <meta property="og:url" content="https://x.com/glagstonegame/status/2098476130302910841">
      <meta property="og:title" content="GlagStone on X">
      <meta property="og:description" content="I wanted night to actually feel dark">
      <meta property="og:image" content="https://cdn.test/large.webp?a=1&amp;b=2">
    </head><body><video poster="https://cdn.test/poster.webp"></video></body></html>
  `, "https://x.com/glagstonegame/status/2098476130302910841");
  assert.equal(evidence.image_url, "https://cdn.test/poster.webp");
  assert.equal(evidence.media_kind, "video");
  assert.equal(evidence.media_expected, true);
});

test("all mode processes more than ten eligible URLs and selected mode filters policy", async () => {
  const subject = fixture();
  try {
    const entries = Array.from({ length: 12 }, (_, index) => addEligible(subject.registry, String(index + 1)));
    const privateEntry = addEntry(subject.registry, { url: "https://example.test/private", visibility: "private" }).entry;
    const service = createAiUrlSummaryService({
      registry: subject.registry,
      fetchEvidence: async () => ({ title: "Example", description: null, image_url: null, media_kind: "none", media_expected: false }),
      summarize: async () => ({ summary: "예시 페이지의 제목에 근거해 저장된 URL을 간단히 소개하는 요약입니다." }),
      writeReport: async () => "synthetic-report.json"
    });
    assert.equal(service.status().eligible_count, 12);
    const selected = await service.runNow({ entryIds: [entries[0].id, privateEntry.id] });
    assert.equal(selected.requested_entries, 1);
    assert.equal(service.status().eligible_count, 11);
    const all = await service.runNow();
    assert.equal(all.requested_entries, 11);
    assert.deepEqual(all.counts, { complete: 11, partial: 0, failed: 0 });
    assert.equal(service.status().eligible_count, 0);
  } finally { dispose(subject); }
});

test("runner stores a local cover and one validated Korean summary", async () => {
  const subject = fixture();
  try {
    const entry = addEligible(subject.registry);
    const service = createAiUrlSummaryService({
      registry: subject.registry,
      fetchEvidence: async () => ({
        page_url: entry.url_original,
        title: "Example post",
        description: "A bounded description.",
        image_url: "https://cdn.test/poster.png",
        media_kind: "video",
        media_expected: true
      }),
      downloadImage: downloader(subject),
      summarize: async () => ({ summary: "예시 포스트가 제한된 설명과 함께 영상 장면을 소개하는 저장 항목입니다." }),
      writeReport: async () => "synthetic-report.json"
    });
    const run = await service.runNow({ limit: 1 });
    assert.deepEqual(run.counts, { complete: 1, partial: 0, failed: 0 });
    assert.equal(run.report_file, "synthetic-report.json");
    const comments = listComments(subject.registry, entry.id).items;
    assert.equal(comments.length, 1);
    assert.match(comments[0].body, /^예시 포스트/);
    assert.equal(getEntry(subject.registry, entry.id).latest_summary.text, comments[0].body);
    assert.equal(listSummaryJobs(subject.registry, { entryId: entry.id }).items[0].status, "completed");
    const assets = listVisualAssets(subject.registry, entry.id);
    assert.equal(assets.length, 1);
    assert.equal(assets[0].storage_kind, "local");
    assert.equal(assets[0].is_cover, true);
    assert.equal(fs.existsSync(assets[0].file_path), true);
    assert.equal(fs.existsSync(path.join(subject.registry.dataDir, "capture-staging", "download.png")), false);
  } finally {
    dispose(subject);
  }
});

test("an explicitly selected titleless Entry with a user Note receives a title without another Note", async () => {
  const subject = fixture();
  try {
    const entry = addEntry(subject.registry, {
      url: "https://example.test/posts/titleless", visibility: "normal"
    }).entry;
    addComment(subject.registry, entry.id, "사용자 메모");
    const service = createAiUrlSummaryService({
      registry: subject.registry,
      fetchEvidence: async () => ({
        kind: "generic", title: "Concrete page", content: "A bounded visible paragraph.",
        content_source: "page_content", sufficient: true, image_url: null,
        media_kind: "none", media_expected: false
      }),
      summarize: async (input) => {
        assert.equal(input.content, "A bounded visible paragraph.");
        return { title: "구체적인 페이지 내용", summary: "저장된 페이지는 구체적인 주제를 다루는 짧은 문단을 설명합니다." };
      },
      writeReport: async () => "synthetic-report.json"
    });
    assert.equal(service.status().eligible_count, 1);
    const run = await service.runNow({ entryIds: [entry.id] });
    assert.equal(run.counts.complete, 1);
    assert.equal(getEntry(subject.registry, entry.id).title_origin, "ai");
    assert.equal(getEntry(subject.registry, entry.id).title, "구체적인 페이지 내용");
    assert.deepEqual(listComments(subject.registry, entry.id).items.map((item) => item.body), ["사용자 메모"]);
    assert.equal(getEntry(subject.registry, entry.id).latest_summary.text, "저장된 페이지는 구체적인 주제를 다루는 짧은 문단을 설명합니다.");
    assert.equal(service.status().eligible_count, 0);
  } finally { dispose(subject); }
});

test("insufficient evidence never invokes the model or mutates a titleless Entry", async () => {
  const subject = fixture();
  try {
    const entry = addEntry(subject.registry, { url: "https://example.test/empty", visibility: "normal" }).entry;
    let modelCalls = 0;
    const service = createAiUrlSummaryService({
      registry: subject.registry,
      fetchEvidence: async () => ({
        kind: "generic", title: null, content: null, sufficient: false,
        reason: "AI_EVIDENCE_INSUFFICIENT", image_url: null,
        media_kind: "none", media_expected: false
      }),
      summarize: async () => { modelCalls++; throw new Error("Must not run"); },
      writeReport: async () => "synthetic-report.json"
    });
    const run = await service.runNow();
    assert.equal(run.counts.failed, 1);
    assert.equal(run.items[0].errors[0], "AI_EVIDENCE_INSUFFICIENT");
    assert.equal(modelCalls, 0);
    assert.equal(getEntry(subject.registry, entry.id).title, null);
    assert.equal(listComments(subject.registry, entry.id).items.length, 0);
  } finally { dispose(subject); }
});

test("all mode tries a URL once; explicit selection retries and records each attempt", async () => {
  const subject = fixture();
  try {
    const entry = addEntry(subject.registry, { url: "https://example.test/retry", visibility: "normal" }).entry;
    let evidenceCalls = 0;
    const service = createAiUrlSummaryService({
      registry: subject.registry,
      fetchEvidence: async () => {
        evidenceCalls += 1;
        return { kind: "generic", sufficient: false, reason: "AI_EVIDENCE_INSUFFICIENT",
          image_url: null, media_kind: "none", media_expected: false };
      },
      summarize: async () => { throw new Error("Model must not run"); },
      writeReport: async () => "synthetic-report.json"
    });
    assert.equal(service.status().eligible_count, 1);
    assert.equal((await service.runNow()).counts.failed, 1);
    assert.equal(service.status().eligible_count, 0);
    assert.equal((await service.runNow()).requested_entries, 0);
    assert.equal((await service.runNow({ entryIds: [entry.id] })).counts.failed, 1);
    assert.equal(evidenceCalls, 2);
    const attempts = subject.registry.db.prepare(`
      SELECT source, status, error_code, total_ms, evidence_ms, model_ms
      FROM ai_summary_attempts WHERE entry_id = ? ORDER BY id
    `).all(entry.id);
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts.map((attempt) => attempt.status), ["failed", "failed"]);
    assert.ok(attempts.every((attempt) => attempt.error_code === "AI_EVIDENCE_INSUFFICIENT"));
    assert.ok(attempts.every((attempt) => attempt.total_ms >= 0 && attempt.evidence_ms >= 0));
    assert.ok(attempts.every((attempt) => attempt.model_ms === null));
  } finally { dispose(subject); }
});

test("successful model usage is stored compactly and explicit reruns do not duplicate Notes", async () => {
  const subject = fixture();
  try {
    const entry = addEligible(subject.registry, "usage");
    let calls = 0;
    const service = createAiUrlSummaryService({
      registry: subject.registry,
      fetchEvidence: async () => ({ kind: "generic", title: "Exact page", content: "Exact page text",
        sufficient: true, image_url: null, media_kind: "none", media_expected: false }),
      summarize: async () => {
        calls += 1;
        return { title: "구체적인 페이지", summary: "구체적인 페이지의 내용을 확인해 저장된 URL을 요약하는 문장입니다.",
          usage: { input_tokens: 123, cached_input_tokens: 20, output_tokens: 45 } };
      },
      writeReport: async () => "synthetic-report.json"
    });
    assert.equal((await service.runNow()).counts.complete, 1);
    assert.equal(service.status().eligible_count, 0);
    assert.equal((await service.runNow({ entryIds: [entry.id] })).counts.complete, 1);
    assert.equal(calls, 2);
    assert.equal(listComments(subject.registry, entry.id).items.length, 1);
    const attempts = subject.registry.db.prepare(`
      SELECT input_tokens, cached_input_tokens, output_tokens, model_ms, total_ms
      FROM ai_summary_attempts WHERE entry_id = ? ORDER BY id
    `).all(entry.id);
    assert.equal(attempts.length, 2);
    assert.ok(attempts.every((attempt) => attempt.input_tokens === 123
      && attempt.cached_input_tokens === 20 && attempt.output_tokens === 45));
    assert.ok(attempts.every((attempt) => attempt.model_ms >= 0 && attempt.total_ms >= attempt.model_ms));
  } finally { dispose(subject); }
});

test("item-specific media can be saved as partial when text is insufficient", async () => {
  const subject = fixture();
  try {
    const entry = addEntry(subject.registry, { url: "https://example.test/media", visibility: "normal" }).entry;
    const service = createAiUrlSummaryService({
      registry: subject.registry,
      fetchEvidence: async () => ({
        kind: "generic", title: null, content: null, sufficient: false,
        reason: "AI_EVIDENCE_INSUFFICIENT", image_url: "https://cdn.test/saved-item.jpg",
        media_kind: "image", media_expected: true
      }),
      downloadImage: downloader(subject),
      summarize: async () => { throw new Error("No model call for missing text"); },
      writeReport: async () => "synthetic-report.json"
    });
    const run = await service.runNow();
    assert.equal(run.counts.partial, 1);
    assert.equal(run.items[0].errors[0], "AI_EVIDENCE_INSUFFICIENT");
    assert.equal(listVisualAssets(subject.registry, entry.id)[0].storage_kind, "local");
    assert.equal(getEntry(subject.registry, entry.id).title, null);
  } finally { dispose(subject); }
});

test("runner preserves an existing cover and ignores a duplicate active request", async () => {
  const subject = fixture();
  try {
    const entry = addEligible(subject.registry);
    const localImage = path.join(subject.directory, "existing.png");
    fs.writeFileSync(localImage, PNG);
    const existing = await addLocalImage(subject.registry, entry.id, localImage, { makeCover: true });
    let release;
    const waiting = new Promise((resolve) => { release = resolve; });
    let downloadCalls = 0;
    const service = createAiUrlSummaryService({
      registry: subject.registry,
      fetchEvidence: async () => ({
        page_url: entry.url_original,
        title: "Example post",
        description: "Description",
        image_url: "https://cdn.test/new.png",
        media_kind: "image",
        media_expected: true
      }),
      downloadImage: async () => { downloadCalls += 1; throw new Error("unexpected"); },
      summarize: async () => { await waiting; return { summary: "기존 커버 이미지를 유지하면서 저장된 페이지의 핵심 내용을 간단히 요약합니다." }; },
      writeReport: async () => "synthetic-report.json"
    });
    assert.equal(service.start().newly_queued, 1);
    assert.equal(service.start({ entryIds: [entry.id, entry.id] }).newly_queued, 0);
    assert.equal(service.status().progress.total, 1);
    release();
    while (service.status().status === "running") await new Promise((resolve) => setImmediate(resolve));
    assert.equal(downloadCalls, 0);
    const assets = listVisualAssets(subject.registry, entry.id);
    assert.equal(assets.length, 1);
    assert.equal(assets[0].id, existing.asset.id);
    assert.equal(assets[0].is_cover, true);
  } finally {
    dispose(subject);
  }
});

test("distinct requests join the running FIFO queue once and report waiting progress", async () => {
  const subject = fixture();
  try {
    const entries = ["a", "b", "c"].map((name) => addEligible(subject.registry, name));
    let release;
    const waiting = new Promise((resolve) => { release = resolve; });
    const summarized = [];
    let reported;
    const service = createAiUrlSummaryService({
      registry: subject.registry,
      fetchEvidence: async () => ({ title: "Example", description: null, image_url: null, media_kind: "none", media_expected: false }),
      summarize: async (input) => {
        summarized.push(input.url);
        if (input.url === entries[0].url_original) await waiting;
        return { summary: "요청한 URL의 제목을 근거로 핵심 내용을 간단하고 보수적으로 설명합니다." };
      },
      writeReport: async (_registry, run) => { reported = run; return "synthetic-report.json"; }
    });
    assert.equal(service.start({ entryIds: [entries[0].id] }).newly_queued, 1);
    assert.equal(service.start({ entryIds: [entries[0].id] }).newly_queued, 0);
    const queued = service.start({ entryIds: [entries[1].id, entries[2].id, entries[1].id] });
    assert.equal(queued.newly_queued, 2);
    assert.equal(queued.queued_count, 2);
    assert.equal(queued.progress.total, 3);
    assert.equal(queued.available_count, 0);
    assert.equal(service.start().newly_queued, 0);
    release();
    while (service.status().status === "running") await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(summarized, entries.map((entry) => entry.url_original));
    assert.deepEqual(reported.items.map((item) => item.entry_id), entries.map((entry) => entry.id));
    assert.deepEqual(reported.counts, { complete: 3, partial: 0, failed: 0 });
  } finally { dispose(subject); }
});

test("a queued URL with a new Note still gets a summary, while Private is skipped", async () => {
  const subject = fixture();
  try {
    const [active, noted, privateEntry] = ["active", "noted", "private"].map((name) => addEligible(subject.registry, name));
    let release;
    const waiting = new Promise((resolve) => { release = resolve; });
    const seen = [];
    let reported;
    const service = createAiUrlSummaryService({
      registry: subject.registry,
      fetchEvidence: async (url) => { seen.push(url); return { title: "Example", description: null, image_url: null, media_kind: "none", media_expected: false }; },
      summarize: async (input) => {
        if (input.url === active.url_original) await waiting;
        return { summary: "요청한 URL의 제목을 근거로 핵심 내용을 간단하고 보수적으로 설명합니다." };
      },
      writeReport: async (_registry, run) => { reported = run; return "synthetic-report.json"; }
    });
    assert.equal(service.start().newly_queued, 3);
    addComment(subject.registry, noted.id, "사용자가 대기 중 직접 추가한 Note");
    editEntry(subject.registry, privateEntry.id, { visibility: "private" });
    release();
    while (service.status().status === "running") await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(seen, [active.url_original, noted.url_original]);
    assert.equal(reported.counts.skipped, 1);
    assert.deepEqual(listComments(subject.registry, noted.id).items.map((item) => item.body), ["사용자가 대기 중 직접 추가한 Note"]);
    assert.equal(reported.items[2].errors[0], "AI_SUMMARY_NO_LONGER_PENDING");
  } finally { dispose(subject); }
});

test("a request arriving while the report is written is still processed", async () => {
  const subject = fixture();
  try {
    const first = addEligible(subject.registry, "first");
    const second = addEligible(subject.registry, "second");
    let reportStarted;
    const started = new Promise((resolve) => { reportStarted = resolve; });
    let releaseReport;
    const waiting = new Promise((resolve) => { releaseReport = resolve; });
    const reports = [];
    const service = createAiUrlSummaryService({
      registry: subject.registry,
      fetchEvidence: async () => ({ title: "Example", description: null, image_url: null, media_kind: "none", media_expected: false }),
      summarize: async () => ({ summary: "요청한 URL의 제목을 근거로 핵심 내용을 간단하고 보수적으로 설명합니다." }),
      writeReport: async (_registry, run) => {
        reports.push(run);
        if (reports.length === 1) { reportStarted(); await waiting; }
        return "synthetic-report.json";
      }
    });
    service.start({ entryIds: [first.id] });
    await started;
    assert.equal(service.start({ entryIds: [second.id] }).newly_queued, 1);
    releaseReport();
    while (service.status().status === "running") await new Promise((resolve) => setImmediate(resolve));
    assert.equal(reports.length, 2);
    assert.deepEqual(reports[1].items.map((item) => item.entry_id), [first.id, second.id]);
  } finally { dispose(subject); }
});

test("runner localizes the exact remote cover and selects the local copy", async () => {
  const subject = fixture();
  try {
    const entry = addEligible(subject.registry);
    const remote = addRemoteImageReference(subject.registry, entry.id, "https://cdn.test/remote.png", {
      sourceKind: "provider_thumbnail",
      makeCover: true
    });
    const service = createAiUrlSummaryService({
      registry: subject.registry,
      fetchEvidence: async () => ({
        page_url: entry.url_original,
        title: "Example post",
        description: "Description",
        image_url: "https://cdn.test/remote.png",
        media_kind: "image",
        media_expected: true
      }),
      downloadImage: downloader(subject),
      summarize: async () => ({ summary: "원격 참조만 있던 대표 이미지를 로컬에 저장하면서 기존 커버 선택은 그대로 유지합니다." }),
      writeReport: async () => "synthetic-report.json"
    });
    const run = await service.runNow({ limit: 1 });
    assert.deepEqual(run.counts, { complete: 1, partial: 0, failed: 0 });
    const assets = listVisualAssets(subject.registry, entry.id);
    assert.equal(assets.length, 2);
    assert.equal(assets.filter((asset) => asset.storage_kind === "local").length, 1);
    assert.equal(assets.find((asset) => asset.id === remote.asset.id).is_cover, false);
    assert.equal(assets.find((asset) => asset.storage_kind === "local").is_cover, true);
    assert.equal(assets.find((asset) => asset.storage_kind === "local").source_url, remote.asset.source_url);
  } finally {
    dispose(subject);
  }
});

test("remote selected cover is localized even when another local image exists", async () => {
  const subject = fixture();
  try {
    const entry = addEligible(subject.registry);
    const oldFile = path.join(subject.directory, "old.png");
    fs.writeFileSync(oldFile, PNG);
    await addLocalImage(subject.registry, entry.id, oldFile);
    addRemoteImageReference(subject.registry, entry.id, "https://cdn.test/selected.png", {
      sourceKind: "browser_selected", makeCover: true
    });
    let downloaded;
    const service = createAiUrlSummaryService({
      registry: subject.registry,
      fetchEvidence: async () => ({ title: "Title", description: null, image_url: "https://cdn.test/other.png", media_kind: "image", media_expected: true }),
      downloadImage: async (...args) => { downloaded = args[1]; return downloader(subject)(...args); },
      summarize: async () => ({ summary: "선택된 원격 이미지를 로컬 표지로 보존한 항목의 간단한 요약입니다." }),
      writeReport: async () => "synthetic-report.json"
    });
    const run = await service.runNow({ entryIds: [entry.id] });
    assert.equal(run.counts.complete, 1);
    assert.equal(downloaded, "https://cdn.test/selected.png");
    const cover = listVisualAssets(subject.registry, entry.id).find((asset) => asset.is_cover);
    assert.equal(cover.storage_kind, "local");
    assert.equal(cover.source_kind, "browser_selected");
  } finally { dispose(subject); }
});

test("Pinterest's conflicting SEO description is excluded from model evidence", async () => {
  const subject = fixture();
  try {
    const entry = addEntry(subject.registry, {
      url: "https://www.pinterest.com/pin/1234/",
      title: "Miniature bedroom",
      visibility: "normal", agentAccess: "allowed", aiProcessing: "enabled"
    }).entry;
    let seen;
    const service = createAiUrlSummaryService({
      registry: subject.registry,
      fetchEvidence: async () => ({ title: "Miniature bedroom", description: "Unrelated planets", image_url: null, media_kind: "none", media_expected: false }),
      summarize: async (input) => { seen = input; return { summary: "미니어처 침실 인테리어를 보여주는 Pinterest 저장 이미지입니다." }; },
      writeReport: async () => "synthetic-report.json"
    });
    const run = await service.runNow({ entryIds: [entry.id] });
    assert.equal(run.counts.complete, 1);
    assert.equal(seen.description, null);
    assert.match(getEntry(subject.registry, entry.id).latest_summary.text, /미니어처/);
  } finally {
    dispose(subject);
  }
});

test("policy drift prevents both media and summary writeback", async () => {
  const subject = fixture();
  try {
    const entry = addEligible(subject.registry);
    const service = createAiUrlSummaryService({
      registry: subject.registry,
      fetchEvidence: async () => {
        editEntry(subject.registry, entry.id, {
          visibility: "private",
          agentAccess: "blocked",
          aiProcessing: "disabled"
        });
        return {
          page_url: entry.url_original,
          title: "Changed",
          description: "Changed policy",
          image_url: "https://cdn.test/poster.png",
          media_kind: "image",
          media_expected: true
        };
      },
      downloadImage: downloader(subject),
      summarize: async () => ({ summary: "정책 변경 뒤에는 이 요약이 저장되지 않아야 하며 이미지도 추가되면 안 됩니다." }),
      writeReport: async () => "synthetic-report.json"
    });
    const run = await service.runNow({ entryIds: [entry.id], limit: 1 });
    assert.deepEqual(run.counts, { complete: 0, partial: 0, failed: 1 });
    assert.equal(listComments(subject.registry, entry.id).items.length, 0);
    assert.equal(listSummaryJobs(subject.registry, { entryId: entry.id }).items.length, 0);
    assert.equal(listVisualAssets(subject.registry, entry.id).length, 0);
  } finally {
    dispose(subject);
  }
});

test("a title edit during model execution rolls back the card summary and Note", async () => {
  const subject = fixture();
  try {
    const entry = addEligible(subject.registry);
    const service = createAiUrlSummaryService({
      registry: subject.registry,
      fetchEvidence: async () => ({ title: "Original", description: null, image_url: null, media_kind: "none", media_expected: false }),
      summarize: async () => {
        editEntry(subject.registry, entry.id, { title: "User edited title" });
        return { summary: "제목이 바뀌기 전의 자료를 근거로 생성된 오래된 요약입니다." };
      },
      writeReport: async () => "synthetic-report.json"
    });
    const run = await service.runNow({ entryIds: [entry.id] });
    assert.equal(run.counts.failed, 1);
    assert.deepEqual(run.items[0].errors, ["AI_SUMMARY_INPUT_CHANGED"]);
    assert.equal(getEntry(subject.registry, entry.id).latest_summary, null);
    assert.equal(listSummaryJobs(subject.registry, { entryId: entry.id }).items.length, 0);
    assert.equal(listComments(subject.registry, entry.id).items.length, 0);
  } finally { dispose(subject); }
});

test("codex invocation is ephemeral, read-only, fixed-model, and schema constrained", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wbh-ai-codex-"));
  try {
    let observed;
    const spawnImpl = (command, args, options) => {
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {};
      let prompt = "";
      child.stdin.on("data", (chunk) => { prompt += String(chunk); });
      child.stdin.on("finish", () => {
        observed = { command, args, options, prompt };
        const outputIndex = args.indexOf("--output-last-message") + 1;
        fs.writeSync(options.stdio[1], `${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 120, cached_input_tokens: 20, output_tokens: 30 } })}\n`);
        fs.writeSync(options.stdio[2], "synthetic diagnostic\n");
        fs.writeFileSync(args[outputIndex], JSON.stringify({ title: "저장된 페이지의 핵심 내용", summary: "공급된 근거만 사용해 저장된 페이지의 핵심 내용을 보수적으로 요약한 문장입니다." }));
        setImmediate(() => child.emit("close", 0));
      });
      return child;
    };
    const result = await runCodexSummary({
      url: "https://example.test/post",
      saved_title: "Saved",
      page_title: "Page",
      description: "Description",
      media_kind: "image"
    }, { repoRoot: path.resolve(__dirname, ".."), dataDir: directory, spawnImpl,
      imageFile: "synthetic-first-page.png", timeoutMs: 5000 });
    assert.match(result.summary, /^공급된 근거/);
    if (process.platform === "win32") {
      assert.equal(observed.command, process.execPath);
      assert.match(observed.args[0], /@openai[\\/]codex[\\/]bin[\\/]codex\.js$/);
    } else {
      assert.equal(observed.command, "codex");
    }
    assert.ok(observed.args.includes("--ephemeral"));
    assert.ok(observed.args.includes("--json"));
    assert.ok(observed.args.includes("--ignore-user-config"));
    assert.deepEqual(observed.args.slice(observed.args.indexOf("--sandbox"), observed.args.indexOf("--sandbox") + 2), ["--sandbox", "read-only"]);
    assert.deepEqual(observed.args.slice(observed.args.indexOf("--model"), observed.args.indexOf("--model") + 2), ["--model", "gpt-5.6-luna"]);
    assert.ok(observed.args.includes("--output-schema"));
    assert.deepEqual(observed.args.slice(observed.args.indexOf("--image"), observed.args.indexOf("--image") + 2),
      ["--image", "synthetic-first-page.png"]);
    assert.match(observed.prompt, /Do not browse, call tools/);
    assert.match(observed.prompt, /A URL or path repeated as `saved_title` is only a placeholder/);
    assert.match(observed.prompt, /For a Research entry, use the paper title visible/);
    assert.match(observed.prompt, /Evidence JSON/);
    assert.deepEqual(result.usage, { input_tokens: 120, cached_input_tokens: 20, output_tokens: 30 });
    assert.equal(result.session_record, undefined);
    assert.deepEqual(fs.readdirSync(path.join(directory, "ai-summary-sessions")), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("PDF rendering requests only page one and removes transient files", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wbh-pdf-page-"));
  try {
    let seen;
    const rendered = await renderPdfFirstPage(Buffer.from("%PDF-1.7\nsynthetic"), directory, {
      runFile: async (_command, args) => {
        seen = args;
        fs.writeFileSync(`${args.at(-1)}.png`, PNG);
      }
    });
    assert.deepEqual(seen.slice(0, 4), ["-f", "1", "-l", "1"]);
    assert.equal(fs.existsSync(rendered.filePath), true);
    await rendered.cleanup();
    assert.equal(fs.existsSync(rendered.filePath), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("PDF summary attaches one transient page image without saving it as a Visual Asset", async () => {
  const subject = fixture();
  try {
    const entry = addEligible(subject.registry);
    let attached;
    let cleaned = false;
    const service = createAiUrlSummaryService({
      registry: subject.registry,
      fetchEvidence: async () => ({ kind: "pdf", sufficient: true, pdf_bytes: Buffer.from("%PDF-1.7"),
        title: null, description: null, content: null, image_url: null,
        media_kind: "none", media_expected: false }),
      renderPdfFirstPage: async () => ({ filePath: "synthetic-first-page.png", cleanup: async () => { cleaned = true; } }),
      summarize: async (_input, context) => {
        attached = context.imageFile;
        return { title: "논문의 구체적인 제목", summary: "논문 첫 페이지의 제목과 초록에 근거한 제한된 요약입니다." };
      },
      writeReport: async () => "synthetic-report.json"
    });
    const run = await service.runNow({ limit: 1 });
    assert.equal(run.items[0].status, "complete");
    assert.equal(attached, "synthetic-first-page.png");
    assert.equal(cleaned, true);
    assert.equal(listVisualAssets(subject.registry, entry.id).length, 0);
  } finally { dispose(subject); }
});

test("verified exact-page context can rescue a blocked Entry without fetching or changing its Note", async () => {
  const subject = fixture();
  try {
    const entry = addEligible(subject.registry);
    addComment(subject.registry, entry.id, "기존 사용자 메모");
    const service = createAiUrlSummaryService({
      registry: subject.registry,
      fetchEvidence: async () => { throw new Error("remote fetch must be skipped"); },
      summarize: async () => ({ summary: "확인된 원문 내용에 근거해 해당 저장 항목을 간결하게 요약합니다." }),
      writeReport: async () => "synthetic-report.json"
    });
    const evidence = { entry_id: entry.id, url: entry.url_original, kind: "generic",
      content_source: "verified_page_context", sufficient: true, title: "Exact item", content: "Exact content",
      description: null, image_url: null, media_kind: "none", media_expected: false };
    const run = await service.runNow({ entryIds: [entry.id], verifiedEvidence: evidence });
    assert.equal(run.items[0].status, "complete");
    assert.equal(run.items[0].evidence_source, "verified_page_context");
    assert.equal(listComments(subject.registry, entry.id).items.length, 1);
  } finally { dispose(subject); }
});

test("queued shortcut contexts stay bound to their Entry and clean exactly once", async () => {
  const subject = fixture();
  try {
    const first = addEligible(subject.registry, "shortcut-first");
    const second = addEligible(subject.registry, "shortcut-second");
    const seen = [];
    const cleaned = new Map();
    let releaseFirst;
    let firstStarted;
    const started = new Promise((resolve) => { firstStarted = resolve; });
    const blocked = new Promise((resolve) => { releaseFirst = resolve; });
    const service = createAiUrlSummaryService({
      registry: subject.registry,
      fetchEvidence: async () => { throw new Error("shortcut context must skip network fetch"); },
      summarize: async (input) => {
        seen.push(input.content);
        if (input.content === "first context") { firstStarted(); await blocked; }
        return { summary: "확인된 브라우저 문맥만 사용해 저장 항목의 핵심 내용을 간결하게 정리한 요약입니다." };
      },
      writeReport: async () => "synthetic-report.json"
    });
    const context = (entry, content) => ({
      entryId: entry.id,
      requireMissingSummary: true,
      verifiedEvidence: {
        entry_id: entry.id, url: entry.url_original, kind: "generic", sufficient: true,
        content, title: content, description: null, image_url: null,
        media_kind: "none", media_expected: false
      },
      cleanup: async () => cleaned.set(entry.id, (cleaned.get(entry.id) || 0) + 1)
    });
    service.start({ entryIds: [first.id], entryContext: context(first, "first context") });
    await started;
    assert.equal(service.start({ entryIds: [second.id], entryContext: context(second, "second context") }).newly_queued, 1);
    releaseFirst();
    while (service.status().status === "running") await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(seen, ["first context", "second context"]);
    assert.deepEqual([...cleaned.entries()], [[first.id, 1], [second.id, 1]]);
  } finally { dispose(subject); }
});

test("shortcut viewport becomes one page snapshot only when page evidence has no image", async () => {
  const subject = fixture();
  try {
    const entry = addEligible(subject.registry, "shortcut-snapshot");
    const screenshot = path.join(subject.directory, "viewport.png");
    fs.writeFileSync(screenshot, PNG);
    let modelImage;
    let cleaned = 0;
    const service = createAiUrlSummaryService({
      registry: subject.registry,
      fetchEvidence: async () => { throw new Error("shortcut context must skip network fetch"); },
      summarize: async (_input, context) => {
        modelImage = context.imageFile;
        return { summary: "브라우저에서 확인한 본문을 바탕으로 저장 항목의 핵심 내용을 간결하게 정리한 요약입니다." };
      },
      writeReport: async () => "synthetic-report.json"
    });
    const run = await service.runNow({
      entryIds: [entry.id],
      entryContext: {
        entryId: entry.id,
        requireMissingSummary: true,
        fallbackImageFile: screenshot,
        capturedAt: "2026-09-20T00:00:00.000Z",
        verifiedEvidence: {
          entry_id: entry.id, url: entry.url_original, kind: "generic", sufficient: true,
          content: "Captured article body", title: "Captured article", description: null,
          image_url: null, media_kind: "none", media_expected: false
        },
        cleanup: async () => { cleaned += 1; }
      }
    });
    assert.equal(run.items[0].status, "complete");
    assert.equal(modelImage, null);
    const assets = listVisualAssets(subject.registry, entry.id);
    assert.equal(assets.length, 1);
    assert.equal(assets[0].source_kind, "page_snapshot");
    assert.equal(assets[0].is_cover, true);
    assert.equal(cleaned, 1);
  } finally { dispose(subject); }
});

test("shortcut context does not overwrite a summary completed during its model call", async () => {
  const subject = fixture();
  try {
    const entry = addEligible(subject.registry, "shortcut-race");
    const service = createAiUrlSummaryService({
      registry: subject.registry,
      summarize: async () => {
        const job = createSummaryJob(subject.registry, entry.id, { requestedBy: "concurrent-test" });
        completeSummaryJob(subject.registry, job.id, "다른 실행이 먼저 저장한 유효한 요약입니다.");
        return { summary: "늦게 끝난 단축키 실행이 덮어쓰면 안 되는 요약 결과입니다." };
      },
      writeReport: async () => "synthetic-report.json"
    });
    const run = await service.runNow({
      entryIds: [entry.id],
      entryContext: {
        entryId: entry.id,
        requireMissingSummary: true,
        verifiedEvidence: {
          entry_id: entry.id, url: entry.url_original, kind: "generic", sufficient: true,
          content: "Captured article body", title: "Captured article", description: null,
          image_url: null, media_kind: "none", media_expected: false
        }
      }
    });
    assert.equal(run.items[0].status, "failed");
    assert.deepEqual(run.items[0].errors, ["AI_SUMMARY_NO_LONGER_PENDING"]);
    assert.equal(getEntry(subject.registry, entry.id).latest_summary.text, "다른 실행이 먼저 저장한 유효한 요약입니다.");
    assert.equal(listSummaryJobs(subject.registry, { entryId: entry.id }).items.length, 1);
  } finally { dispose(subject); }
});

test("failed browser-derived Codex input is removed while compact diagnostics remain", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wbh-ai-redacted-"));
  try {
    const spawnImpl = (_command, _args, options) => {
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.kill = () => {};
      child.stdin.on("finish", () => {
        fs.writeSync(options.stdio[1], `${JSON.stringify({ type: "error", message: "synthetic" })}\n`);
        fs.writeSync(options.stdio[2], "synthetic failure\n");
        setImmediate(() => child.emit("close", 1));
      });
      return child;
    };
    let failure;
    try {
      await runCodexSummary({ url: "https://example.test/private-context", content: "captured text" }, {
        repoRoot: path.resolve(__dirname, ".."), dataDir: directory, spawnImpl,
        redactInputOnFailure: true, timeoutMs: 5000
      });
    } catch (error) { failure = error; }
    assert.equal(failure.code, "AI_MODEL_EXIT_FAILED");
    const sessionDir = path.join(directory, failure.details.session_record);
    assert.equal(fs.existsSync(path.join(sessionDir, "prompt.txt")), false);
    assert.equal(fs.existsSync(path.join(sessionDir, "response.json")), false);
    assert.equal(fs.existsSync(path.join(sessionDir, "session.json")), true);
    assert.equal(fs.existsSync(path.join(sessionDir, "stderr.log")), true);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("owner evidence file is bounded and bound to one eligible Entry", () => {
  const subject = fixture();
  try {
    const entry = addEligible(subject.registry);
    const filePath = path.join(subject.directory, "verified.json");
    const payload = { entry_id: entry.id, url: entry.url_original,
      observed_at: "2026-09-17T00:00:00Z", page_title: "Exact saved item",
      content: "Observed original content", media_kind: "none" };
    fs.writeFileSync(filePath, JSON.stringify(payload));
    assert.equal(loadVerifiedEvidence(subject.registry, entry.id, filePath).content, payload.content);
    fs.writeFileSync(filePath, JSON.stringify({ ...payload, url: "https://other.test/item" }));
    assert.throws(() => loadVerifiedEvidence(subject.registry, entry.id, filePath), /exact Entry/);
    assert.throws(() => parseArgs(["--evidence-file", filePath]), /requires --entry/);
  } finally { dispose(subject); }
});

test("an exact URL placeholder can receive an AI title but authored titles remain protected", async () => {
  const subject = fixture();
  try {
    const entry = addEntry(subject.registry, { url: "https://example.test/work.pdf",
      title: "example.test/work.pdf", kind: "research", visibility: "normal" }).entry;
    const service = createAiUrlSummaryService({
      registry: subject.registry,
      fetchEvidence: async () => ({ kind: "arxiv", sufficient: true, title: "Actual paper title",
        content: "The abstract explains the method.", description: null,
        image_url: null, media_kind: "none", media_expected: false }),
      summarize: async (input) => {
        assert.equal(input.entry_kind, "research");
        assert.equal(input.page_title, "Actual paper title");
        return { title: "실제 논문 제목", summary: "논문 초록에서 설명한 방법을 바탕으로 내용을 요약합니다." };
      },
      writeReport: async () => "synthetic-report.json"
    });
    const run = await service.runNow({ entryIds: [entry.id] });
    assert.equal(run.items[0].status, "complete");
    assert.equal(getEntry(subject.registry, entry.id).title, "실제 논문 제목");
    assert.equal(getEntry(subject.registry, entry.id).title_origin, "ai");
  } finally { dispose(subject); }
});

test("failed Codex invocation retains input, diagnostics, and a report locator", async () => {
  const subject = fixture();
  try {
    const entry = addEligible(subject.registry);
    const spawnImpl = (_command, _args, options) => {
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.kill = () => {};
      child.stdin.on("finish", () => {
        fs.writeSync(options.stdio[1], `${JSON.stringify({ type: "error", message: "synthetic model error" })}\n`);
        fs.writeSync(options.stdio[2], "synthetic failure diagnostic\n");
        setImmediate(() => child.emit("close", 1));
      });
      return child;
    };
    const service = createAiUrlSummaryService({
      registry: subject.registry,
      fetchEvidence: async () => ({ title: "Example", description: null, image_url: null, media_kind: "none", media_expected: false }),
      spawnImpl,
      writeReport: async () => "synthetic-report.json"
    });
    const run = await service.runNow({ entryIds: [entry.id] });
    assert.deepEqual(run.items[0].errors, ["AI_MODEL_EXIT_FAILED"]);
    const sessionDir = path.join(subject.registry.dataDir, run.items[0].session_record);
    assert.equal(JSON.parse(fs.readFileSync(path.join(sessionDir, "session.json"), "utf8")).exit_code, 1);
    assert.match(fs.readFileSync(path.join(sessionDir, "prompt.txt"), "utf8"), /example\.test\/posts\/1/);
    assert.match(fs.readFileSync(path.join(sessionDir, "stderr.log"), "utf8"), /synthetic failure diagnostic/);
    assert.equal(fs.existsSync(path.join(sessionDir, "response.json")), false);
  } finally { dispose(subject); }
});

test("summary validation rejects extra fields and short output", () => {
  assert.throws(() => validateSummary({ summary: "짧음" }), { code: "AI_MODEL_OUTPUT_INVALID" });
  assert.throws(
    () => validateSummary({ summary: "충분한 길이의 한국어 요약문을 반환하지만 허용하지 않은 필드도 포함합니다.", extra: true }),
    { code: "AI_MODEL_OUTPUT_INVALID" }
  );
});
