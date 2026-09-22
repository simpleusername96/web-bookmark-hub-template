"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { main } = require("../agent-cli.js");
const { addComment } = require("../registry/comments.js");
const { openRegistry } = require("../registry/database.js");
const { addEntry, editEntry, getEntry } = require("../registry/entries.js");
const { revisionKey } = require("../enrichment/service.js");

function fixture(registry, id, options = {}) {
  return addEntry(registry, {
    url: "https://www.fmkorea.com/" + id,
    title: "Fixture " + id,
    savedAt: "2026-09-08T00:00:00.000Z",
    visibility: "normal",
    ...options
  }).entry;
}

async function runLocal(registry, argv, options = {}) {
  let output = "";
  const opened = [];
  const deps = {
    openRegistry: (openOptions) => {
      opened.push(openOptions);
      return { ...registry, close() {} };
    },
    stdout: { write: (text) => { output += text; } },
    ...options
  };
  const env = {
    WBH_AGENT_TOKEN: "token-that-must-not-select-broker",
    WBH_AGENT_URL: "http://127.0.0.2:3043"
  };
  const code = await main(argv, env, deps);
  return { code, data: JSON.parse(output), opened };
}

test("default local list ignores broker environment and applies date, note and policy filters", async (t) => {
  const registry = openRegistry({ dbPath: ":memory:" });
  t.after(() => registry.close());
  const eligible = fixture(registry, 101, { savedAt: "2026-09-07T00:00:00.000Z" });
  fixture(registry, 102, { savedAt: "2026-09-06T14:59:59.999Z" });
  fixture(registry, 103, { visibility: "private" });
  fixture(registry, 104, { visibility: "private" });
  const noted = fixture(registry, 105);
  addComment(registry, noted.id, "already noted");

  const result = await runLocal(registry, [
    "list", "--saved-from", "2026-09-07T00:00:00+09:00",
    "--note", "empty", "--enrichable", "--limit", "50", "--db", ":memory:"
  ]);

  assert.equal(result.code, 0);
  assert.deepEqual(result.data.data.items.map((item) => item.id), [eligible.id]);
  assert.equal(result.data.data.next_after, null);
  assert.equal(result.opened[0].dbPath, ":memory:");
});

test("local inspect supplies a revision and note persists exactly once", async (t) => {
  const registry = openRegistry({ dbPath: ":memory:" });
  t.after(() => registry.close());
  const entry = fixture(registry, 201);
  const fetchPage = async (url) => ({ url, html: "<title>Fixture source</title>" });

  const inspected = await runLocal(registry, ["inspect", String(entry.id)], { fetchPage });
  const page = inspected.data.data;
  assert.equal(inspected.code, 0);
  assert.equal(page.id, entry.id);
  assert.match(page.expected, /^[a-f0-9]{64}$/);
  assert.equal(page.url, entry.url_original);

  const text = "- 확인한 제목: Fixture source\n- 원문 페이지에서 확인";
  const written = await runLocal(registry, [
    "note", String(entry.id), JSON.stringify({ expected: page.expected, text })
  ]);
  assert.equal(written.code, 0);
  assert.deepEqual(written.data.data.comment.body, text);
  assert.equal(registry.db.prepare("SELECT COUNT(*) AS count FROM entry_comments WHERE entry_id = ?").get(entry.id).count, 1);

  await assert.rejects(
    runLocal(registry, ["note", String(entry.id), JSON.stringify({ expected: page.expected, text })]),
    { code: "ENRICH_NOTE_EXISTS" }
  );
});

test("local notes reject missing expected and changed URL or policy", async (t) => {
  const registry = openRegistry({ dbPath: ":memory:" });
  t.after(() => registry.close());
  const first = fixture(registry, 301);
  await assert.rejects(
    runLocal(registry, ["note", String(first.id), JSON.stringify({ expected: "", text: "- missing revision" })]),
    { code: "ENRICH_INVALID_REQUEST" }
  );

  const changedUrlPage = (await runLocal(registry, ["inspect", String(first.id)], {
    fetchPage: async (url) => ({ url, html: "<title>Source</title>" })
  })).data.data;
  editEntry(registry, first.id, { url: "https://www.fmkorea.com/302" });
  await assert.rejects(
    runLocal(registry, ["note", String(first.id), JSON.stringify({ expected: changedUrlPage.expected, text: "- changed" })]),
    { code: "ENRICH_ENTRY_CHANGED" }
  );

  const policyEntry = fixture(registry, 303);
  const policyPage = (await runLocal(registry, ["inspect", String(policyEntry.id)], {
    fetchPage: async (url) => ({ url, html: "<title>Source</title>" })
  })).data.data;
  editEntry(registry, policyEntry.id, { visibility: "private" });
  await assert.rejects(
    runLocal(registry, ["note", String(policyEntry.id), JSON.stringify({ expected: policyPage.expected, text: "- blocked" })]),
    { code: "ENRICH_NOT_AVAILABLE" }
  );
});

test("local apply uses the current revision and existing extraction service", async (t) => {
  const registry = openRegistry({ dbPath: ":memory:" });
  t.after(() => registry.close());
  const entry = fixture(registry, 401);
  const expected = revisionKey(getEntry(registry, entry.id));
  const result = await runLocal(registry, [
    "apply", String(entry.id), JSON.stringify({
      expected, observed_at: "2026-09-08T00:00:00.000Z", fields: { title: "Observed title" }
    })
  ], { now: "2026-09-09T00:00:00.000Z" });

  assert.equal(result.code, 2);
  assert.equal(result.data.ok, true);
  assert.equal(getEntry(registry, entry.id).typed_metadata.enrichment.fields.title.value, "Observed title");

  await assert.rejects(
    runLocal(registry, [
      "apply", String(entry.id), JSON.stringify({
        expected, observed_at: "2026-09-07T00:00:00.000Z", fields: { title: "Older title" }
      })
    ], { now: "2026-09-09T00:00:00.000Z" }),
    { code: "ENRICH_ENTRY_CHANGED" }
  );
  await assert.rejects(
    runLocal(registry, [
      "apply", String(entry.id), JSON.stringify({
        expected, observed_at: "2026-09-09T00:00:00.000Z", fields: { title: "Valid", unknown: "rejected" }
      })
    ]),
    { code: "ENRICH_INVALID_FIELDS" }
  );
});

test("explicit broker mode does not open a local Registry", async () => {
  const calls = [];
  let output = "";
  const token = "t".repeat(32);
  const code = await main(["--broker", "list"], {
    WBH_AGENT_TOKEN: token,
    WBH_AGENT_URL: "http://127.0.0.2:3043"
  }, {
    openRegistry: () => { calls.push("opened"); throw new Error("local Registry must not open"); },
    fetch: async (input, init) => {
      calls.push({ input: String(input), init });
      return { json: async () => ({ ok: true, data: { items: [] } }) };
    },
    stdout: { write: (text) => { output += text; } }
  });

  assert.equal(code, 0);
  assert.equal(calls[0].input, "http://127.0.0.2:3043/v1/entries");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(output.includes("\"ok\": true"), true);
});
