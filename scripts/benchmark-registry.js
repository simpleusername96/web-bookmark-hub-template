#!/usr/bin/env node
"use strict";

const { performance } = require("node:perf_hooks");

const { addComment } = require("../registry/comments.js");
const { openRegistry } = require("../registry/database.js");
const { addEntry, listEntries } = require("../registry/entries.js");
const { createFolder } = require("../registry/folders.js");
const { getSidebarFolderTree, listSidebarUrlGroups } = require("../registry/sidebar-projections.js");

const FORMAT = "web-bookmark-hub/registry-benchmark/v1";
const MAX_ENTRIES = 10_000;
const BUDGETS = Object.freeze({
  build: 60_000,
  first_page: 250,
  note_title_search: 250,
  folder_projection: 250,
  url_group_projection: 750
});

function runBenchmark({ entries = 10_000, samples = 7 } = {}) {
  validateInputs(entries, samples);
  const registry = openRegistry({ dbPath: ":memory:" });
  try {
    const buildStarted = performance.now();
    const folders = Array.from({ length: 10 }, (_, index) => createFolder(registry, { name: `Folder ${index + 1}` }));
    const noteCount = Math.min(1_000, entries);
    for (let index = 0; index < entries; index += 1) {
      const entry = addEntry(registry, {
        url: `https://group-${index % 50}.example.test/collection/${index % 10}/item/${index}`,
        title: index % 25 === 0 ? `Needle title ${index}` : `Synthetic title ${index}`,
        savedAt: syntheticTimestamp(index),
        folderId: folders[index % folders.length].id,
        visibility: "normal",
        agentAccess: "metadata_only",
        aiProcessing: "disabled"
      }).entry;
      if (index < noteCount) addComment(registry, entry.id, `Needle note ${index}`);
    }
    const buildMs = performance.now() - buildStarted;
    const reads = {
      first_page: () => listEntries(registry, { page: 1, pageSize: 50 }),
      note_title_search: () => listEntries(registry, { search: "needle", page: 1, pageSize: 50 }),
      folder_projection: () => getSidebarFolderTree(registry, { search: "needle" }),
      url_group_projection: () => listSidebarUrlGroups(registry, { search: "needle" })
    };
    Object.values(reads).forEach((read) => read());
    const measurements = {
      build: measurement([buildMs], BUDGETS.build)
    };
    for (const [name, read] of Object.entries(reads)) {
      const durations = [];
      for (let sample = 0; sample < samples; sample += 1) {
        const started = performance.now();
        read();
        durations.push(performance.now() - started);
      }
      measurements[name] = measurement(durations, BUDGETS[name]);
    }
    const passed = Object.values(measurements).every((item) => item.passed);
    return {
      format: FORMAT,
      entries,
      notes: noteCount,
      samples,
      passed,
      measurements
    };
  } finally {
    registry.close();
  }
}

function measurement(values, budgetMs) {
  const sorted = values.slice().sort((left, right) => left - right);
  const median = percentile(sorted, 0.5);
  const p95 = percentile(sorted, 0.95);
  return {
    median_ms: round(median),
    p95_ms: round(p95),
    budget_ms: budgetMs,
    passed: p95 <= budgetMs
  };
}

function percentile(sorted, fraction) {
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function parseArgs(argv) {
  const result = { entries: 10_000, samples: 7, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") result.json = true;
    else if (["--entries", "--samples"].includes(argument)) {
      if (argv[index + 1] === undefined) throw new Error(`${argument} requires a value`);
      result[argument.slice(2)] = Number(argv[index + 1]);
      index += 1;
    } else throw new Error(`Unknown option: ${argument}`);
  }
  validateInputs(result.entries, result.samples);
  return result;
}

function validateInputs(entries, samples) {
  if (!Number.isSafeInteger(entries) || entries < 1 || entries > MAX_ENTRIES) {
    throw new RangeError(`entries must be between 1 and ${MAX_ENTRIES}`);
  }
  if (!Number.isSafeInteger(samples) || samples < 1 || samples > 25) {
    throw new RangeError("samples must be between 1 and 25");
  }
}

function syntheticTimestamp(index) {
  return new Date(Date.UTC(2025, 0, 1) + index * 1_000).toISOString();
}

function round(value) {
  return Math.round(value * 1_000) / 1_000;
}

if (require.main === module) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = runBenchmark(options);
    process.stdout.write(`${JSON.stringify(result, null, options.json ? 0 : 2)}\n`);
    process.exitCode = result.passed ? 0 : 1;
  } catch (error) {
    process.stderr.write(`Benchmark failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { BUDGETS, FORMAT, MAX_ENTRIES, measurement, parseArgs, runBenchmark };
