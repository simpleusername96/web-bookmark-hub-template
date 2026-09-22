"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  BUDGETS,
  FORMAT,
  MAX_ENTRIES,
  measurement,
  parseArgs,
  runBenchmark
} = require("../scripts/benchmark-registry.js");

test("benchmark emits stable path-free JSON and exercises Notes", () => {
  const result = runBenchmark({ entries: 100, samples: 3 });
  assert.equal(result.format, FORMAT);
  assert.equal(result.entries, 100);
  assert.equal(result.notes, 100);
  assert.equal(result.samples, 3);
  assert.deepEqual(Object.keys(result.measurements), [
    "build", "first_page", "note_title_search", "folder_projection", "url_group_projection"
  ]);
  for (const [name, item] of Object.entries(result.measurements)) {
    assert.equal(Number.isFinite(item.median_ms), true);
    assert.equal(Number.isFinite(item.p95_ms), true);
    assert.equal(item.median_ms >= 0, true);
    assert.equal(item.p95_ms >= 0, true);
    assert.equal(item.budget_ms, BUDGETS[name]);
    assert.equal(item.passed, item.p95_ms <= item.budget_ms);
  }
  assert.equal(result.passed, Object.values(result.measurements).every((item) => item.passed));
  const json = JSON.stringify(result);
  assert.equal(json.includes("example.test"), false);
  assert.equal(/[A-Z]:\\|\/(?:tmp|home|Users)\//.test(json), false);
});

test("benchmark rejects unsupported scale and sample counts", () => {
  assert.equal(MAX_ENTRIES, 10_000);
  assert.throws(() => parseArgs(["--entries", "10001"]), /between 1 and 10000/);
  assert.throws(() => parseArgs(["--entries", "0"]), /between 1 and 10000/);
  assert.throws(() => parseArgs(["--samples", "0"]), /samples/);
  assert.throws(() => parseArgs(["--unknown"]), /Unknown option/);
});

test("benchmark percentile contract uses the nearest-rank p95 budget", () => {
  assert.deepEqual(measurement([5, 1, 4, 2, 3, 7, 6], 6), {
    median_ms: 4,
    p95_ms: 7,
    budget_ms: 6,
    passed: false
  });
  assert.deepEqual(measurement([6], 6), {
    median_ms: 6,
    p95_ms: 6,
    budget_ms: 6,
    passed: true
  });
});
