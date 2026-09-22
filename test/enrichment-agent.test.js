"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), http = require("node:http");
const { once } = require("node:events");
const { openRegistry } = require("../registry/database.js");
const { addEntry, editEntry, getEntry } = require("../registry/entries.js");
const { addComment } = require("../registry/comments.js");
const { createAgentHandler } = require("../enrichment/agent-api.js");
const token = "synthetic-agent-token-with-at-least-32-characters";
async function setup(t, settings = {}) {
  const registry = openRegistry({ dbPath: ":memory:" });
  const server = http.createServer(createAgentHandler(registry, { token, ...settings }));
  server.listen(0, "127.0.0.2"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); registry.close(); });
  const base = `http://127.0.0.2:${server.address().port}`;
  const request = async (path, body, headers = {}) => {
    const response = await fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, ...(await response.json()) };
  };
  const add = (id, extra = {}) => addEntry(registry, { url: `https://www.fmkorea.com/${id}`, title: `Fixture ${id}`, visibility: "normal", agentAccess: "allowed", aiProcessing: "manual", ...extra }).entry;
  return { registry, add, request };
}
test("agent authentication, owner endpoints, direct IDs and private lookup fail closed", async (t) => {
  const { add, request } = await setup(t, { scope: "enrich" });
  add(101); add(102, { visibility: "private", title: "SECRET-TITLE" }); add(103, { visibility: "private" });
  assert.equal((await request("/v1/entries", undefined, { authorization: "Bearer wrong" })).status, 401);
  assert.equal((await request("/v1/entries", undefined, { origin: "https://evil.example.com" })).status, 401);
  const out = await request("/v1/entries"); assert.equal(out.data.items.length, 1);
  assert.match(out.data.items[0].ref, /^[a-f0-9]{32}$/); assert.equal("id" in out.data.items[0], false); assert.equal("total" in out.data, false);
  assert.equal(JSON.stringify(out).includes("SECRET"), false);
  for (const path of ["/api/v1/entries", "/v1/entries/2", "/v1/entries/00000000000000000000000000000000", "/v1/entries/../../data/registry.sqlite3"]) assert.equal((await request(path)).ok, false);
});
test("metadata scope returns only allowed fields and denies every write/inspect path", async (t) => {
  let calls = 0;
  const { registry, add, request } = await setup(t, { scope: "metadata", allowNew: true, fetchPage: async () => { calls++; } });
  const e = add(101, { typedMetadata: { token: "NESTED-SECRET" } }); addComment(registry, e.id, "PRIVATE-NOTE");
  const list = await request("/v1/entries"), ref = list.data.items[0].ref;
  const output = JSON.stringify(list);
  for (const secret of ["https://", "NESTED-SECRET", "PRIVATE-NOTE"]) assert.equal(output.includes(secret), false);
  for (const action of ["inspect", "run", "apply"]) assert.equal((await request(`/v1/entries/${ref}/${action}`, {})).status, 404);
  assert.equal((await request("/v1/entries", { url: "https://www.fmkorea.com/222" })).status, 404);
  assert.equal(calls, 0);
});
test("legacy metadata-only corruption is enforced even with an enrichment-scoped token", async (t) => {
  const { registry, add, request } = await setup(t, { scope: "enrich" });
  const entry = add(101);
  registry.db.prepare("UPDATE entries SET agent_access = 'metadata_only', ai_processing = 'disabled' WHERE id = ?").run(entry.id);
  const list = await request("/v1/entries"), ref = list.data.items[0].ref;
  assert.equal("url" in list.data.items[0], false);
  assert.equal((await request(`/v1/entries/${ref}/inspect`, {})).status, 404);
});
test("inspect/apply uses expiring single-use tickets and cannot change policy or owner fields", async (t) => {
  const { registry, add, request } = await setup(t, { scope: "enrich", fetchPage: async (url) => ({ url, html: '<title>Fixture source</title>' }) });
  const e = add(101), ref = (await request("/v1/entries")).data.items[0].ref;
  const page = (await request(`/v1/entries/${ref}/inspect`, {})).data;
  assert.equal(page.content_role, "untrusted_source_data");
  assert.equal((await request(`/v1/entries/${ref}/apply`, { ticket: page.ticket, fields: { title: "Extracted" }, visibility: "normal" })).ok, false);
  assert.equal((await request(`/v1/entries/${ref}/apply`, { ticket: page.ticket, fields: { title: "Extracted", privateData: "NO" } })).ok, false);
  const applied = await request(`/v1/entries/${ref}/apply`, { ticket: page.ticket, fields: { title: "Extracted" } });
  assert.equal(applied.ok, true); assert.equal(getEntry(registry, e.id).title, "Fixture 101");
  assert.equal(getEntry(registry, e.id).typed_metadata.enrichment.fields.title.value, "Extracted");
  assert.deepEqual(applied.data.missing, ["image_url", "author", "published_at"]);
  assert.equal((await request(`/v1/entries/${ref}/apply`, { ticket: page.ticket, fields: { title: "Extracted" } })).error.code, "ENRICH_TICKET_EXPIRED");
});
test("previously visible references stop working after a privacy change", async (t) => {
  const { registry, add, request } = await setup(t, { scope: "enrich", fetchPage: async (url) => ({ url, html: '<title>Fixture source</title>' }) });
  const e = add(101), ref = (await request("/v1/entries")).data.items[0].ref;
  const page = (await request(`/v1/entries/${ref}/inspect`, {})).data;
  editEntry(registry, e.id, { visibility: "private" });
  assert.equal((await request(`/v1/entries/${ref}`)).status, 404);
  assert.equal((await request(`/v1/entries/${ref}/apply`, { ticket: page.ticket, fields: { title: "Changed" } })).status, 404);
  assert.deepEqual((await request("/v1/entries")).data.items, []);
});
test("new URL consent is owner-controlled and an existing private URL cannot be re-added", async (t) => {
  const { add, request } = await setup(t, { scope: "enrich", allowNew: true });
  add(101, { visibility: "private" });
  assert.equal((await request("/v1/entries", { url: "https://www.fmkorea.com/101" })).ok, false);
  const out = await request("/v1/entries", { url: "https://www.fmkorea.com/202" });
  assert.equal(out.data.access, "allowed"); assert.match(out.data.ref, /^[a-f0-9]{32}$/);
});

