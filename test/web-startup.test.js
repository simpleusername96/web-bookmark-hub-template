"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("production Web scripts exist, defer in dependency order, and keep guarded startup", () => {
  const webRoot = path.join(__dirname, "..", "web");
  const html = fs.readFileSync(path.join(webRoot, "index.html"), "utf8");
  const scripts = Array.from(html.matchAll(/<script src="([^"?]+)(?:\?[^"]*)?" defer><\/script>/g), (match) => match[1]);
  assert.deepEqual(scripts, [
    "ui-icons.js", "ui-language.js", "content-types.js", "api-source.js", "query-state.js", "sort-model.js",
    "settings-controller.js", "results-view.js", "detail-presentation.js", "card-presentation.js",
    "detail-view.js", "detail-navigation.js", "tag-suggestions.js", "view.js", "sidebar-navigation.js", "responsive-workflows.js", "selection-actions.js", "app.js"
  ]);
  scripts.forEach((file) => assert.equal(fs.existsSync(path.join(webRoot, file)), true, `${file} is missing`));
  const app = fs.readFileSync(path.join(webRoot, "app.js"), "utf8");
  assert.match(app, /if \(document\.readyState === "loading"\)/);
  assert.match(app, /document\.addEventListener\("DOMContentLoaded", start, \{ once: true \}\)/);
  assert.match(app, /const View = global\.WBHView/);
  assert.match(app, /elements\.folderCreateForm\?\.addEventListener/);
  assert.match(app, /classList\.contains\("is-mobile-sidebar-open"\)/);
  assert.match(app, /const demoMode = source\.baseUrl === "demo:\/\/synthetic\/"/);
  assert.match(app, /DetailNavigation\.locationEntryId\(raw, demoMode\)/);
  const bootstrap = app.slice(app.indexOf("void (async function bootstrap()"));
  assert.ok(bootstrap.indexOf("const extensionId = connectionRequestId()") < bootstrap.indexOf("try {"));
  assert.ok(bootstrap.indexOf("settingsController.requestChromeApproval(extensionId)") > bootstrap.indexOf("} catch (error) {"));
  assert.equal(scripts.at(-1), "app.js");
});


test("synthetic demo keeps the full production shell and substitutes only the data source", () => {
  const webRoot = path.join(__dirname, "..", "web");
  const production = fs.readFileSync(path.join(webRoot, "index.html"), "utf8");
  const demo = fs.readFileSync(path.join(webRoot, "demo.html"), "utf8");
  assert.equal(demo.slice(demo.indexOf("  <body>")), production.slice(production.indexOf("  <body>")));
  assert.doesNotMatch(demo, /src="api-source/);
  assert.match(demo, /src="demo-boot/);
  assert.doesNotMatch(production, /src="(?:demo|preview|redesign)-/);
});
