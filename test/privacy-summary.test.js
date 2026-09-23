"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { createHash } = require("node:crypto");

const { addComment } = require("../registry/comments");
const { openRegistry } = require("../registry/database");
const { addEntry } = require("../registry/entries");
const { createFolder } = require("../registry/folders");
const {
  createSummaryJob,
  listSummaryJobs,
  prepareSummaryPayload
} = require("../registry/summaries");
const { addTags } = require("../registry/tags");
const { addLocalImage } = require("../registry/visual-assets");

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wbh-private-"));
  return {
    directory,
    registry: openRegistry({ dbPath: path.join(directory, "registry.sqlite3") })
  };
}

function dispose(subject) {
  subject.registry.close();
  fs.rmSync(subject.directory, { recursive: true, force: true, maxRetries: 3 });
}

function addPolicyEntry(registry, policy) {
  const identity = [policy.visibility, policy.agentAccess, policy.aiProcessing].join("-");
  return addEntry(registry, {
    url: `https://example.test/summary?policy=${identity}`,
    title: "Synthetic",
    typedMetadata: { type: "test" },
    savedAt: "2026-01-01",
    ...policy
  }).entry;
}

test("summary jobs serialize policy changes with payload and provenance creation", () => {
  for (const timing of ["before-lock", "after-payload-read"]) {
    const subject = setup();
    let second;
    try {
      const entry = addPolicyEntry(subject.registry, { visibility: "normal", agentAccess: "allowed", aiProcessing: "manual" });
      addComment(subject.registry, entry.id, "Synthetic input note");
      const expectedHash = createHash("sha256").update(JSON.stringify(prepareSummaryPayload(subject.registry, entry.id))).digest("hex");
      second = new DatabaseSync(subject.registry.dbPath);
      second.exec("PRAGMA busy_timeout = 0");
      let attempted = false;
      let updated = false;
      const changePolicy = () => second.prepare(`
        UPDATE entries SET visibility = 'private', agent_access = 'blocked', ai_processing = 'disabled' WHERE id = ?
      `).run(entry.id);
      function competingPolicyChange() {
        attempted = true;
        try {
          changePolicy();
          updated = true;
        } catch (error) {
          assert.equal(error.errcode, 5, "policy change must wait for the summary write lock");
        }
      }
      const db = new Proxy(subject.registry.db, {
        get(target, property) {
          if (property === "exec") return (sql) => {
            if (timing === "before-lock" && sql === "BEGIN IMMEDIATE") competingPolicyChange();
            return target.exec(sql);
          };
          if (property === "prepare") return (sql) => {
            const statement = target.prepare(sql);
            if (timing !== "after-payload-read" || !/SELECT body, created_at\s+FROM entry_comments/.test(sql)) return statement;
            return { all(...args) {
              const rows = statement.all(...args);
              competingPolicyChange();
              return rows;
            } };
          };
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        }
      });
      if (timing === "before-lock") {
        assert.throws(() => createSummaryJob({ ...subject.registry, db }, entry.id), { code: "SUMMARY_PRIVATE_ENTRY" });
        assert.equal(updated, true);
        assert.equal(listSummaryJobs(subject.registry).total, 0);
      } else {
        const job = createSummaryJob({ ...subject.registry, db }, entry.id);
        assert.equal(updated, false);
        assert.equal(job.input_sha256, expectedHash);
        assert.deepEqual(job.policy_snapshot, { visibility: "normal", agent_access: "allowed", ai_processing: "enabled" });
        assert.equal(changePolicy().changes, 1, "policy changes can commit after job creation");
        assert.throws(() => createSummaryJob(subject.registry, entry.id), { code: "SUMMARY_PRIVATE_ENTRY" });
        assert.equal(listSummaryJobs(subject.registry).total, 1);
      }
      assert.equal(attempted, true);
      assert.equal(subject.registry.db.isTransaction, false);
    } finally {
      second?.close();
      dispose(subject);
    }
  }
});

