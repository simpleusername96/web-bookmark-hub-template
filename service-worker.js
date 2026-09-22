"use strict";

importScripts(
  "profiles.js",
  "extension/capture-contract.js",
  "extension/transport-contract.js",
  "extension/registry-client.js",
  "extension/pairing-bridge.js",
  "extension/selection-session.js",
  "extension/selection-runtime.js"
);

const Contract = globalThis.WBHCaptureContract;
const client = globalThis.WBHRegistryClient.createRegistryClient({ chromeApi: chrome, fetchImpl: fetch });
const pairingBridge = globalThis.WBHPairingBridge.createExternalPairingBridge({
  client,
  canonicalBaseUrl: globalThis.WBHRegistryClient.CANONICAL_BASE_URL
});
const selections = globalThis.WBHSelectionSession.createSelectionSessionStore(chrome);
const sessionMatchesTab = globalThis.WBHSelectionSession.sessionMatchesTab;
const selectionRuntime = globalThis.WBHSelectionRuntime.createSelectionRuntime({ chromeApi: chrome, selections });
let storageReady = restrictStorageAccess();

chrome.runtime.onInstalled.addListener(() => { storageReady = restrictStorageAccess(); });
chrome.runtime.onStartup.addListener(() => { storageReady = restrictStorageAccess(); });
chrome.commands?.onCommand.addListener((command) => {
  if (command !== "save-current-tab") return;
  void storageReady.then(async () => {
    const outcome = await saveCurrentTab({});
    outcome.shortcutEnrichment = await collectShortcutEvidence(outcome).catch((error) => ({
      state: "deferred",
      code: error?.code || "SHORTCUT_EVIDENCE_FAILED"
    }));
    await notifyShortcutOutcome(outcome);
  }).catch(async (error) => {
    await showActionFallback(error?.message || "현재 탭을 저장하지 못했습니다.", true);
  });
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  void storageReady
    .then(() => selectionRuntime.restore(tabId, tab?.url || changeInfo.url || ""))
    .catch(() => {});
});
chrome.tabs.onRemoved.addListener((tabId) => {
  void storageReady.then(() => selectionRuntime.closeTab(tabId)).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  storageReady
    .then(() => handleMessage(message || {}, sender))
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({
      ok: false,
      error: {
        code: error?.code || "EXTENSION_OPERATION_FAILED",
        message: error?.message || "The extension operation failed."
      }
    }));
  return true;
});
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  storageReady
    .then(() => pairingBridge.handle(message || {}, sender))
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({
      ok: false,
      error: {
        code: error?.code || "EXTENSION_OPERATION_FAILED",
        message: error?.message || "The extension operation failed."
      }
    }));
  return true;
});

async function handleMessage(message, sender) {
  switch (message.type) {
    case "WBH_GET_STATUS":
      assertPopupContext(sender);
      return status();
    case "WBH_OPEN_CONNECTION":
      await chrome.tabs.create({
        url: new URL(`?connect=${chrome.runtime.id}`, globalThis.WBHRegistryClient.CANONICAL_BASE_URL).href
      });
      return { opened: true };
    case "WBH_LIST_FOLDERS":
      return client.listFolders();
    case "WBH_TAG_SUGGESTIONS":
      if (sender?.tab) {
        const error = new Error("Tag suggestions are available only in the extension popup.");
        error.code = "TAG_SUGGESTIONS_CONTEXT_INVALID";
        throw error;
      }
      return client.suggestTags({ query: message.query, exclude: message.exclude, limit: 8 });
    case "WBH_SAVE_CURRENT_TAB":
      return saveCurrentTab(message.metadata || {});
    case "WBH_START_SELECTION":
      return startSelection(message.metadata || {});
    case "WBH_SELECTION_PAGE_CHANGED":
      return selections.followSender(sender, message.sessionId);
    case "WBH_SELECTION_UPDATE":
      return stageSelection(message, sender);
    case "WBH_SELECTION_PRESENCE":
      return selectionPresence(message, sender);
    case "WBH_SAVE_STAGED_SELECTION":
      assertPopupContext(sender);
      return saveStagedSelection(message.metadata);
    case "WBH_RESCAN_SELECTION":
      return rescanSelection();
    case "WBH_CLEAR_STAGED_SELECTION":
      return clearStagedSelection();
    case "WBH_STOP_SELECTION":
      return stopSelection();
    case "WBH_SELECTION_CANCEL":
      await selections.followSender(sender, message.sessionId);
      await selections.clear();
      return { stopped: true };
    default: {
      const error = new Error("Unknown extension message.");
      error.code = "MESSAGE_UNSUPPORTED";
      throw error;
    }
  }
}

