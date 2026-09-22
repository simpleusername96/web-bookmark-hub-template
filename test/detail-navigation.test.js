"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const Navigation = require("../web/detail-navigation.js");

const items = [{ id: 11 }, { id: 12 }, { id: 13 }];

test("detail navigation uses loaded neighbors before page boundaries", () => {
  const input = { items, entryId: 12, view: "grid", page: 2, totalPages: 4 };
  assert.deepEqual(Navigation.navigationState(input), { index: 1, previous: true, next: true });
  assert.deepEqual(Navigation.navigationTarget(input, "previous"), { type: "entry", entryId: 11 });
  assert.deepEqual(Navigation.navigationTarget(input, "next"), { type: "entry", entryId: 13 });
});

test("paged detail navigation crosses both adjacent page boundaries and stops only at result ends", () => {
  assert.deepEqual(
    Navigation.navigationTarget({ items, entryId: 11, view: "grid", page: 2, totalPages: 4 }, "previous"),
    { type: "page", page: 1 }
  );
  assert.deepEqual(
    Navigation.navigationTarget({ items, entryId: 13, view: "list", page: 2, totalPages: 4 }, "next"),
    { type: "page", page: 3 }
  );
  assert.deepEqual(
    Navigation.navigationState({ items, entryId: 11, view: "grid", page: 1, totalPages: 1 }),
    { index: 0, previous: false, next: true }
  );
  assert.deepEqual(
    Navigation.navigationState({ items: [{ id: 11 }], entryId: 11, view: "grid", page: 1, totalPages: 1 }),
    { index: 0, previous: false, next: false }
  );
});

test("Feed requests continuation only at its loaded end and an unlocated detail has no fabricated neighbors", () => {
  assert.deepEqual(
    Navigation.navigationTarget({ items, entryId: 13, view: "feed", feedHasMore: true }, "next"),
    { type: "feed-more" }
  );
  assert.deepEqual(
    Navigation.navigationState({ items, entryId: 13, view: "feed", feedHasMore: false }),
    { index: 2, previous: true, next: false }
  );
  assert.deepEqual(
    Navigation.navigationState({ items, entryId: 99, view: "grid", page: 2, totalPages: 4 }),
    { index: -1, previous: false, next: false }
  );
  assert.equal(Navigation.boundaryEntryId(items, "previous"), 13);
  assert.equal(Navigation.boundaryEntryId(items, "next"), 11);
});

test("opaque identities keep their original values across detail navigation", () => {
  const opaqueItems = [{ id: "demo-001" }, { id: "demo-002" }, { id: "demo-003" }];
  const input = { items: opaqueItems, entryId: "demo-002", view: "grid", page: 1, totalPages: 1 };
  assert.deepEqual(Navigation.navigationState(input), { index: 1, previous: true, next: true });
  assert.deepEqual(Navigation.navigationTarget(input, "previous"), { type: "entry", entryId: "demo-001" });
  assert.deepEqual(Navigation.navigationTarget(input, "next"), { type: "entry", entryId: "demo-003" });
  assert.equal(Navigation.boundaryEntryId(opaqueItems, "previous"), "demo-003");
  assert.equal(Navigation.boundaryEntryId(opaqueItems, "next"), "demo-001");
  assert.deepEqual(Navigation.navigationState({ items: opaqueItems, entryId: "  " }), { index: -1, previous: false, next: false });
});

test("location identity parsing allows opaque demo IDs but keeps production numeric validation", () => {
  assert.equal(Navigation.locationEntryId("demo-002", true), "demo-002");
  assert.equal(Navigation.locationEntryId("  demo-002  ", true), "demo-002");
  assert.equal(Navigation.locationEntryId("demo-002", false), null);
  assert.equal(Navigation.locationEntryId("42", false), 42);
  assert.equal(Navigation.locationEntryId("0", false), null);
  assert.equal(Navigation.locationEntryId("9007199254740992", false), null);
});
