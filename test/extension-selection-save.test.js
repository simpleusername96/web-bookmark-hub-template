"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { randomUUID } = require("node:crypto");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const TAB = { id: 7, url: "https://example.test/selection", title: "Synthetic selection" };
const CANDIDATE = { entryUrl: "https://example.test/item", assetUrls: ["https://cdn.example.test/one.png"], adapter: "generic" };
const INITIAL = { comment: "Initial note", tags: ["initial"], folderId: 2, visibility: "normal" };

test("selection save applies final popup metadata and preserves exact unchanged retries", async () => {
  const fixture = workerFixture();
  await fixture.stage(INITIAL);
  const original = await fixture.session();
  const updated = { comment: "Final note", tags: ["final"], folderId: 3, visibility: "private" };
  fixture.failCapture = true;
  await assert.rejects(fixture.send({ type: "WBH_SAVE_STAGED_SELECTION", metadata: updated }), /Synthetic network failure/);
  const first = fixture.captures[0];
  assert.deepEqual(first.payload.items[0], {
    ...original.pendingPayload.items[0], ...updated
  });
  assert.notEqual(first.key, original.clientRequestId);
  assert.equal((await fixture.session()).clientRequestId, first.key);
  assert.deepEqual((await fixture.session()).userMetadata, updated);

  fixture.failCapture = false;
  await fixture.send({ type: "WBH_SAVE_STAGED_SELECTION", metadata: updated });
  assert.deepEqual(fixture.captures[1], first);
  assert.notEqual(await fixture.session(), null, "partial saves retain their session");

  await fixture.send({ type: "WBH_SAVE_STAGED_SELECTION", metadata: { tags: [] } });
  const cleared = fixture.captures[2];
  assert.notEqual(cleared.key, first.key);
  for (const field of ["comment", "folderId", "visibility"]) {
    assert.equal(cleared.payload.items[0][field], undefined);
  }
  assert.deepEqual(cleared.payload.items[0].tags, []);
  assert.equal(cleared.payload.items[0].selectedAt, first.payload.items[0].selectedAt);
  assert.deepEqual(cleared.payload.items[0].assetUrls, first.payload.items[0].assetUrls);
});

test("changed selected assets get a fresh request ID while identical staging is stable", async () => {
  const fixture = workerFixture();
  await fixture.stage(INITIAL);
  const before = await fixture.session();
  await fixture.stageCandidates([CANDIDATE]);
  assert.equal((await fixture.session()).clientRequestId, before.clientRequestId);
  await fixture.stageCandidates([{ ...CANDIDATE, assetUrls: ["https://cdn.example.test/two.png"] }]);
  assert.notEqual((await fixture.session()).clientRequestId, before.clientRequestId);
});

test("content scripts cannot read popup metadata or trigger a metadata save", async () => {
  const fixture = workerFixture();
  await fixture.stage(INITIAL);
  const before = await fixture.session();
  for (const message of [
    { type: "WBH_GET_STATUS" },
    { type: "WBH_SAVE_STAGED_SELECTION", metadata: { visibility: "normal" } }
  ]) {
    await assert.rejects(fixture.send(message, { tab: TAB }), { code: "SELECTION_CONTEXT_INVALID" });
  }
  assert.deepEqual(await fixture.session(), before);
  assert.equal(fixture.captures.length, 0);
});