function assertPopupContext(sender) {
  if (sender?.tab) {
    const error = new Error("Selection settings are available only in the extension popup.");
    error.code = "SELECTION_CONTEXT_INVALID";
    throw error;
  }
}

async function status() {
  const [connection, tab, selection] = await Promise.all([
    client.connection(),
    activeTab().catch(() => null),
    selections.get()
  ]);
  const selectionOnActiveTab = sessionMatchesTab(selection, tab);
  return {
    connection,
    tab: tab ? { id: tab.id, url: safeTabUrl(tab.url), title: tab.title || "" } : null,
    selection: selectionOnActiveTab ? {
      active: true,
      id: selection.id,
      userMetadata: selection.userMetadata,
      tabId: selection.tabId,
      pageUrl: selection.pageUrl,
      hasPendingPayload: Boolean(selection.pendingPayload),
      selectedCount: selection.pendingPayload?.items?.length || 0,
      assetCount: (selection.pendingPayload?.items || []).reduce((total, item) => total + (item.assetUrls?.length || 0), 0),
      adapter: selection.pendingPayload?.adapter || null,
      preview: (selection.pendingPayload?.items || []).slice(0, 20).map((item) => ({
        title: item.title || "",
        entryUrl: item.entryUrl,
        assetCount: item.assetUrls?.length || 0
      })),
      lastResult: selection.lastResult
    } : { active: false }
  };
}

async function saveCurrentTab(metadata) {
  const tab = await activeTab();
  const payload = Contract.buildCurrentTabCapture(tab, metadata);
  const result = await client.capture(payload, crypto.randomUUID());
  return captureOutcome(result, tab);
}

async function captureOutcome(result, tab) {
  const item = result.items?.[0] || null;
  const summary = Contract.summarizeCaptureResult(result);
  const connection = await client.connection();
  const entryId = item?.entry_id || null;
  return {
    result,
    tabId: tab.id,
    windowId: tab.windowId,
    sourceUrl: safeTabUrl(tab.url),
    entryId,
    outcomeCode: item?.outcome_code || null,
    archived: item?.archived === true,
    summary,
    entryUrl: entryId && connection.connected ? globalThis.WBHRegistryClient.entryDetailUrl(entryId, connection.baseUrl) : null
  };
}

async function collectShortcutEvidence(outcome) {
  const decision = Contract.shortcutEnrichmentDecision(outcome.result);
  if (!decision.collect) {
    return { state: decision.allowed && !decision.needsSummary ? "complete" : "url_only", reason: decision.reason };
  }
  const [pageCapture, viewportCapture] = await Promise.allSettled([
    chrome.scripting.executeScript({
      target: { tabId: outcome.tabId },
      func: captureShortcutPageHtml,
      args: [768 * 1024]
    }),
    chrome.tabs.captureVisibleTab(outcome.windowId, { format: "jpeg", quality: 68 })
  ]);
  const page = pageCapture.status === "fulfilled" ? pageCapture.value?.[0]?.result : null;
  if (!page?.html) {
    return { state: "deferred", code: "SHORTCUT_HTML_UNAVAILABLE" };
  }
  if (page.url !== outcome.sourceUrl) {
    return { state: "deferred", code: "SHORTCUT_PAGE_CHANGED" };
  }
  const screenshotDataUrl = Contract.boundedShortcutScreenshotDataUrl(
    viewportCapture.status === "fulfilled" ? viewportCapture.value : null
  );
  const result = await client.enrichShortcut(outcome.entryId, {
    url: outcome.sourceUrl,
    capturedAt: page.capturedAt,
    html: page.html,
    screenshotDataUrl
  });
  return { state: result.queued ? "queued" : "deferred", ...result };
}