test("agent list filters inclusively by saved_from, empty notes and enrichable policy", async (t) => {
  const { registry, add, request } = await setup(t, { scope: "enrich" });
  add(101, { savedAt: "2026-09-07T00:00:00.000Z" });
  add(102, { savedAt: "2026-09-06T14:59:59.999Z" });
  add(103, { savedAt: "2026-09-08T00:00:00.000Z", visibility: "private" });
  add(104, { savedAt: "2026-09-08T00:00:00.000Z", visibility: "private" });
  const noted = add(105, { savedAt: "2026-09-08T00:00:00.000Z" });
  addComment(registry, noted.id, "already noted");
  const first = await request("/v1/entries?saved_from=2026-09-07T00:00:00%2B09:00&note=empty&enrichable=true&limit=1");
  assert.equal(first.ok, true); assert.equal(first.data.items.length, 1);
  assert.equal(first.data.items[0].saved_at, "2026-09-07T00:00:00.000Z");
  assert.match(first.data.items[0].ref, /^[a-f0-9]{32}$/); assert.equal("id" in first.data.items[0], false);
  assert.match(first.data.next_after, /^[a-f0-9]{32}$/);
  const second = await request(`/v1/entries?after=${first.data.next_after}&saved_from=2026-09-07T00:00:00%2B09:00&note=empty&enrichable=true&limit=1`);
  assert.deepEqual(second.data.items, []); assert.equal(second.data.next_after, null);
  for (const query of [
    "saved_from=2026-09-07",
    "saved_from=not-a-timestamp",
    "note=present",
    "enrichable=maybe"
  ]) {
    const invalid = await request(`/v1/entries?${query}`);
    assert.equal(invalid.status, 400, query); assert.equal(invalid.error.code, "ENRICH_INVALID_FILTER");
  }
});

