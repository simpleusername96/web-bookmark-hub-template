(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.WBHSelectionRuntime = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DEFAULT_FILES = [
    "profiles.js",
    "extension/capture-contract.js",
    "extension/candidate-extractor.js",
    "extension/selection-scan-scheduler.js",
    "content-script.js"
  ];

  function createSelectionRuntime({ chromeApi, selections, files = DEFAULT_FILES }) {
    async function inject(session) {
      await chromeApi.scripting.executeScript({
        target: { tabId: session.tabId },
        files
      });
      await chromeApi.tabs.sendMessage(session.tabId, {
        type: "WBH_SELECTION_START",
        session: {
          id: session.id,
          pageUrl: session.pageUrl,
          selectedCandidates: session.selectedCandidates || []
        }
      });
      return { active: true, tabId: session.tabId, pageUrl: session.pageUrl };
    }

    async function restore(tabId, tabUrl) {
      const session = await selections.get();
      if (!session || Number(tabId) !== session.tabId) return { restored: false };
      let updated;
      try {
        updated = await selections.followTab({ id: tabId, url: tabUrl }, session.id);
      } catch (error) {
        if (error?.code === "SELECTION_NAVIGATION_INVALID") {
          await selections.clear();
          return { restored: false, cleared: true };
        }
        throw error;
      }
      try {
        await inject(updated);
        return { restored: true, pageUrl: updated.pageUrl };
      } catch (_error) {
        return { restored: false, retryable: true };
      }
    }

    async function closeTab(tabId) {
      const session = await selections.get();
      if (!session || Number(tabId) !== session.tabId) return { cleared: false };
      await selections.clear();
      return { cleared: true };
    }

    return { closeTab, inject, restore };
  }

  return { DEFAULT_FILES, createSelectionRuntime };
}));