test("private and corrupted legacy policy mirrors are rejected before payload/job creation", () => {
  const subject = setup();
  try {
    const cases = [
      [
        { visibility: "private", agentAccess: "allowed", aiProcessing: "enabled" },
        null,
        "SUMMARY_PRIVATE_ENTRY"
      ],
      [
        { visibility: "normal" },
        { agent_access: "blocked" },
        "AGENT_ACCESS_BLOCKED"
      ],
      [
        { visibility: "normal" },
        { ai_processing: "disabled" },
        "AI_PROCESSING_DISABLED"
      ]
    ];
    for (const [index, [policy, corruption, code]] of cases.entries()) {
      const item = addPolicyEntry(subject.registry, {
        ...policy,
        url: `https://example.test/summary?case=${index}`
      });
      if (corruption) {
        const [column, value] = Object.entries(corruption)[0];
        subject.registry.db.prepare(`UPDATE entries SET ${column} = ? WHERE id = ?`).run(value, item.id);
      }
      assert.throws(
        () => prepareSummaryPayload(subject.registry, item.id),
        (error) => error.code === code
      );
      assert.throws(
        () => createSummaryJob(subject.registry, item.id),
        (error) => error.code === code
      );
    }
    assert.equal(listSummaryJobs(subject.registry).total, 0);
  } finally {
    dispose(subject);
  }
});

test("legacy metadata-only corruption omits comments and visual/folder data; jobs preserve provenance without payload", async () => {
  const subject = setup();
  try {
    const folder = createFolder(subject.registry, { name: "Synthetic private folder" });
    const limited = addPolicyEntry(subject.registry, { visibility: "normal", folderId: folder.id });
    subject.registry.db.prepare(`
      UPDATE entries SET agent_access = 'metadata_only', ai_processing = 'manual' WHERE id = ?
    `).run(limited.id);
    addComment(subject.registry, limited.id, "do not expose");
    addTags(subject.registry, limited.id, ["Synthetic"]);
    const sourcePath = path.join(subject.directory, "private-preview.png");
    fs.writeFileSync(sourcePath, PNG);
    const image = await addLocalImage(subject.registry, limited.id, sourcePath, {
      sourceKind: "browser_selected",
      sourceUrl: "https://images.example.test/private-preview.png"
    });
    const payload = prepareSummaryPayload(subject.registry, limited.id);
    assert.equal("comments" in payload, false);
    assert.equal("snapshots" in payload, false);
    const payloadJson = JSON.stringify(payload);
    for (const field of ["folder", "folder_id", "content_focus", "cover_image", "visual_assets", "storage_path", "file_path", "source_url"]) {
      assert.equal(payloadJson.includes(field), false, `${field} must stay outside the model payload`);
    }
    for (const value of ["do not expose", folder.name, image.asset.source_url, image.asset.storage_path, image.asset.file_path]) {
      assert.equal(payloadJson.includes(value), false);
    }

    const allowed = addPolicyEntry(subject.registry, {
      visibility: "normal",
      agentAccess: "allowed",
      aiProcessing: "enabled"
    });
    addComment(subject.registry, allowed.id, "included");
    assert.equal(prepareSummaryPayload(subject.registry, allowed.id).comments[0].body, "included");

    const job = createSummaryJob(subject.registry, limited.id, { requestedBy: "test" });
    assert.equal(job.model, "gpt-6-luna");
    assert.equal(job.reasoning_effort, "max");
    assert.match(job.input_sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(job.policy_snapshot, {
      visibility: "normal",
      agent_access: "metadata_only",
      ai_processing: "manual"
    });
    assert.equal(Object.prototype.hasOwnProperty.call(job, "payload"), false);
    assert.equal(listSummaryJobs(subject.registry, { entryId: limited.id }).total, 1);
  } finally {
    dispose(subject);
  }
});
