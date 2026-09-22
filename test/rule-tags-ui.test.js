"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

function read(relative) {
  return fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
}

test("Rules Settings exposes editable URL-rule tags in production and demo shells", () => {
  for (const file of ["web/index.html", "web/demo.html"]) {
    const html = read(file);
    assert.match(html, /id="policy-rule-tags"/);
    assert.match(html, /Add Tags on future saves/);
  }
  const app = read("web/app.js");
  const settings = read("web/settings-controller.js");
  const styles = read("web/styles.css");
  assert.match(app, /policyRuleTags: document\.getElementById\("policy-rule-tags"\)/);
  assert.match(app, /attachTagSuggestions\(elements\.policyRuleTags\)/);
  assert.match(settings, /rule\.tags\.map/);
  assert.match(settings, /tags: elements\.policyRuleTags\.value/);
  assert.match(settings, /\['Add tags'/);
  assert.match(styles, /\.settings-dialog \{[^}]*width: min\(780px, calc\(100vw - 32px\)\);[^}]*overflow-y: auto;/);
});

test("server and capture pipeline carry rule tags without generic URL tokenization", () => {
  const server = read("server/capture-policy-api.js");
  const captures = read("registry/captures.js");
  const extractor = read("extension/capture-tag-suggestions.js");
  assert.match(server, /"tags"/);
  assert.match(captures, /policy\.defaultTags/);
  assert.match(captures, /resolvedTags/);
  assert.doesNotMatch(extractor, /pathname\.split|hostname\.split|searchParams\.keys/);
});
