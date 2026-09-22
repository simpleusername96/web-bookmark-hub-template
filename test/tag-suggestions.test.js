"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const TagSuggestions = require("../web/tag-suggestions.js");

class FakeElement {
  constructor(name) {
    this.name = name;
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.hidden = false;
    this.value = "";
    this.selectionStart = 0;
  }
  append(...children) {
    children.forEach((child) => {
      if (child.parentNode) child.parentNode.children = child.parentNode.children.filter((item) => item !== child);
      child.parentNode = this;
      this.children.push(child);
    });
  }
  insertBefore(child, reference) {
    const index = this.children.indexOf(reference);
    child.parentNode = this;
    this.children.splice(index < 0 ? this.children.length : index, 0, child);
  }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  setSelectionRange(start) { this.selectionStart = start; }
  dispatchEvent(event) { (this.listeners[event.type] || []).forEach((listener) => listener(event)); }
  emit(type, event) { (this.listeners[type] || []).forEach((listener) => listener(event)); }
}

test("active comma token replacement preserves other tags", () => {
  const active = TagSuggestions.tokenAt("alpha,  ar , omega", 10);
  assert.deepEqual(active, { start: 6, end: 11, query: "ar" });
  assert.deepEqual(TagSuggestions.completedTokens("alpha,  ar , omega", active), ["alpha", "omega"]);
  assert.deepEqual(TagSuggestions.replaceToken("alpha,  ar , omega", active, "Archive"), {
    value: "alpha,  Archive , omega",
    caret: 15
  });
});

test("combobox queries, navigates, replaces, and exposes listbox state", async () => {
  const documentRef = { createElement: (name) => new FakeElement(name) };
  const parent = new FakeElement("parent");
  const input = new FakeElement("input");
  input.ownerDocument = documentRef;
  input.value = "alpha, ar";
  input.selectionStart = input.value.length;
  parent.append(input);
  const queries = [];
  const controller = TagSuggestions.create({
    input,
    document: documentRef,
    async fetchSuggestions(options) {
      queries.push(options);
      return [
        { name: "Art", entry_count: 4 },
        { name: "Archive", entry_count: 2 }
      ];
    }
  });
  await controller.refresh();
  const host = parent.children[0];
  const list = host.children[1];
  assert.equal(input.attributes.role, "combobox");
  assert.equal(list.attributes.role, "listbox");
  assert.equal(input.attributes["aria-expanded"], "true");
  assert.deepEqual({ query: queries[0].query, exclude: queries[0].exclude, limit: queries[0].limit }, {
    query: "ar", exclude: ["alpha"], limit: 8
  });
  let escapePrevented = 0;
  let escapeStopped = 0;
  input.emit("keydown", {
    key: "Escape",
    preventDefault() { escapePrevented += 1; },
    stopPropagation() { escapeStopped += 1; }
  });
  assert.equal(list.hidden, true);
  assert.equal(escapePrevented, 1);
  assert.equal(escapeStopped, 1);
  await controller.refresh();
  let prevented = 0;
  input.emit("keydown", { key: "ArrowDown", preventDefault() { prevented += 1; } });
  input.emit("keydown", { key: "Enter", preventDefault() { prevented += 1; } });
  assert.equal(prevented, 2);
  assert.equal(input.value, "alpha, Archive");
  assert.equal(input.attributes["aria-expanded"], "false");
  input.emit("keydown", { key: "Escape", preventDefault() {} });
  assert.equal(list.hidden, true);
});

test("a slower earlier query cannot replace newer suggestions", async () => {
  const documentRef = { createElement: (name) => new FakeElement(name) };
  const parent = new FakeElement("parent");
  const input = new FakeElement("input");
  input.ownerDocument = documentRef;
  input.value = "old";
  input.selectionStart = input.value.length;
  parent.append(input);
  const resolvers = [];
  const controller = TagSuggestions.create({
    input,
    document: documentRef,
    fetchSuggestions() {
      return new Promise((resolve) => { resolvers.push(resolve); });
    }
  });
  const older = controller.refresh();
  input.value = "new";
  input.selectionStart = input.value.length;
  const newer = controller.refresh();
  resolvers[1]([{ name: "New", entry_count: 2 }]);
  await newer;
  const list = parent.children[0].children[1];
  assert.equal(list.children[0].textContent, "New (2)");
  resolvers[0]([{ name: "Old", entry_count: 9 }]);
  await older;
  assert.equal(list.children[0].textContent, "New (2)");
});
