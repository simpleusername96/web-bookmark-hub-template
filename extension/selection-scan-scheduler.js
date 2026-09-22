(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.WBHSelectionScanScheduler = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const MIN_SCAN_INTERVAL_MS = 250;
  const MAX_TRAILING_DELAY_MS = 1_000;

  function createScanScheduler(options) {
    const scan = options?.scan;
    if (typeof scan !== "function") throw new TypeError("scan scheduler requires a scan function");
    const now = options.now || Date.now;
    const setTimer = options.setTimer || setTimeout;
    const clearTimer = options.clearTimer || clearTimeout;
    const minInterval = positive(options.minInterval, MIN_SCAN_INTERVAL_MS);
    const maxDelay = positive(options.maxDelay, MAX_TRAILING_DELAY_MS);
    let timer = null;
    let pending = false;
    let firstPendingAt = null;
    let lastRunAt = null;

    function trigger() {
      const current = now();
      if (!pending) {
        pending = true;
        firstPendingAt = current;
      }
      schedule(current);
    }

    function schedule(current = now()) {
      if (!pending || timer !== null) return;
      const intervalTarget = lastRunAt === null ? current + minInterval : lastRunAt + minInterval;
      const deadline = firstPendingAt + maxDelay;
      const target = Math.min(Math.max(current, intervalTarget), deadline);
      timer = setTimer(runScheduled, Math.max(0, target - current));
    }

    function runScheduled() {
      timer = null;
      if (!pending) return;
      pending = false;
      firstPendingAt = null;
      lastRunAt = now();
      scan();
    }

    function runNow() {
      if (timer !== null) clearTimer(timer);
      timer = null;
      pending = false;
      firstPendingAt = null;
      lastRunAt = now();
      return scan();
    }

    function cancel() {
      if (timer !== null) clearTimer(timer);
      timer = null;
      pending = false;
      firstPendingAt = null;
      lastRunAt = null;
    }

    return { cancel, runNow, trigger };
  }

  function positive(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  return { MAX_TRAILING_DELAY_MS, MIN_SCAN_INTERVAL_MS, createScanScheduler };
}));
