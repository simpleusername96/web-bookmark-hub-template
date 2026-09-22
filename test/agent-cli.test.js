"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { main } = require("../agent-cli.js");

test("agent CLI note posts the parsed ticket payload to the comments route", async () => {
  const previousFetch = global.fetch;
  const previousWrite = process.stdout.write;
  const calls = [];
  let output = "";
  const token = "t".repeat(32);
  const ref = "a".repeat(32);
  const payload = { text: "- 첫 번째 확인\n- 두 번째 확인", ticket: "ticket-1" };

  global.fetch = async (input, init) => {
    calls.push({ input: String(input), init });
    return { json: async () => ({ ok: true, data: {} }) };
  };
  process.stdout.write = (text) => { output += text; return true; };
  try {
    assert.equal(await main(["--broker", "note", ref, JSON.stringify(payload)], {
      WBH_AGENT_URL: "http://127.0.0.2:3043",
      WBH_AGENT_TOKEN: token
    }), 0);
  } finally {
    global.fetch = previousFetch;
    process.stdout.write = previousWrite;
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, `http://127.0.0.2:3043/v1/entries/${encodeURIComponent(ref)}/comments`);
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), payload);
  assert.equal(calls[0].init.headers.authorization, `Bearer ${token}`);
  assert.match(output, /"ok": true/);
});

test("agent CLI list forwards enrichment filters as a bodyless GET", async () => {
  const previousFetch = global.fetch;
  const previousWrite = process.stdout.write;
  const calls = [];
  const token = "t".repeat(32);
  let output = "";

  global.fetch = async (input, init) => {
    calls.push({ url: new URL(input), init });
    return { json: async () => ({ ok: true, data: { items: [] } }) };
  };
  process.stdout.write = (text) => { output += text; return true; };
  try {
    assert.equal(await main([
      "--broker", "list", "--saved-from", "2026-09-07T00:00:00+09:00", "--note", "empty",
      "--enrichable", "--limit", "50"
    ], {
      WBH_AGENT_URL: "http://127.0.0.2:3043",
      WBH_AGENT_TOKEN: token
    }), 0);
  } finally {
    global.fetch = previousFetch;
    process.stdout.write = previousWrite;
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, "/v1/entries");
  assert.equal(calls[0].url.searchParams.get("saved_from"), "2026-09-07T00:00:00+09:00");
  assert.equal(calls[0].url.searchParams.get("note"), "empty");
  assert.equal(calls[0].url.searchParams.get("enrichable"), "true");
  assert.equal(calls[0].url.searchParams.get("limit"), "50");
  assert.equal(calls[0].init.method, "GET");
  assert.equal("body" in calls[0].init, false);
  assert.match(output, /"ok": true/);
});