function captureShortcutPageHtml(maxBytes) {
  const root = document.querySelector("main") || document.querySelector("article") || document.body;
  if (!root) return null;
  const head = document.createElement("head");
  for (const source of document.head?.querySelectorAll("title, meta") || []) {
    const clone = source.cloneNode(true);
    if (clone.localName === "meta") {
      const key = (clone.getAttribute("name") || clone.getAttribute("property") || "").toLowerCase();
      if (!/^(?:description|og:(?:title|description|url|type|image(?::(?:secure_url|type))?)|twitter:(?:title|description|card|image(?::src)?))$/.test(key)) continue;
      for (const attribute of [...clone.attributes]) {
        if (!["content", "name", "property"].includes(attribute.name.toLowerCase())) clone.removeAttribute(attribute.name);
      }
      if ((clone.getAttribute("content") || "").length > 4096) {
        clone.setAttribute("content", clone.getAttribute("content").slice(0, 4096));
      }
    }
    head.append(clone);
  }
  const body = document.createElement("body");
  const content = root.cloneNode(true);
  content.querySelectorAll("script, style, noscript, svg, canvas, iframe, object, embed, template, form, input, textarea, select, option, button, [hidden], [aria-hidden='true']")
    .forEach((node) => node.remove());
  const allowedAttributes = new Set(["alt", "class", "content", "datetime", "href", "id", "name", "poster", "property", "src"]);
  for (const element of [content, ...content.querySelectorAll("*")]) {
    for (const attribute of [...element.attributes]) {
      if (!allowedAttributes.has(attribute.name.toLowerCase())) element.removeAttribute(attribute.name);
    }
  }
  body.append(content);
  const prefix = `<!doctype html><html>${head.outerHTML}<body>`;
  const suffix = "</body></html>";
  const bodyMarkup = body.innerHTML;
  const encoder = new TextEncoder();
  const fixedBytes = encoder.encode(prefix + suffix).byteLength;
  const available = Math.max(0, Number(maxBytes) - fixedBytes);
  const encodedBody = encoder.encode(bodyMarkup);
  let boundedBody = encodedBody.byteLength > available
    ? new TextDecoder().decode(encodedBody.slice(0, available))
    : bodyMarkup;
  while (encoder.encode(boundedBody).byteLength > available) boundedBody = boundedBody.slice(0, -1);
  return {
    capturedAt: new Date().toISOString(),
    url: location.href,
    html: `${prefix}${boundedBody}${suffix}`
  };
}

async function notifyShortcutOutcome(outcome) {
  if (!outcome.summary?.entriesSaved) {
    await showActionFallback("저장하지 못함", true);
    return;
  }
  const duplicate = outcome.summary.entriesCreated === 0 && outcome.summary.entriesAlreadySaved > 0;
  const message = outcome.shortcutEnrichment?.state === "queued"
    ? "저장됨 · AI 정리 중"
    : outcome.shortcutEnrichment?.state === "deferred"
      ? "저장됨 · AI 정리 보류"
      : duplicate ? "이미 저장됨" : "저장됨";
  try {
    await chrome.scripting.executeScript({
      target: { tabId: outcome.tabId },
      func: function showBookmarkHubToast(text, entryUrl) {
        document.getElementById("wbh-save-toast")?.remove();
        const toast = document.createElement("div");
        toast.id = "wbh-save-toast";
        toast.setAttribute("role", "status");
        Object.assign(toast.style, {
          position: "fixed", top: "24px", left: "50%", zIndex: "2147483647",
          display: "flex", gap: "10px", alignItems: "center", maxWidth: "min(520px, calc(100vw - 32px))",
          border: "1px solid #171715", borderRadius: "3px", padding: "10px 12px",
          color: "#171715", background: "#fbfaf5", boxShadow: "3px 3px 0 #171715",
          font: "700 15px/1.35 ui-monospace, Cascadia Mono, Consolas, monospace",
          textAlign: "center", transform: "translateX(-50%)"
        });
        const label = document.createElement("span");
        label.textContent = text;
        toast.append(label);
        if (entryUrl) {
          const link = document.createElement("a");
          link.href = entryUrl;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          link.textContent = "바로가기";
          Object.assign(link.style, { color: "inherit", fontWeight: "800", whiteSpace: "nowrap" });
          toast.append(link);
        }
        document.documentElement.append(toast);
        setTimeout(() => toast.remove(), 4000);
      },
      args: [message, outcome.entryUrl]
    });
  } catch (_error) {
    await showActionFallback(message, false);
  }
}

async function showActionFallback(message, failed) {
  await chrome.action.setBadgeBackgroundColor({ color: failed ? "#72251d" : "#171715" }).catch(() => {});
  await chrome.action.setBadgeText({ text: failed ? "!" : "✓" }).catch(() => {});
  await chrome.action.setTitle({ title: `Web Bookmark Hub · ${message}` }).catch(() => {});
  setTimeout(() => {
    void chrome.action.setBadgeText({ text: "" }).catch(() => {});
    void chrome.action.setTitle({ title: "Web Bookmark Hub" }).catch(() => {});
  }, 4000);
}

