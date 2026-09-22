"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { openRegistry } = require("../registry/database.js");
const { createCapturePolicyRule } = require("../registry/capture-policy.js");
const { getEntry } = require("../registry/entries.js");
const { parseArguments } = require("../registry/cli-args.js");
const { handleEnrichment } = require("../enrichment/cli.js");
const { extractPage } = require("../enrichment/extract.js");
const { createFromUrl, applyExtraction, revisionKey } = require("../enrichment/service.js");
const Language = require("../web/ui-language.js");

const url = "https://smartstore.naver.com/synthetic/products/123456";
const product = { "@type": "Product", name: "Wrong product", offers: { price: "999", priceCurrency: "USD" } };
const script = (value) => `<script type="application/ld+json">${JSON.stringify(value)}</script>`;

test("enrichment ignores an entity declaring an unrelated or invalid URL", () => {
  for (const declared of ["https://unrelated.example.com/products/9", "http://["]) {
    const result = extractPage(script({ ...product, url: declared, "@id": "#product" }) + '<meta property="og:title" content="Actual page">', url);
    assert.equal(result.fields.title, "Actual page");
    assert.equal(result.fields.price, undefined);
  }
});

test("commented structured data and fake script titles cannot replace page facts", () => {
  const result = extractPage(`<!-- ${script(product)} --><script>const example = '<title>Wrong title</title>';</script><title>Actual page</title>`, url);
  assert.equal(result.fields.title, "Actual page");
  assert.equal(result.fields.price, undefined);
});

test("new enrichment Entries inherit the chosen rule tags", (t) => {
  const registry = openRegistry({ dbPath: ":memory:" });
  t.after(() => registry.close());
  createCapturePolicyRule(registry, { urlPrefix: "https://smartstore.naver.com/synthetic", visibility: "normal", agentAccess: "allowed", aiProcessing: "manual", tags: ["chosen"] });
  assert.deepEqual(createFromUrl(registry, url, { allowNew: true }).tags.map((tag) => tag.name), ["chosen"]);
});

test("invalid batch options cannot create a new Entry", async (t) => {
  const registry = openRegistry({ dbPath: ":memory:" });
  t.after(() => registry.close());
  for (const args of [["--limit", "0"], ["--mode", "unknown"], ["--site", "unknown"], ["--site", "steam"]]) {
    await assert.rejects(handleEnrichment(registry, parseArguments(["enrich", "run", "--url", url, "--allow-new", ...args])));
    assert.equal(registry.db.prepare("SELECT COUNT(*) AS n FROM entries").get().n, 0);
  }
});

test("an older inspection cannot overwrite a newer observation", (t) => {
  const registry = openRegistry({ dbPath: ":memory:" });
  t.after(() => registry.close());
  const entry = createFromUrl(registry, url, { allowNew: true });
  const expected = revisionKey(entry);
  applyExtraction(registry, entry.id, expected, { fields: { title: "New observation" }, observed_at: "2026-09-05T02:00:00.000Z" }, { now: "2026-09-05T02:00:00.000Z" });
  assert.throws(() => applyExtraction(registry, entry.id, expected, { fields: { title: "Old observation" }, observed_at: "2026-09-05T01:00:00.000Z" }, { now: "2026-09-05T03:00:00.000Z" }), { code: "ENRICH_ENTRY_CHANGED" });
  assert.equal(getEntry(registry, entry.id).typed_metadata.enrichment.fields.title.value, "New observation");
});

test("enrichment labels use the selected Korean dictionary", () => {
  assert.equal(Language.KO["enrichment.price"], "가격");
  assert.equal(Language.KO["enrichment.author"], "작성자");
});
