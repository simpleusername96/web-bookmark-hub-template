"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { openRegistry } = require("../registry/database.js");
const { addEntry, getEntry, editEntry, listEntries } = require("../registry/entries.js");
const { addComment } = require("../registry/comments.js");
const { addTags, removeTags } = require("../registry/tags.js");
const { addRemoteImageReference, listVisualAssets, removeVisualAsset } = require("../registry/visual-assets.js");
const { createCapturePolicyRule } = require("../registry/capture-policy.js");
const { executeCli } = require("../registry/cli.js");
const { matchTemplate, requireTemplate } = require("../enrichment/templates.js");
const { extractPage, normalizeFields } = require("../enrichment/extract.js");
const { agentProjection, agentList, createFromUrl, planEntries, applyExtraction, enrichEntry, revisionKey, runEntries } = require("../enrichment/service.js");
const Card = require("../web/card-presentation.js");
const URLS = [
  "https://smartstore.naver.com/synthetic/products/123456", "https://www.coupang.com/vp/products/123456",
  "https://gall.dcinside.com/mgallery/board/view/?id=synthetic&no=123456", "https://www.fmkorea.com/123456",
  "https://store.steampowered.com/app/123456/Synthetic/", "https://synthetic.itch.io/fixture-game"
];
const product = { "@context": "https://schema.org", "@type": "Product", name: "Synthetic product", image: "https://images.example.com/product.jpg", offers: { "@type": "Offer", price: "12000", priceCurrency: "KRW" } };
const html = (v = product) => `<html><head><script type="application/ld+json">${JSON.stringify(v)}</script></head></html>`;
const add = (r, extra = {}) => addEntry(r, { url: URLS[0], visibility: "normal", agentAccess: "allowed", aiProcessing: "manual", ...extra }).entry;
const fixture = (body = html()) => async (url) => ({ html: body, url, http_status: 200 });
function db(t) { const r = openRegistry({ dbPath: ":memory:" }); t.after(() => r.close()); return r; }