test("reopened popup restores session settings and refresh preserves current edits", async () => {
  const fixture = workerFixture();
  await fixture.stage(INITIAL);
  const popup = popupFixture(fixture);
  await vm.runInContext("initialize()", popup.context);
  assert.equal(popup.nodes.get("note").value, INITIAL.comment);
  assert.equal(popup.nodes.get("folder").value, "2");
  popup.nodes.get("note").value = "Edited after reopen";
  popup.nodes.get("tags").value = "new, second";
  popup.nodes.get("folder").value = "3";
  popup.nodes.get("capture-visibility").value = "private";
  await vm.runInContext("refresh()", popup.context);
  assert.equal(popup.nodes.get("note").value, "Edited after reopen");
  await vm.runInContext("saveSelection()", popup.context);
  assert.equal(fixture.captures[0].payload.items[0].comment, "Edited after reopen");
  assert.deepEqual(fixture.captures[0].payload.items[0].tags, ["new", "second"]);
  assert.equal(fixture.captures[0].payload.items[0].visibility, "private");
  assert.equal(fixture.captures[0].payload.items[0].folderId, 3);
  assert.equal(popup.disabledDuringSave, true);
  assert.equal(popup.nodes.get("note").disabled, false);

  const reopened = popupFixture(fixture);
  await vm.runInContext("initialize()", reopened.context);
  assert.equal(reopened.nodes.get("note").value, "Edited after reopen");
  assert.equal(reopened.nodes.get("capture-visibility").value, "private");
});

test("popup keeps a verified connection visible when folder loading fails", async () => {
  const fixture = workerFixture();
  await fixture.stage(INITIAL);
  fixture.failFolders = true;
  const popup = popupFixture(fixture);
  await vm.runInContext("initialize()", popup.context);

  assert.equal(
    popup.nodes.get("connection-status").textContent,
    "연결됨 · Synthetic · http://127.0.0.1:3042"
  );
  assert.equal(popup.nodes.get("pairing-panel").hidden, true);
  assert.equal(popup.nodes.get("save-tab").disabled, false);
  assert.equal(popup.nodes.get("folder").options.some((option) => /연결 후 확인/.test(option.textContent)), false);
  assert.match(popup.nodes.get("message").textContent, /연결은 확인됐지만 폴더 목록/);
});

test("reopened disconnected popup keeps its Folder through reconnect and save", async () => {
  const fixture = workerFixture();
  await fixture.stage(INITIAL);
  fixture.connected = false;
  const popup = popupFixture(fixture);
  await vm.runInContext("initialize()", popup.context);
  assert.equal(popup.nodes.get("folder").value, "2");
  assert.match(popup.nodes.get("folder").options.at(-1).textContent, /연결 후 확인/);

  fixture.connected = true;
  await vm.runInContext("refresh()", popup.context);
  assert.equal(popup.nodes.get("folder").value, "2");
  await vm.runInContext("saveSelection()", popup.context);
  assert.equal(fixture.captures[0].payload.items[0].folderId, 2);
});

test("automatic tags refresh after selection ends while manually edited tags remain", async () => {
  for (const edited of [false, true]) {
    const fixture = workerFixture();
    const popup = popupFixture(fixture);
    await vm.runInContext("initialize()", popup.context);
    const tags = popup.nodes.get("tags");
    assert.equal(tags.value, "first");
    if (edited) {
      tags.value = "custom";
      tags.handlers.input();
    }
    await vm.runInContext("startSelection()", popup.context);
    await vm.runInContext("stopSelection()", popup.context);
    fixture.tab = { ...TAB, url: "https://example.test/second" };
    await vm.runInContext("refresh()", popup.context);
    assert.equal(tags.value, edited ? "custom" : "second");
  }
});

