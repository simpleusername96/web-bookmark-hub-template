(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.WBHSelectionSession = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const SESSION_KEY = "webBookmarkHubSelectionSession";

  function sessionMatchesTab(session, tab) {
    return Boolean(
      session
      && Number(session.tabId) === Number(tab?.id)
      && String(session.pageUrl || "") === String(tab?.url || "")
    );
  }

  function createSelectionSessionStore(chromeApi) {
    async function start(tab, uuid, userMetadata) {
      const session = {
        id: uuid(),
        clientRequestId: uuid(),
        tabId: Number(tab.id),
        pageUrl: String(tab.url),
        pageOrigin: httpOrigin(tab.url),
        userMetadata: userMetadata || {},
        createdAt: new Date().toISOString(),
        pendingPayload: null,
        selectedCandidates: [],
        lastResult: null
      };
      await chromeApi.storage.session.set({ [SESSION_KEY]: session });
      return session;
    }

    async function get() {
      const stored = await chromeApi.storage.session.get(SESSION_KEY);
      return stored?.[SESSION_KEY] || null;
    }

    async function requireSender(sender, sessionId) {
      const session = await get();
      if (!session || session.id !== sessionId || Number(sender?.tab?.id) !== session.tabId || String(sender?.tab?.url || "") !== session.pageUrl) {
        const error = new Error("Selection session does not belong to this tab.");
        error.code = "SELECTION_SESSION_MISMATCH";
        throw error;
      }
      return session;
    }

    async function followSender(sender, sessionId) {
      return followTab(sender?.tab, sessionId);
    }

    async function followTab(tab, sessionId) {
      const session = await get();
      const senderUrl = String(tab?.url || "");
      if (!session || session.id !== sessionId || Number(tab?.id) !== session.tabId) {
        const error = new Error("Selection session does not belong to this tab.");
        error.code = "SELECTION_SESSION_MISMATCH";
        throw error;
      }
      const originalOrigin = session.pageOrigin || httpOrigin(session.pageUrl);
      if (!originalOrigin || httpOrigin(senderUrl) !== originalOrigin) {
        const error = new Error("Selection can follow only same-origin page navigation.");
        error.code = "SELECTION_NAVIGATION_INVALID";
        throw error;
      }
      const updated = { ...session, pageOrigin: originalOrigin, pageUrl: senderUrl };
      await chromeApi.storage.session.set({ [SESSION_KEY]: updated });
      return updated;
    }

    async function remember(session, payload, result, selectedCandidates) {
      const updated = {
        ...session,
        clientRequestId: JSON.stringify(payload) === JSON.stringify(session.pendingPayload)
          ? session.clientRequestId : crypto.randomUUID(),
        pendingPayload: payload,
        lastResult: result || null,
        selectedCandidates: arguments.length >= 4
          ? structuredClone(selectedCandidates || [])
          : (session.selectedCandidates || [])
      };
      await chromeApi.storage.session.set({ [SESSION_KEY]: updated });
      return updated;
    }

    async function clear() {
      await chromeApi.storage.session.remove(SESSION_KEY);
    }

    return { clear, followSender, followTab, get, remember, requireSender, start };
  }

  function httpOrigin(value) {
    try {
      const url = new URL(String(value || ""));
      return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.origin : "";
    } catch (_error) {
      return "";
    }
  }

  return { SESSION_KEY, createSelectionSessionStore, sessionMatchesTab };
}));