test("agent note writeback stores one Korean multiline bullet note and consumes its inspection ticket", async (t) => {
  const { registry, add, request } = await setup(t, { scope: "enrich", fetchPage: async (url) => ({ url, html: "<title>Fixture source</title>" }) });
  const e = add(201), ref = (await request("/v1/entries")).data.items[0].ref;
  const page = (await request(`/v1/entries/${ref}/inspect`, {})).data;
  const text = "- 첫 번째 확인 내용\n- 두 번째 확인 내용";
  const written = await request(`/v1/entries/${ref}/comments`, { ticket: page.ticket, text });
  assert.equal(written.ok, true); assert.equal(written.data.ref, ref); assert.equal(written.data.comment.body, text);
  assert.equal(registry.db.prepare("SELECT COUNT(*) AS count FROM entry_comments WHERE entry_id = ?").get(e.id).count, 1);
  assert.equal((await request(`/v1/entries/${ref}/comments`, { ticket: page.ticket, text })).error.code, "ENRICH_TICKET_EXPIRED");
  assert.deepEqual((await request("/v1/entries?note=empty&enrichable=true")).data.items, []);
});

test("agent note writeback rejects scope, ticket, policy, URL, metadata and body failures", async (t) => {
  const metadata = await setup(t, { scope: "metadata" });
  metadata.add(250);
  const metadataRef = (await metadata.request("/v1/entries", undefined)).data.items[0].ref;
  assert.equal((await metadata.request(`/v1/entries/${metadataRef}/comments`, { ticket: "not-available", text: "- denied" })).status, 404);
  const { registry, add, request } = await setup(t, { scope: "enrich", fetchPage: async (url) => ({ url, html: "<title>Fixture source</title>" }) });
  const e = add(301), ref = (await request("/v1/entries")).data.items[0].ref;
  assert.equal((await request(`/v1/entries/${ref}/comments`, { text: "- missing ticket" })).error.code, "ENRICH_TICKET_EXPIRED");
  assert.equal((await request(`/v1/entries/${e.id}/comments`, { text: "- raw id" })).status, 404);
  const invalidPage = (await request(`/v1/entries/${ref}/inspect`, {})).data;
  assert.equal((await request(`/v1/entries/${ref}/comments`, { ticket: invalidPage.ticket, text: "" })).error.code, "ENRICH_INVALID_NOTE");
  const longPage = (await request(`/v1/entries/${ref}/inspect`, {})).data;
  assert.equal((await request(`/v1/entries/${ref}/comments`, { ticket: longPage.ticket, text: "x".repeat(20001) })).error.code, "ENRICH_INVALID_NOTE");
  const policyPage = (await request(`/v1/entries/${ref}/inspect`, {})).data;
  editEntry(registry, e.id, { visibility: "private" });
  assert.equal((await request(`/v1/entries/${ref}/comments`, { ticket: policyPage.ticket, text: "- blocked" })).status, 404);
  editEntry(registry, e.id, { visibility: "normal", url: "https://www.fmkorea.com/302" });
  const changedPage = (await request(`/v1/entries/${ref}/inspect`, {})).data;
  editEntry(registry, e.id, { url: "https://www.fmkorea.com/303" });
  assert.equal((await request(`/v1/entries/${ref}/comments`, { ticket: changedPage.ticket, text: "- changed" })).error.code, "ENRICH_ENTRY_CHANGED");
  const racePage = (await request(`/v1/entries/${ref}/inspect`, {})).data;
  addComment(registry, e.id, "another actor");
  assert.equal((await request(`/v1/entries/${ref}/comments`, { ticket: racePage.ticket, text: "- duplicate" })).error.code, "ENRICH_NOTE_EXISTS");
});
