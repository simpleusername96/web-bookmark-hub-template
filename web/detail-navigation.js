(function exposeDetailNavigation(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.WBHDetailNavigation = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function detailNavigationFactory() {
  "use strict";

  function navigationState(input) {
    const state = input || {};
    const items = Array.isArray(state.items) ? state.items : [];
    const entryIdentity = normalizedIdentity(state.entryId);
    const index = entryIdentity === null
      ? -1
      : items.findIndex((item) => normalizedIdentity(item?.id) === entryIdentity);
    if (index < 0) return { previous: false, next: false, index: -1 };
    const view = state.view === "feed" ? "feed" : "paged";
    const page = positiveInteger(state.page, 1);
    const totalPages = Math.max(page, positiveInteger(state.totalPages, page));
    return {
      index,
      previous: index > 0 || (view === "paged" && page > 1),
      next: index < items.length - 1 || (view === "feed" ? state.feedHasMore === true : page < totalPages)
    };
  }

  function navigationTarget(input, direction) {
    const state = navigationState(input);
    const items = Array.isArray(input?.items) ? input.items : [];
    const step = direction === "previous" ? -1 : direction === "next" ? 1 : 0;
    if (!step || state.index < 0 || !state[direction]) return { type: "none" };
    const adjacent = items[state.index + step];
    if (adjacent && normalizedIdentity(adjacent.id) !== null) return { type: "entry", entryId: adjacent.id };
    if (input.view === "feed") return { type: "feed-more" };
    return { type: "page", page: positiveInteger(input.page, 1) + step };
  }

  function boundaryEntryId(items, direction) {
    const values = Array.isArray(items) ? items : [];
    const entry = direction === "previous" ? values.at(-1) : values[0];
    return normalizedIdentity(entry?.id) === null ? null : entry.id;
  }

  function locationEntryId(value, allowOpaque) {
    const identity = normalizedIdentity(value);
    if (identity === null) return null;
    if (allowOpaque) return identity;
    if (!/^\d+$/.test(identity)) return null;
    const parsed = Number(identity);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }

  function normalizedIdentity(value) {
    if (value === null || value === undefined) return null;
    const identity = String(value).trim();
    return identity ? identity : null;
  }

  function positiveInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
  }

  return { boundaryEntryId, locationEntryId, navigationState, navigationTarget };
}));
