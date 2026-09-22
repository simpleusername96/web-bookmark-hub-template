"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { Readable } = require("node:stream");
const { fetchPage } = require("../enrichment/fetch-page.js");
const url = "https://www.fmkorea.com/123456";
const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
function response(statusCode, body = "<title>Fixture</title>", headers = {}) {
  const stream = Readable.from([Buffer.from(body)]);
  stream.statusCode = statusCode; stream.headers = { "content-type": "text/html; charset=utf-8", ...headers }; return stream;
}
test("public HTML fetch is pinned and sends no cookies or authorization", async () => {
  let checks = 0;
  const out = await fetchPage(url, { lookup, beforeRequest: () => { checks++; }, request: async (args) => {
    assert.equal(args.address, "93.184.216.34"); assert.equal(args.headers.cookie, undefined); assert.equal(args.headers.authorization, undefined); return response(200);
  } });
  assert.equal(out.html, "<title>Fixture</title>"); assert.ok(checks >= 3);
});
test("DNS to private networks is rejected before transport", async () => {
  let calls = 0;
  await assert.rejects(fetchPage(url, { lookup: async () => [{ address: "127.0.0.1", family: 4 }], request: () => { calls++; } }), { code: "ENRICH_ADDRESS_BLOCKED" });
  assert.equal(calls, 0);
});
test("redirects cannot change item, site, HTTPS or reach a private address", async () => {
  for (const location of ["/999999", "https://127.0.0.1/", "https://www.coupang.com/vp/products/123456", "http://www.fmkorea.com/123456"]) {
    let calls = 0;
    await assert.rejects(fetchPage(url, { lookup, request: async () => { calls++; return response(302, "", { location }); } }));
    assert.equal(calls, 1);
  }
});
test("same-object redirect is bounded and every hop revalidates DNS", async () => {
  let hops = 0, lookups = 0;
  const out = await fetchPage(url, { lookup: async (...args) => { lookups++; return lookup(...args); }, request: async () => ++hops === 1 ? response(302, "", { location: "https://fmkorea.com/123456" }) : response(200) });
  assert.equal(out.url, "https://fmkorea.com/123456"); assert.equal(lookups, 2);
  await assert.rejects(fetchPage(url, { lookup, request: async () => response(302, "", { location: url }) }), { code: "ENRICH_REDIRECT_LIMIT" });
});
for (const [status, code] of [[403, "ACCESS_REQUIRED"], [429, "RATE_LIMITED"], [404, "NOT_FOUND"], [410, "NOT_FOUND"], [500, "HTTP_ERROR"]]) {
  test(`HTTP ${status} has a stable outcome`, async () => {
    await assert.rejects(fetchPage(url, { lookup, request: async () => response(status) }), { code: `ENRICH_${code}` });
  });
}
test("wrong MIME, oversized header/body, invalid bytes and compression are bounded errors", async () => {
  for (const [r, code] of [
    [response(200, "binary", { "content-type": "image/png" }), "NOT_HTML"],
    [response(200, "", { "content-length": "9000000" }), "TOO_LARGE"],
    [response(200, "x".repeat(2 * 1024 * 1024 + 1)), "TOO_LARGE"],
    [response(200, "x", { "content-encoding": "gzip" }), "ENCODING"],
    [response(200, Buffer.from([0xff, 0xfe, 0xff])), "ENCODING"]
  ]) await assert.rejects(fetchPage(url, { lookup, request: async () => r }), { code: `ENRICH_${code}` });
});
test("hung DNS and hung response stream use the same deadline", async () => {
  await assert.rejects(fetchPage(url, { timeoutMs: 10, lookup: () => new Promise(() => {}) }), { code: "ENRICH_TIMEOUT" });
  const stuck = new Readable({ read() {} }); stuck.statusCode = 200; stuck.headers = { "content-type": "text/html" };
  await assert.rejects(fetchPage(url, { timeoutMs: 10, lookup, request: async () => stuck }), { code: "ENRICH_TIMEOUT" });
});
