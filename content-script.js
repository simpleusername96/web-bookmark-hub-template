((root) => {
  "use strict";

  if (root.WBH_GENERIC_SELECTOR_LOADED) return;
  root.WBH_GENERIC_SELECTOR_LOADED = true;

  const Extractor = root.WBHCandidateExtractor;
  const patchedHosts = new Map();
  const state = {
    session: null,
    extractor: null,
    selectors: new Map(),
    selected: new Map(),
    persisted: new Set(),
    presenceChecked: new Set(),
    presencePending: new Set(),
    observer: null,
    scanScheduler: null,
    routeTimer: null,
    positionFrame: null,
    lastUrl: location.href,
    stagedFingerprint: ""
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "WBH_SELECTION_START") start(message.session);
    if (message?.type === "WBH_SELECTION_STOP" && (!state.session || message.sessionId === state.session.id)) cleanup();
    if (message?.type === "WBH_SELECTION_RESCAN" && state.session && message.sessionId === state.session.id) {
      state.presenceChecked.clear();
      state.scanScheduler.runNow();
      sendResponse?.({ ok: true, count: state.selectors.size });
    }
    if (message?.type === "WBH_SELECTION_CLEAR" && state.session && message.sessionId === state.session.id) {
      state.selected.clear();
      state.stagedFingerprint = "";
      state.selectors.forEach(renderSelector);
      sendResponse?.({ ok: true });
    }
  });

  function start(session) {
    cleanup();
    if (!session || session.pageUrl !== location.href || !Extractor) {
      showTransient("Selection session no longer matches this page.", true);
      return;
    }
    state.session = { ...session };
    state.lastUrl = location.href;
    state.extractor = createExtractor();
    state.scanScheduler = root.WBHSelectionScanScheduler.createScanScheduler({ scan: scheduledScan });
    for (const candidate of session.selectedCandidates || []) {
      state.selected.set(Extractor.candidateKey(candidate), candidate);
    }
    state.stagedFingerprint = JSON.stringify([...state.selected.values()]);
    injectStyles();
    installObservers();
    state.scanScheduler.runNow();
  }

  function createExtractor() {
    return Extractor.createCandidateExtractor({
      documentRef: document,
      windowRef: window,
      contract: root.WBHCaptureContract,
      profiles: root.ACCUM_CAPTURE_TEMPLATES || []
    });
  }

  function installObservers() {
    state.observer = new MutationObserver((mutations) => {
      if (mutations.some(shouldRescanMutation)) scheduleScan();
    });
    state.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "srcset", "poster", "href", "datetime", "style", "class"]
    });
    addEventListener("scroll", handleViewportChange, { passive: true });
    addEventListener("resize", handleViewportChange, { passive: true });
    addEventListener("popstate", handleNavigation);
    addEventListener("hashchange", handleNavigation);
    state.routeTimer = setInterval(checkRoute, 500);
  }

  function shouldRescanMutation(mutation) {
    if (isSelectorUiNode(mutation.target)) return false;
    if (mutation.type !== "childList") return true;
    const changed = [...mutation.addedNodes, ...mutation.removedNodes];
    return changed.length === 0 || changed.some((node) => !isSelectorUiNode(node));
  }

  function isSelectorUiNode(node) {
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    return Boolean(element?.matches?.("#wbh-media-selector-style, .wbh-media-selector-host, .wbh-selector-transient")
      || element?.closest?.(".wbh-media-selector-host"));
  }

  function handleViewportChange() {
    schedulePositions();
    scheduleScan();
  }

  function handleNavigation() {
    void syncSessionPage();
    scheduleScan();
  }

  function checkRoute() {
    if (state.session && state.lastUrl !== location.href) handleNavigation();
  }

  async function syncSessionPage() {
    if (!state.session || state.lastUrl === location.href) return true;
    try {
      const response = await chrome.runtime.sendMessage({
        type: "WBH_SELECTION_PAGE_CHANGED",
        sessionId: state.session.id
      });
      if (!response?.ok) throw messageError(response);
      if (response.data.pageUrl !== location.href) throw new Error("The page changed again before selection could follow it.");
      state.lastUrl = location.href;
      state.session.pageUrl = response.data.pageUrl;
      state.extractor = createExtractor();
      return true;
    } catch (error) {
      showTransient(error?.message || "Selection cannot follow this page.", true);
      return false;
    }
  }

  function scheduleScan() {
    if (!state.session) return;
    state.scanScheduler.trigger();
  }

  function scheduledScan() {
    if (state.lastUrl !== location.href) {
      void syncSessionPage().then((updated) => { if (updated) scan(); });
    } else {
      scan();
    }
  }

  function scan() {
    if (!state.session || !state.extractor) return;
    const records = state.extractor.scan();
    const nextKeys = new Set(records.map((record) => record.key));
    let stagedChanged = false;

    state.selectors.forEach((selector, key) => {
      if (nextKeys.has(key)) return;
      teardownSelector(selector);
      state.selectors.delete(key);
    });

    records.forEach((record) => {
      if (state.selected.has(record.key)) {
        const previous = state.selected.get(record.key);
        const merged = Extractor.mergeCandidate(previous, record.candidate);
        stagedChanged ||= candidateFingerprint(merged) !== candidateFingerprint(previous);
        state.selected.set(record.key, merged);
      }
      let selector = state.selectors.get(record.key);
      if (!selector) {
        selector = createSelector(record.key, record.candidate);
        state.selectors.set(record.key, selector);
      }
      selector.candidate = record.candidate;
      mountSelector(selector, record.host);
      renderSelector(selector);
    });

    schedulePositions();
    syncPersistedPresence(records);
    const selectedFingerprint = JSON.stringify([...state.selected.values()]);
    if (stagedChanged || selectedFingerprint !== state.stagedFingerprint) {
      void syncStagedSelection().catch((error) => showTransient(error.message, true));
    }
  }

  function syncPersistedPresence(records) {
    const pending = records.filter((record) => (
      !state.presenceChecked.has(record.key) && !state.presencePending.has(record.key)
    ));
    for (let offset = 0; offset < pending.length; offset += 100) {
      void resolvePresenceBatch(pending.slice(offset, offset + 100));
    }
  }

  async function resolvePresenceBatch(records) {
    if (!records.length || !state.session) return;
    const sessionId = state.session.id;
    records.forEach((record) => state.presencePending.add(record.key));
    try {
      const response = await chrome.runtime.sendMessage({
        type: "WBH_SELECTION_PRESENCE",
        sessionId,
        candidates: records.map((record) => record.candidate)
      });
      if (!response?.ok) throw messageError(response);
      if (!state.session || state.session.id !== sessionId) return;
      const saved = Array.isArray(response.data?.saved) ? response.data.saved : [];
      if (saved.length !== records.length) throw new Error("Registry presence response did not match the page candidates.");
      let stagedChanged = false;
      records.forEach((record, index) => {
        state.presenceChecked.add(record.key);
        if (saved[index]) {
          state.persisted.add(record.key);
          stagedChanged ||= state.selected.delete(record.key);
        } else {
          state.persisted.delete(record.key);
        }
        const selector = state.selectors.get(record.key);
        if (selector) renderSelector(selector);
      });
      if (stagedChanged) {
        void syncStagedSelection().catch((error) => showTransient(error.message, true));
      }
    } catch (error) {
      if (state.session?.id === sessionId) {
        records.forEach((record) => state.presenceChecked.add(record.key));
        showTransient(error?.message || "Saved image state could not be checked. Rescan to retry.", true);
      }
    } finally {
      records.forEach((record) => state.presencePending.delete(record.key));
    }
  }

  function createSelector(key, candidate) {
    const wrapper = document.createElement("span");
    wrapper.className = "wbh-media-selector-host";
    const shadow = wrapper.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = selectorControlStyles();
    const control = document.createElement("button");
    control.className = "wbh-media-selector";
    control.type = "button";
    control.setAttribute("role", "checkbox");
    const checkmark = document.createElement("span");
    checkmark.className = "accumcapture-checkmark";
    const badge = document.createElement("span");
    badge.className = "accumcapture-badge";
    control.append(checkmark, badge);
    shadow.append(style, control);
    const selector = { key, candidate, mediaHost: null, mountHost: null, node: wrapper, control, checkmark, badge, selected: false };
    const toggleFromSelector = (event) => {
      event.preventDefault();
      event.stopPropagation();
      void toggle(selector);
    };
    control.addEventListener("click", toggleFromSelector);
    control.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    return selector;
  }

  function renderSelector(selector) {
    const persisted = state.persisted.has(selector.key);
    const selected = persisted || state.selected.has(selector.key);
    selector.selected = selected;
    selector.control.setAttribute("aria-checked", String(selected));
    selector.control.setAttribute("aria-disabled", String(persisted));
    selector.control.setAttribute("aria-label", `${persisted ? "Already saved" : selected ? "Remove from selection" : "Save"} ${selector.candidate.title || selector.candidate.entryUrl}`);
    selector.control.classList.toggle("is-selected", selected);
    selector.control.classList.toggle("is-persisted", persisted);
    selector.checkmark.textContent = selected ? "✓" : "";
    selector.badge.textContent = selected ? "Saved" : "Save";
  }

  async function toggle(selector) {
    if (state.persisted.has(selector.key)) return;
    const wasSelected = state.selected.has(selector.key);
    if (wasSelected) state.selected.delete(selector.key);
    else state.selected.set(selector.key, selector.candidate);
    renderSelector(selector);
    try {
      await syncStagedSelection();
    } catch (error) {
      if (wasSelected) state.selected.set(selector.key, selector.candidate);
      else state.selected.delete(selector.key);
      renderSelector(selector);
      showTransient(error?.message || "Selection could not be updated.", true);
    }
  }

  async function syncStagedSelection() {
    if (!state.session) return;
    if (!(await syncSessionPage())) return;
    const candidates = [...state.selected.values()];
    const fingerprint = JSON.stringify(candidates);
    if (fingerprint === state.stagedFingerprint) return;
    const response = await chrome.runtime.sendMessage({
      type: "WBH_SELECTION_UPDATE",
      sessionId: state.session.id,
      selectedAt: new Date().toISOString(),
      candidates
    });
    if (!response?.ok) throw messageError(response);
    state.stagedFingerprint = fingerprint;
  }

  function mountSelector(selector, mediaHost) {
    if (!(mediaHost instanceof HTMLElement)) return;
    const mountHost = mediaHost.parentElement;
    if (!(mountHost instanceof HTMLElement)) return;
    if (selector.mountHost !== mountHost) {
      if (selector.mountHost) unpatchHostPosition(selector.mountHost);
      patchHostPosition(mountHost);
      selector.mountHost = mountHost;
    }
    selector.mediaHost = mediaHost;
    if (selector.node.parentElement !== mountHost) mountHost.appendChild(selector.node);
  }

  function teardownSelector(selector) {
    selector?.node?.remove();
    if (selector?.mountHost) unpatchHostPosition(selector.mountHost);
    if (selector) {
      selector.mediaHost = null;
      selector.mountHost = null;
    }
  }

  function patchHostPosition(host) {
    const existing = patchedHosts.get(host);
    if (existing) {
      existing.count += 1;
      return;
    }
    const patch = {
      count: 1,
      value: host.style.getPropertyValue("position"),
      priority: host.style.getPropertyPriority("position"),
      changed: getComputedStyle(host).position === "static"
    };
    if (patch.changed) host.style.setProperty("position", "relative");
    patchedHosts.set(host, patch);
  }

  function unpatchHostPosition(host) {
    const patch = patchedHosts.get(host);
    if (!patch) return;
    patch.count -= 1;
    if (patch.count > 0) return;
    if (patch.changed) {
      if (patch.value) host.style.setProperty("position", patch.value, patch.priority);
      else host.style.removeProperty("position");
    }
    patchedHosts.delete(host);
  }

  function schedulePositions() {
    if (state.positionFrame !== null) return;
    state.positionFrame = requestAnimationFrame(() => {
      state.positionFrame = null;
      state.selectors.forEach((selector) => {
        const mediaRect = selector.mediaHost?.getBoundingClientRect?.();
        const mountRect = selector.mountHost?.getBoundingClientRect?.();
        const visible = mediaRect && mountRect && mediaRect.width > 0 && mediaRect.height > 0
          && mediaRect.bottom > 0 && mediaRect.right > 0 && mediaRect.top < innerHeight && mediaRect.left < innerWidth;
        selector.node.hidden = !visible;
        if (!visible) return;
        const mediaTop = mediaRect.top - mountRect.top + selector.mountHost.scrollTop;
        const mediaLeft = mediaRect.left - mountRect.left + selector.mountHost.scrollLeft;
        const maxTop = mediaTop + Math.max(0, mediaRect.height - selector.node.offsetHeight);
        const maxLeft = mediaLeft + Math.max(0, mediaRect.width - selector.node.offsetWidth);
        selector.node.style.top = `${Math.min(maxTop, mediaTop + 10)}px`;
        selector.node.style.left = `${Math.min(maxLeft, mediaLeft + 10)}px`;
      });
    });
  }

  function cleanup() {
    removeEventListener("scroll", handleViewportChange);
    removeEventListener("resize", handleViewportChange);
    removeEventListener("popstate", handleNavigation);
    removeEventListener("hashchange", handleNavigation);
    state.observer?.disconnect();
    state.scanScheduler?.cancel();
    clearInterval(state.routeTimer);
    if (state.positionFrame !== null) cancelAnimationFrame(state.positionFrame);
    state.selectors.forEach(teardownSelector);
    state.session = null;
    state.extractor = null;
    state.selectors.clear();
    state.selected.clear();
    state.persisted.clear();
    state.presenceChecked.clear();
    state.presencePending.clear();
    state.observer = null;
    state.scanScheduler = null;
    state.routeTimer = null;
    state.positionFrame = null;
    state.stagedFingerprint = "";
  }

  function candidateFingerprint(candidate) {
    return JSON.stringify(candidate || {});
  }

  function messageError(response) {
    const error = new Error(response?.error?.message || "Selection could not be updated.");
    error.code = response?.error?.code;
    return error;
  }

  function showTransient(text, error = false) {
    document.querySelector(".wbh-selector-transient")?.remove();
    const node = document.createElement("p");
    node.className = "wbh-selector-transient";
    node.classList.toggle("is-error", error);
    node.setAttribute("role", "status");
    node.textContent = text;
    document.documentElement.append(node);
    setTimeout(() => node.remove(), 4000);
  }

  function injectStyles() {
    if (document.getElementById("wbh-media-selector-style")) return;
    const style = document.createElement("style");
    style.id = "wbh-media-selector-style";
    style.textContent = `
      .wbh-media-selector-host {
        position: absolute; top: 10px; left: 10px; z-index: 2147483646;
        display: inline-block; min-width: 84px; min-height: 34px;
        user-select: none; pointer-events: auto;
      }
      .wbh-selector-transient {
        position: fixed; z-index: 2147483647; right: 12px; bottom: 12px; max-width: 360px;
        margin: 0; border: 1px solid #34332f; border-radius: 3px;
        padding: 10px 12px; background: #fbfaf5; color: #171715;
        box-shadow: 4px 4px 0 #171715;
        font: 700 12px/1.4 ui-monospace, "Cascadia Mono", "SFMono-Regular", Consolas, monospace;
      }
      .wbh-selector-transient.is-error { color: #72251d; }
    `;
    document.documentElement.appendChild(style);
  }

  function selectorControlStyles() {
    return `
      :host { display: inline-block; min-width: 84px; min-height: 34px; }
      *, *::before, *::after { box-sizing: border-box; }
      .wbh-media-selector {
        display: inline-flex; align-items: center; gap: 7px; min-width: 84px; min-height: 34px;
        justify-content: flex-start; padding: 7px 9px; border-radius: 3px;
        border: 1px solid #fbfaf5;
        background: #171715; color: #fbfaf5;
        font: 750 12px/1.2 ui-monospace, "Cascadia Mono", "SFMono-Regular", Consolas, monospace;
        box-shadow: 3px 3px 0 #fbfaf5;
        cursor: pointer; user-select: none; touch-action: manipulation;
      }
      .wbh-media-selector.is-selected { border-color: #171715; background: #fbfaf5; color: #171715; box-shadow: 3px 3px 0 #171715; }
      .wbh-media-selector.is-persisted { cursor: default; }
      .wbh-media-selector:focus-visible { outline: 3px solid #fbfaf5; outline-offset: 3px; box-shadow: 0 0 0 6px #171715; }
      .accumcapture-checkmark {
        width: 18px; height: 18px; flex: 0 0 18px; display: grid; place-items: center;
        border-radius: 2px; border: 1px solid currentcolor;
        background: transparent; color: inherit;
        font-size: 12px; font-weight: 800; line-height: 1;
      }
      .wbh-media-selector.is-selected .accumcapture-checkmark { background: #171715; color: #fbfaf5; }
      .accumcapture-badge { pointer-events: none; letter-spacing: 0.01em; }
    `;
  }
})(globalThis);