async function startSelection(metadata) {
  const tab = await activeTab();
  Contract.httpUrl(tab.url, "TAB_URL_INVALID");
  const userMetadata = Contract.normalizeUserMetadata(metadata);
  const previous = await selections.get();
  if (sessionMatchesTab(previous, tab)) {
    return { ...(await selectionRuntime.inject(previous)), resumed: true };
  }
  if (previous) {
    await selections.clear();
    await chrome.tabs.sendMessage(previous.tabId, {
      type: "WBH_SELECTION_STOP",
      sessionId: previous.id
    }).catch(() => {});
  }
  const session = await selections.start(tab, () => crypto.randomUUID(), userMetadata);
  try {
    return await selectionRuntime.inject(session);
  } catch (error) {
    await selections.clear();
    await chrome.tabs.sendMessage(tab.id, {
      type: "WBH_SELECTION_STOP",
      sessionId: session.id
    }).catch(() => {});
    throw error;
  }
}

async function selectionPresence(message, sender) {
  const session = await selections.requireSender(sender, message.sessionId);
  const items = Contract.buildCapturePresence(message.candidates, {
    pageUrl: session.pageUrl,
    profiles: globalThis.ACCUM_CAPTURE_TEMPLATES
  });
  return client.capturePresence(items);
}

async function stopSelection() {
  const session = await selections.get();
  if (!session) return { stopped: true };
  await selections.clear();
  await chrome.tabs.sendMessage(session.tabId, { type: "WBH_SELECTION_STOP", sessionId: session.id }).catch(() => {});
  return { stopped: true };
}

async function stageSelection(message, sender) {
  const session = await selections.requireSender(sender, message.sessionId);
  if (!Array.isArray(message.candidates) || message.candidates.length === 0) {
    await selections.remember(session, null, null, []);
    return { selectedCount: 0, assetCount: 0 };
  }
  const payload = Contract.normalizeSelectedCapture(message.candidates, {
    pageUrl: session.pageUrl,
    profiles: globalThis.ACCUM_CAPTURE_TEMPLATES,
    selectedAt: message.selectedAt,
    userMetadata: session.userMetadata
  });
  await selections.remember(session, payload, null, message.candidates);
  return {
    selectedCount: payload.items.length,
    assetCount: payload.items.reduce((total, item) => total + item.assetUrls.length, 0)
  };
}

async function saveStagedSelection(metadata) {
  let session = await selections.get();
  if (!session?.pendingPayload) {
    const error = new Error("No selected entries are ready to save.");
    error.code = "SELECTION_EMPTY";
    throw error;
  }
  const userMetadata = Contract.normalizeUserMetadata(metadata === undefined ? session.userMetadata : metadata);
  const payload = {
    ...session.pendingPayload,
    items: session.pendingPayload.items.map((item) => ({ ...item, ...userMetadata }))
  };
  session = await selections.remember({ ...session, userMetadata }, payload, null);
  const result = await client.capture(payload, session.clientRequestId);
  const summary = Contract.summarizeCaptureResult(result);
  await selections.remember(session, payload, result);
  if (summary.completed) {
    await selections.clear();
    await chrome.tabs.sendMessage(session.tabId, { type: "WBH_SELECTION_STOP", sessionId: session.id }).catch(() => {});
  }
  const connection = await client.connection();
  return {
    result,
    summary,
    completed: summary.completed,
    archived: Boolean(result.items?.length) && result.items.every((item) => item.archived === true),
    entryId: summary.entryIds.length === 1 ? summary.entryIds[0] : null,
    entryUrl: summary.entryIds.length === 1 && connection.connected
      ? globalThis.WBHRegistryClient.entryDetailUrl(summary.entryIds[0], connection.baseUrl)
      : null
  };
}

async function rescanSelection() {
  const session = await selections.get();
  if (!session) return { active: false };
  await chrome.tabs.sendMessage(session.tabId, { type: "WBH_SELECTION_RESCAN", sessionId: session.id });
  return { active: true };
}

async function clearStagedSelection() {
  const session = await selections.get();
  if (!session) return { cleared: true };
  await selections.remember(session, null, null, []);
  await chrome.tabs.sendMessage(session.tabId, { type: "WBH_SELECTION_CLEAR", sessionId: session.id }).catch(() => {});
  return { cleared: true };
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || !Number.isSafeInteger(Number(tab.id))) {
    const error = new Error("No active browser tab is available.");
    error.code = "TAB_UNAVAILABLE";
    throw error;
  }
  Contract.httpUrl(tab.url, "TAB_URL_INVALID");
  return tab;
}

function safeTabUrl(value) {
  try { return Contract.httpUrl(value, "TAB_URL_INVALID"); }
  catch (_error) { return ""; }
}

async function restrictStorageAccess() {
  await Promise.all([
    chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
    chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
  ]);
}
