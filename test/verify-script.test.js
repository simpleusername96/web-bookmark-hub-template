"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { verifyProject } = require("../scripts/verify.js");

test("verification fails first at an invalid manifest", () => {
  withFixture((root) => {
    fs.writeFileSync(path.join(root, "manifest.json"), "not json");
    fs.writeFileSync(path.join(root, "bad.js"), "function {");
    const result = verifyProject(root);
    assert.equal(result.exitCode, 1);
    assert.equal(result.stage, "manifest");
  });
});

test("verification fails at JavaScript syntax before tests", () => {
  withFixture((root) => {
    writeManifest(root);
    fs.writeFileSync(path.join(root, "bad.js"), "function {");
    fs.writeFileSync(path.join(root, "later.test.js"), "throw new Error('must not run');\n");
    const result = verifyProject(root);
    assert.equal(result.exitCode, 1);
    assert.equal(result.stage, "syntax");
  });
});

test("verification propagates a failing test and accepts a valid fixture", () => {
  withFixture((root) => {
    writeManifest(root);
    fs.mkdirSync(path.join(root, "test"));
    const testPath = path.join(root, "test", "sample.test.js");
    fs.writeFileSync(testPath, "'use strict'; require('node:test')('fails', () => { throw new Error('synthetic'); });\n");
    assert.equal(verifyProject(root).stage, "test");
    fs.writeFileSync(testPath, "'use strict'; require('node:test')('passes', () => {});\n");
    assert.deepEqual(verifyProject(root), { exitCode: 0, stage: "complete", checkedFiles: 1 });
  });
});

test("verification ignores disposable trees and runs only maintained tests", () => {
  withFixture((root) => {
    writeManifest(root);
    fs.writeFileSync(path.join(root, "source.js"), "'use strict';\n");
    fs.mkdirSync(path.join(root, "test"));
    fs.writeFileSync(path.join(root, "test", "maintained.test.js"), "'use strict'; require('node:test')('passes', () => {});\n");
    ["node_modules", "work", "outputs", "captures", "raw-templates", "runtime-data", ".web-bookmark-hub", "registry-data", ".chrome-profile", "tmp-scratch"].forEach((name) => {
      const directory = path.join(root, name);
      fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory, "broken.js"), "function {\n");
      fs.writeFileSync(path.join(directory, "ignored.test.js"), "throw new Error('must not run');\n");
    });
    assert.deepEqual(verifyProject(root), { exitCode: 0, stage: "complete", checkedFiles: 2 });
  });
});

test("verification still rejects a broken maintained test", () => {
  withFixture((root) => {
    writeManifest(root);
    fs.mkdirSync(path.join(root, "test"));
    fs.writeFileSync(path.join(root, "test", "maintained.test.js"), "'use strict'; require('node:test')('fails', () => { throw new Error('maintained'); });\n");
    assert.equal(verifyProject(root).stage, "test");
  });
});

function withFixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wbh-verify-"));
  try { run(root); } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); }
}

function writeManifest(root) {
  fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify({ manifest_version: 3 }));
}
