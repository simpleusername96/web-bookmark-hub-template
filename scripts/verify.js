#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const EXCLUDED_DIRECTORIES = new Set([
  ".git", ".web-bookmark-hub", "captures", "data", "node_modules", "outputs",
  "raw-templates", "registry-data", "runtime-data", "work"
]);

function verifyProject(rootPath = path.resolve(__dirname, ".."), options = {}) {
  const root = path.resolve(rootPath);
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("manifest must be an object");
  } catch (error) {
    return failure("manifest", `manifest.json is invalid: ${error.message}`);
  }

  const run = options.run || runNode;
  const javaScriptFiles = collectJavaScript(root);
  for (const file of javaScriptFiles) {
    const checked = run(["--check", file], { cwd: root, stdio: options.stdio || "pipe" });
    if (checked.status !== 0) return failure("syntax", outputOf(checked) || `Syntax check failed: ${file}`);
  }
  const testFiles = collectJavaScript(path.join(root, "test")).filter((file) => file.endsWith(".test.js"));
  if (testFiles.length) {
    const tested = run(["--test", ...testFiles], { cwd: root, stdio: options.stdio || "pipe" });
    if (tested.status !== 0) return failure("test", outputOf(tested) || "Tests failed.");
  }
  return { exitCode: 0, stage: "complete", checkedFiles: javaScriptFiles.length };
}

function collectJavaScript(root) {
  const found = [];
  function visit(directory) {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory() && excludedDirectory(entry.name)) continue;
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(candidate);
      else if (entry.isFile() && entry.name.endsWith(".js")) found.push(candidate);
    }
  }
  visit(root);
  return found;
}

function excludedDirectory(name) {
  return EXCLUDED_DIRECTORIES.has(name) || name.startsWith(".chrome-") || name.startsWith("tmp-");
}

function runNode(args, options) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, args, { ...options, env, encoding: "utf8" });
}

function outputOf(result) {
  return [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
}

function failure(stage, message) {
  return { exitCode: 1, stage, message };
}

if (require.main === module) {
  const result = verifyProject(path.resolve(__dirname, ".."), { stdio: "inherit" });
  if (result.exitCode === 0) process.stdout.write(`Verification passed (${result.checkedFiles} JavaScript files).\n`);
  else process.stderr.write(`Verification failed at ${result.stage}: ${result.message}\n`);
  process.exitCode = result.exitCode;
}

module.exports = { collectJavaScript, verifyProject };