function workerFixture() {
  const captures = [];
  const memory = {};
  const event = () => ({ addListener() {} });
  const storage = {
    async get(key) { return structuredClone({ [key]: memory[key] }); },
    async set(value) { Object.assign(memory, structuredClone(value)); },
    async remove(key) { delete memory[key]; },
    async setAccessLevel() {}
  };
  const client = {
    async connection() {
      return fixture.connected
        ? { connected: true, baseUrl: "http://127.0.0.1:3042", client: { label: "Synthetic" } }
        : { connected: false, state: "unavailable", baseUrl: "http://127.0.0.1:3042" };
    },
    async listFolders() {
      if (fixture.failFolders) throw new Error("Synthetic folder failure");
      return [{ id: 2, name: "Initial" }, { id: 3, name: "Final" }];
    },
    async capture(payload, key) {
      captures.push(structuredClone({ payload, key }));
      if (fixture.failCapture) throw new Error("Synthetic network failure");
      return { items: [{ entry_id: 1, outcome_code: "created", assets: [{ outcome_code: "failed" }] }] };
    }
  };
  const context = vm.createContext({
    URL, structuredClone, crypto: { randomUUID },
    fetch() { throw new Error("Network is forbidden in this fixture"); },
    chrome: {
      storage: { local: storage, session: storage },
      runtime: { onInstalled: event(), onStartup: event(), onMessage: event(), onMessageExternal: event() },
      commands: { onCommand: event() },
      tabs: { onUpdated: event(), onRemoved: event(), async query() { return [fixture.tab]; }, async sendMessage() {} },
      scripting: { async executeScript() {} }
    }
  });
  context.importScripts = (...files) => {
    for (const file of files) {
      if (file === "extension/registry-client.js") {
        context.WBHRegistryClient = { createRegistryClient: () => client, CANONICAL_BASE_URL: "http://127.0.0.1:3042", entryDetailUrl: (id) => `http://127.0.0.1:3042/?entry=${id}` };
      } else vm.runInContext(fs.readFileSync(path.join(ROOT, file), "utf8"), context, { filename: file });
    }
  };
  vm.runInContext(fs.readFileSync(path.join(ROOT, "service-worker.js"), "utf8"), context);
  const fixture = {
    captures, connected: true, failCapture: false, failFolders: false, tab: TAB,
    async send(message, sender = {}) {
      context.testMessage = message;
      context.testSender = sender;
      return structuredClone(await vm.runInContext("handleMessage(testMessage, testSender)", context));
    },
    async session() { return structuredClone(await vm.runInContext("selections.get()", context)); },
    async stage(metadata) {
      await this.send({ type: "WBH_START_SELECTION", metadata });
      await this.stageCandidates([CANDIDATE]);
    },
    async stageCandidates(candidates) {
      const session = await this.session();
      await this.send({ type: "WBH_SELECTION_UPDATE", sessionId: session.id, candidates, selectedAt: "2026-09-08T00:00:00.000Z" }, { tab: TAB });
    }
  };
  return fixture;
}

function popupFixture(worker) {
  const nodes = new Map();
  const makeNode = (kind) => {
    let value = "";
    const node = {
      options: [], hidden: false, disabled: false,
      handlers: {}, classList: { toggle() {} },
      addEventListener(name, handler) { this.handlers[name] = handler; }, removeAttribute() {},
      append(...children) { this.options.push(...children); },
      replaceChildren() { this.options = []; if (kind === "folder") value = ""; }
    };
    Object.defineProperty(node, "value", {
      get() { return value; },
      set(next) {
        const normalized = String(next ?? "");
        value = kind === "folder" && !node.options.some((option) => option.value === normalized)
          ? ""
          : normalized;
      }
    });
    return node;
  };
  const document = {
    addEventListener() {},
    createElement: (tagName) => makeNode(tagName),
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, makeNode(id));
      return nodes.get(id);
    }
  };
  const fixture = { nodes, disabledDuringSave: false };
  fixture.context = vm.createContext({
    document, URL,
    WBHCaptureTagSuggestions: { fromUrl: (url) => [url.endsWith("/second") ? "second" : "first"] },
    WBHTagSuggestions: { create() {} },
    chrome: { runtime: { async sendMessage(message) {
      if (message.type === "WBH_SAVE_STAGED_SELECTION") {
        fixture.disabledDuringSave = ["note", "tags", "folder", "capture-visibility"]
          .every((id) => nodes.get(id).disabled);
      }
      return { ok: true, data: await worker.send(message) };
    } } }
  });
  vm.runInContext(fs.readFileSync(path.join(ROOT, "popup.js"), "utf8"), fixture.context);
  return fixture;
}