for (const [i, site] of ["naver", "coupang", "dcinside", "fmkorea", "steam", "itch"].entries()) {
  test(`${site}: detail matching and reusable metadata extraction`, () => {
    assert.equal(requireTemplate(URLS[i]).id, site);
    const page = i === 2 || i === 3 ? { "@type": "DiscussionForumPosting", headline: "Synthetic post", author: { name: "Fixture author" }, datePublished: "2026-01-01T12:00:00+09:00" } : product;
    const out = extractPage(html(page), URLS[i]);
    assert.ok(out.fields.title);
    if (i === 2 || i === 3) assert.equal(out.fields.published_at, "2026-01-01T03:00:00.000Z");
    else assert.deepEqual(out.fields.price, { amount: "12000", currency: "KRW", qualifier: "exact" });
  });
}
test("list/short/login/bundle/unrelated and lookalike URLs are not detail templates", () => {
  for (const u of ["https://www.coupang.com/np/search?q=test", "https://link.coupang.com/a/fixture", "https://shopping.naver.com/", "https://gall.dcinside.com/board/lists?id=test", "https://www.fmkorea.com/index.php?mid=hot", "https://store.steampowered.com/sub/1/", "https://synthetic.itch.io/game/devlog/12", "https://store.steampowered.com.evil.com/app/1", "https://user:pass@www.fmkorea.com/1", "file:///tmp/private"]) assert.equal(matchTemplate(u), null, u);
});
test("identity preserves Coupang options and Steam region, but normalizes DC mobile aliases", () => {
  assert.notEqual(requireTemplate(URLS[1] + "?vendorItemId=1").objectKey, requireTemplate(URLS[1] + "?vendorItemId=2").objectKey);
  assert.notEqual(requireTemplate(URLS[4] + "?cc=kr").objectKey, requireTemplate(URLS[4] + "?cc=us").objectKey);
  assert.equal(requireTemplate(URLS[2]).objectKey, requireTemplate("https://m.dcinside.com/board/synthetic/123456").objectKey);
});
test("broken JSON-LD falls back to OG without running scripts or collecting body text", () => {
  const out = extractPage('<script type="application/ld+json">{bad</script><meta content="A &amp; B" property="og:title"><p>not retained</p>', URLS[0]);
  assert.equal(out.fields.title, "A & B"); assert.ok(out.warnings.includes("invalid_json_ld")); assert.equal(out.fields.price, undefined);
  assert.equal(JSON.stringify(out).includes("not retained"), false);
});
test("fake metadata inside script text or comments is not page metadata", () => {
  const out = extractPage('<head><!-- <meta property="og:title" content="wrong"> --><script>const s=`<meta property="og:title" content="wrong">`;</script><meta property="og:title" content="right"></head>', URLS[0]);
  assert.equal(out.fields.title, "right");
});
test("prices: absent is not free, explicit zero is zero, aggregates are from, ambiguity is not guessed", () => {
  assert.equal(extractPage('<title>Game</title>', URLS[4]).fields.price, undefined);
  assert.equal(extractPage(html({ ...product, offers: { price: "0", priceCurrency: "USD" } }), URLS[4]).fields.price.amount, "0");
  assert.equal(extractPage(html({ ...product, offers: { "@type": "AggregateOffer", lowPrice: "10", priceCurrency: "USD" } }), URLS[0]).fields.price.qualifier, "from");
  const ambiguous = extractPage(html({ ...product, offers: [{ price: "10", priceCurrency: "USD" }, { price: "20", priceCurrency: "USD" }] }), URLS[0]);
  assert.equal(ambiguous.fields.price, undefined); assert.ok(ambiguous.warnings.includes("ambiguous_offers"));
  assert.equal(extractPage(html({ ...product, offers: { price: "10" } }), URLS[0]).fields.price, undefined);
});
test("Coupang selected option price needs an exact offer URL", () => {
  const url = URLS[1] + "?itemId=11&vendorItemId=22";
  assert.equal(extractPage(html(), url).fields.price, undefined);
  const out = extractPage(html({ ...product, offers: { ...product.offers, url } }), url);
  assert.equal(out.fields.price.amount, "12000");
});
test("multiple products require object identity; a sole explicit other-product reference is not selected", () => {
  const other = { ...product, name: "Wrong", url: "https://smartstore.naver.com/synthetic/products/999999" };
  const right = { ...product, name: "Right", url: URLS[0] };
  assert.equal(extractPage(html({ "@graph": [other, right] }), URLS[0]).fields.title, "Right");
  assert.equal(extractPage(html(other), URLS[0]).fields.price, undefined);
});
test("challenge, unsafe images, invalid dates and oversized pages fail predictably", () => {
  assert.throws(() => extractPage('<title>Access Denied</title>', URLS[0]), { code: "ENRICH_ACCESS_REQUIRED" });
  assert.throws(() => extractPage("x".repeat(2 * 1024 * 1024 + 1), URLS[0]), { code: "ENRICH_TOO_LARGE" });
  for (const image of ["http://example.com/a.jpg", "https://127.0.0.1/a", "https://169.254.169.254/a", "data:image/png,xx", "https://localhost/a"]) assert.equal(normalizeFields({ image_url: image }, URLS[0]).image_url, undefined);
  assert.equal(normalizeFields({ published_at: "2026-01-01 12:00" }, URLS[2]).published_at, undefined);
  assert.throws(() => normalizeFields({ visibility: "normal" }, URLS[0]), { code: "ENRICH_INVALID_FIELDS" });
});
test("Private and inconsistent legacy mirrors fail before fetch; no hidden records in plans", async (t) => {
  const r = db(t); let calls = 0;
  const cases = [
    { visibility: "private" },
    { field: "agent_access", value: "blocked" },
    { field: "agent_access", value: "metadata_only" },
    { field: "ai_processing", value: "disabled" }
  ];
  for (let i = 0; i < cases.length; i++) {
    const e = add(r, { url: URLS[i], visibility: cases[i].visibility || "normal" });
    if (cases[i].field) r.db.prepare(`UPDATE entries SET ${cases[i].field} = ? WHERE id = ?`).run(cases[i].value, e.id);
    await assert.rejects(enrichEntry(r, e.id, { fetchPage: async () => { calls++; } }), { code: "ENRICH_NOT_AVAILABLE" });
  }
  assert.equal(calls, 0); assert.equal(planEntries(r).items.length, 0);
});
test("legacy metadata-only defense excludes nested JSON, source URL, notes, assets and totals", (t) => {
  const r = db(t), e = add(r, { typedMetadata: { secret: "private-note", nested: { url: "https://private.example.com" } } });
  r.db.prepare("UPDATE entries SET agent_access = 'metadata_only' WHERE id = ?").run(e.id);
  addComment(r, e.id, "secret-comment"); addTags(r, e.id, ["secret-folder-tag"]);
  add(r, { url: URLS[1], visibility: "private", title: "PRIVATE-TITLE" });
  const result = agentList(r);
  assert.equal(result.items.length, 1);
  const output = JSON.stringify(result);
  for (const secret of ["https://", "private-note", "secret-comment", "secret-folder-tag", "PRIVATE-TITLE", '"total"']) assert.equal(output.includes(secret), false, secret);
  assert.deepEqual(Object.keys(agentProjection(getEntry(r, e.id))), ["id", "title", "kind", "saved_at", "access"]);
});
test("merge protects authored fields, existing JSON and manual cover; repeated data is unchanged", async (t) => {
  const r = db(t), e = add(r, { title: "My title", typedMetadata: { personal: { keep: true } } });
  addTags(r, e.id, ["mine"]); addComment(r, e.id, "note");
  const cover = addRemoteImageReference(r, e.id, "https://images.example.com/manual.jpg", { sourceKind: "browser_selected" }).asset;
  const options = { fetchPage: fixture(), now: "2026-09-05T01:00:00.000Z" };
  assert.equal((await enrichEntry(r, e.id, options)).status, "complete");
  const current = getEntry(r, e.id);
  assert.equal(current.title, "My title"); assert.deepEqual(current.typed_metadata.personal, { keep: true }); assert.equal(current.cover_image.id, cover.id);
  assert.deepEqual(current.tags.map((v) => v.name).sort(), ["mine", "shopping"]);
  assert.equal(listVisualAssets(r, e.id).length, 1);
  assert.equal((await enrichEntry(r, e.id, options)).outcome, "unchanged");
  removeTags(r, e.id, ["shopping"]);
  await enrichEntry(r, e.id, options);
  assert.equal(getEntry(r, e.id).tags.some((v) => v.name === "shopping"), false);
});
test("price failure keeps the previous value/time as stale; a later success clears staleness", async (t) => {
  const r = db(t), e = add(r);
  await enrichEntry(r, e.id, { fetchPage: fixture(), now: "2026-09-05T01:00:00.000Z" });
  await enrichEntry(r, e.id, { fetchPage: fixture('<meta property="og:title" content="New title">'), now: "2026-09-05T02:00:00.000Z" });
  let current = getEntry(r, e.id), price = current.typed_metadata.enrichment.fields.price;
  assert.equal(price.value.amount, "12000"); assert.equal(price.observed_at, "2026-09-05T01:00:00.000Z"); assert.equal(price.stale, true);
  await enrichEntry(r, e.id, { fetchPage: fixture(), now: "2026-09-05T03:00:00.000Z" });
  assert.equal(getEntry(r, e.id).typed_metadata.enrichment.fields.price.stale, false);
});
test("policy changes, changed URLs and deletion during fetch prevent writeback", async (t) => {
  const r = db(t);
  for (const action of ["private", "url", "delete"]) {
    const e = add(r, { url: `https://www.fmkorea.com/${10 + r.db.prepare('SELECT COUNT(*) n FROM entries').get().n}` });
    const fetch = async (url) => {
      if (action === "private") editEntry(r, e.id, { visibility: "private" });
      if (action === "url") editEntry(r, e.id, { url: "https://www.fmkorea.com/99999" });
      if (action === "delete") r.db.prepare("DELETE FROM entries WHERE id=?").run(e.id);
      return { url, html: '<title>Changed</title>' };
    };
    await assert.rejects(enrichEntry(r, e.id, { fetchPage: fetch }), (error) => ["ENRICH_NOT_AVAILABLE", "ENRICH_ENTRY_CHANGED"].includes(error.code));
  }
});
test("concurrent unrelated metadata edit is preserved", async (t) => {
  const r = db(t), e = add(r);
  await enrichEntry(r, e.id, { fetchPage: async (url) => { editEntry(r, e.id, { typedMetadata: { concurrent: "keep" } }); return { url, html: html() }; } });
  assert.equal(getEntry(r, e.id).typed_metadata.concurrent, "keep");
});
test("explicit URL creation requires consent and never overrides an existing private Entry or URL rule", (t) => {
  const r = db(t);
  assert.throws(() => createFromUrl(r, URLS[0]), { code: "ENRICH_NEW_URL_REQUIRES_CONSENT" });
  const e = createFromUrl(r, URLS[0], { allowNew: true });
  assert.equal(e.visibility, "normal"); assert.equal(e.agent_access, "allowed");
  assert.equal(e.ai_processing, "enabled");
  editEntry(r, e.id, { visibility: "private" });
  assert.throws(() => createFromUrl(r, URLS[0], { allowNew: true }), { code: "ENRICH_NOT_AVAILABLE" });
  createCapturePolicyRule(r, { urlPrefix: "https://www.coupang.com/vp", visibility: "private", agentAccess: "blocked", aiProcessing: "disabled" });
  assert.throws(() => createFromUrl(r, URLS[1], { allowNew: true }), { code: "ENRICH_NOT_AVAILABLE" });
});
test("pending/retry/refresh are bounded; 429 pauses a site but other sites continue", async (t) => {
  const r = db(t); add(r); add(r, { url: "https://smartstore.naver.com/synthetic/products/123457" }); add(r, { url: URLS[5] });
  let calls = 0;
  const { RegistryError } = require("../registry/errors.js");
  const out = await runEntries(r, { fetchPage: async (url) => { calls++; if (url.includes("naver")) throw new RegistryError("ENRICH_RATE_LIMITED", "429"); return { url, html: html() }; } });
  assert.equal(calls, 2); assert.equal(out.results[1].status, "deferred"); assert.equal(out.results[2].status, "complete");
  assert.equal(planEntries(r, { mode: "retry" }).items.length, 1);
  assert.equal(planEntries(r).items.length, 1);
  assert.equal(planEntries(r, { mode: "refresh", limit: 2 }).items.length, 2);
});
test("extracted product facts remain available without card-title or search promotion", async (t) => {
  const r = db(t), e = add(r);
  await enrichEntry(r, e.id, { fetchPage: fixture() });
  let current = getEntry(r, e.id);
  assert.equal(Card.describe(current).title, ""); assert.equal(Card.enrichmentFacts(current)[0].key, "enrichment.price");
  assert.equal(listEntries(r, { search: "Synthetic product" }).total, 0);
  editEntry(r, e.id, { title: "Manual" }); assert.equal(Card.describe(getEntry(r, e.id)).title, "Manual");
  editEntry(r, e.id, { url: URLS[1] }); current = getEntry(r, e.id);
  assert.equal(Card.enrichmentFacts(current).length, 0); assert.equal(listEntries(r, { search: "Synthetic product" }).total, 0);
});
test("CLI discovers templates and plan does not fetch or add an Entry", async () => {
  const templates = await executeCli(["enrich", "templates", "--db", ":memory:"]);
  assert.equal(templates.data.templates.length, 6);
  const planned = await executeCli(["enrich", "plan", "--url", URLS[0], "--db", ":memory:"]);
  assert.equal(planned.data.new_url, true); assert.deepEqual(planned.data.items, []);
  await assert.rejects(executeCli(["enrich", "plan", "--entry", "0", "--db", ":memory:"]));
});


test("invalid structured fields do not prevent a valid lower-priority fallback", () => {
  const malformed = { ...product, name: { invalid: true }, image: "javascript:bad", url: "http://[" };
  const out = extractPage(html(malformed).replace("</head>", '<meta property="og:title" content="Valid title"><meta property="og:image:secure_url" content="data:image/png,xx"><meta property="og:image" content="https://images.example.com/fallback.jpg"></head>'), URLS[0]);
  assert.equal(out.fields.title, "Valid title");
  assert.equal(out.fields.image_url, "https://images.example.com/fallback.jpg");
});

test("first failed attempt still permits one category addition on recovery", async (t) => {
  const r = db(t), e = add(r);
  await enrichEntry(r, e.id, { fetchPage: fixture("<title>Access Denied</title>") });
  assert.equal(getEntry(r, e.id).tags.length, 0);
  await enrichEntry(r, e.id, { fetchPage: fixture() });
  assert.equal(getEntry(r, e.id).tags.some((v) => v.name === "shopping"), true);
  removeTags(r, e.id, ["shopping"]);
  await enrichEntry(r, e.id, { fetchPage: fixture() });
  assert.equal(getEntry(r, e.id).tags.some((v) => v.name === "shopping"), false);
});
