"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  MAX_TRAILING_DELAY_MS,
  MIN_SCAN_INTERVAL_MS,
  createScanScheduler
} = require("../extension/selection-scan-scheduler.js");

test("two-second mutation storm causes at most eight full scans", () => {
  const clock = fakeClock();
  const scans = [];
  const scheduler = createScanScheduler({
    scan: () => scans.push(clock.now()),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer
  });
  assert.equal(MIN_SCAN_INTERVAL_MS, 250);
  assert.equal(MAX_TRAILING_DELAY_MS, 1_000);
  for (let elapsed = 0; elapsed < 2_000; elapsed += 10) {
    scheduler.trigger();
    clock.advance(10);
  }
  assert.equal(scans.length <= 8, true);
  assert.equal(scans.every((time, index) => index === 0 || time - scans[index - 1] >= 250), true);
});

test("a trailing candidate is scanned within one second and explicit rescan is immediate", () => {
  const clock = fakeClock();
  let candidateVisible = false;
  let selectedAt = null;
  let scans = 0;
  const scheduler = createScanScheduler({
    scan() {
      scans += 1;
      if (candidateVisible) selectedAt = clock.now();
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer
  });
  candidateVisible = true;
  const triggeredAt = clock.now();
  scheduler.trigger();
  clock.advance(1_000);
  assert.equal(selectedAt - triggeredAt <= 1_000, true);
  const before = scans;
  scheduler.runNow();
  assert.equal(scans, before + 1);
  assert.equal(selectedAt, clock.now());
});

test("cancelling drops pending work without affecting a later explicit scan", () => {
  const clock = fakeClock();
  let scans = 0;
  const scheduler = createScanScheduler({
    scan: () => { scans += 1; },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer
  });
  scheduler.trigger();
  scheduler.cancel();
  clock.advance(2_000);
  assert.equal(scans, 0);
  scheduler.runNow();
  assert.equal(scans, 1);
});

function fakeClock() {
  let current = 0;
  let nextId = 1;
  const timers = new Map();
  function now() { return current; }
  function setTimer(callback, delay) {
    const id = nextId++;
    timers.set(id, { at: current + delay, callback });
    return id;
  }
  function clearTimer(id) { timers.delete(id); }
  function advance(milliseconds) {
    const target = current + milliseconds;
    while (true) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!due) break;
      current = due[1].at;
      timers.delete(due[0]);
      due[1].callback();
    }
    current = target;
  }
  return { advance, clearTimer, now, setTimer };
}
