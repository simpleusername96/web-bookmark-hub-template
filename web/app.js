(function initializeBookmarkHub(global) {
  "use strict";

  const VIEW_STORAGE_KEY = "web-bookmark-hub:view";
  const SIDEBAR_STORAGE_KEY = "web-bookmark-hub:sidebar-collapsed";
  const ALLOWED_VIEWS = new Set(["grid", "feed", "list"]);
  const PAGE_SIZE = 8;
  const MAX_SELECTION = 100;

  function readSavedView() {
    try {
      const saved = global.localStorage.getItem(VIEW_STORAGE_KEY);
      return ALLOWED_VIEWS.has(saved) ? saved : "grid";
    } catch (_error) {
      return "grid";
    }
  }

  function saveView(view) {
    try {
      global.localStorage.setItem(VIEW_STORAGE_KEY, view);
    } catch (_error) {
      // A file URL may deny storage. View selection still works for this page lifetime.
    }
  }

  function readSidebarCollapsed() {
    try {
      return global.localStorage.getItem(SIDEBAR_STORAGE_KEY) === "true";
    } catch (_error) {
      return false;
    }
  }

  function saveSidebarCollapsed(collapsed) {
    try {
      global.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(collapsed));
    } catch (_error) {
      // File URL storage may be unavailable. The control still works for this page lifetime.
    }
  }

  function installTooltipBehavior(documentRef) {
    let activeTooltip = null;
    let suppressedTooltip = null;

    function tooltipTrigger(target) {
      return target?.closest?.("[data-tooltip]") || null;
    }

    function hideTooltip(options) {
      if (!activeTooltip) return false;
      if (options?.suppress) suppressedTooltip = activeTooltip;
      activeTooltip.classList.remove("is-tooltip-visible");
      activeTooltip = null;
      return true;
    }

    function showTooltip(trigger) {
      if (!trigger?.dataset.tooltip || trigger === suppressedTooltip) return;
      if (activeTooltip !== trigger) hideTooltip();
      activeTooltip = trigger;
      trigger.classList.add("is-tooltip-visible");
    }

    function closeOpenHelp(options) {
      const open = Array.from(documentRef.querySelectorAll("details.settings-help[open]")).at(-1);
      if (!open) return false;
      open.open = false;
      if (options?.returnFocus) open.querySelector("summary")?.focus();
      return true;
    }

    documentRef.addEventListener("pointerover", (event) => showTooltip(tooltipTrigger(event.target)));
    documentRef.addEventListener("pointerout", (event) => {
      const trigger = tooltipTrigger(event.target);
      if (trigger?.contains?.(event.relatedTarget)) return;
      if (trigger === activeTooltip) hideTooltip();
      if (suppressedTooltip === trigger) suppressedTooltip = null;
    });
    documentRef.addEventListener("focusin", (event) => showTooltip(tooltipTrigger(event.target)));
    documentRef.addEventListener("focusout", (event) => {
      const trigger = tooltipTrigger(event.target);
      if (trigger?.contains?.(event.relatedTarget)) return;
      if (trigger === activeTooltip) hideTooltip();
      if (suppressedTooltip === trigger) suppressedTooltip = null;
    });
    documentRef.addEventListener("toggle", (event) => {
      const opened = event.target;
      if (!opened?.matches?.("details.settings-help") || !opened.open) return;
      documentRef.querySelectorAll("details.settings-help[open]").forEach((candidate) => {
        if (candidate !== opened) candidate.open = false;
      });
      hideTooltip({ suppress: true });
    }, true);
    documentRef.addEventListener("pointerdown", (event) => {
      const open = Array.from(documentRef.querySelectorAll("details.settings-help[open]")).at(-1);
      if (open && !open.contains(event.target)) open.open = false;
      if (activeTooltip && tooltipTrigger(event.target) !== activeTooltip) hideTooltip({ suppress: true });
    }, true);
    documentRef.addEventListener("click", (event) => {
      if (tooltipTrigger(event.target) === activeTooltip) hideTooltip({ suppress: true });
    });
    documentRef.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      if (!closeOpenHelp({ returnFocus: true }) && !hideTooltip({ suppress: true })) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
  }

  function isHttpUrl(value) {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch (_error) {
      return false;
    }
  }

  function start() {
    const View = global.WBHView;
    const QueryState = global.WBHQueryState;
    const SortModel = global.WBHSortModel;
    const ContentTypes = global.WBHContentTypes;
    const DetailNavigation = global.WBHDetailNavigation;
    const TagSuggestions = global.WBHTagSuggestions;
    const UiLanguage = global.WBHUiLanguage;
    const ResponsiveWorkflows = global.WBHResponsiveWorkflows;
    const createSettingsController = global.WBHCreateSettingsController;
    const createSource = global.WBH_CREATE_SOURCE;

    if (!View || !QueryState || !SortModel || !ContentTypes || !DetailNavigation || !TagSuggestions || !UiLanguage || !ResponsiveWorkflows || typeof createSettingsController !== "function" || typeof createSource !== "function") {
      const status = document.getElementById("app-status");
      if (status) {
        status.textContent = UiLanguage?.text ? UiLanguage.text("app.startMissing") : "The application could not start because a required file is missing.";
      }
      return;
    }
    const t = (key, values) => UiLanguage.text(key, values);
    UiLanguage.apply(document);

    let source;
    try {
      source = createSource();
    } catch (error) {
      const status = document.getElementById("app-status");
      if (status) status.textContent = error instanceof Error ? error.message : t("app.startFailed");
      return;
    }
    const demoMode = source.baseUrl === "demo://synthetic/";
    const elements = {
      addError: document.getElementById("add-form-error"),
      addResult: document.getElementById("add-form-result"),
      addComment: document.getElementById("add-comment-input"),
      addKind: document.getElementById("add-kind-input"),
      addFolder: document.getElementById("add-folder-input"),
      addVisibility: document.getElementById("add-visibility-input"),
      addForm: document.getElementById("add-form"),
      addOptions: document.getElementById("add-options"),
      addOptionsState: document.getElementById("add-options-state"),
      addTags: document.getElementById("add-tags-input"),
      addTitle: document.getElementById("add-title-input"),
      addUrl: document.getElementById("add-url-input"),
      chromeApproveButton: document.getElementById("chrome-approve-button"),
      chromeClients: document.getElementById("chrome-clients"),
      chromeClientsShowAll: document.getElementById("chrome-clients-show-all"),
      chromeConnectionGuidance: document.getElementById("chrome-connection-guidance"),
      chromeConnectionRequest: document.getElementById("chrome-connection-request"),
      chromeError: document.getElementById("chrome-error"),
      aiUrlSummaryError: document.getElementById("ai-url-summary-error"),
      aiUrlSummaryCount: document.getElementById("ai-url-summary-count"),
      aiUrlSummaryStart: document.getElementById("ai-url-summary-start"),
      aiUrlSummaryStatus: document.getElementById("ai-url-summary-status"),
      detailContent: document.getElementById("detail-content"),
      detailDialog: document.getElementById("detail-dialog"),
      detailPrevious: document.getElementById("detail-previous"),
      detailNext: document.getElementById("detail-next"),
      defaultViewButton: document.getElementById("default-view-button"),
      batchBar: document.getElementById("batch-bar"),
      batchDialog: document.getElementById("batch-dialog"),
      batchDialogBody: document.getElementById("batch-dialog-body"),
      batchStatus: document.getElementById("batch-status"),
      batchValueLabel: document.getElementById("batch-value-label"),
      mobileSelection: document.getElementById("mobile-selection"),
      mobileSelectedCount: document.getElementById("mobile-selected-count"),
      mobileBatchOpen: document.getElementById("mobile-batch-open"),
      mobileBatchDone: document.getElementById("mobile-batch-done"),
      batchSelectAll: document.getElementById("batch-select-all"),
      batchSelectResults: document.getElementById("batch-select-results"),
      batchSelectedCount: document.getElementById("batch-selected-count"),
      batchOperation: document.getElementById("batch-operation"),
      batchFolder: document.getElementById("batch-folder"),
      batchTags: document.getElementById("batch-tags"),
      batchKind: document.getElementById("batch-kind"),
      batchVisibility: document.getElementById("batch-visibility"),
      batchApply: document.getElementById("batch-apply"),
      batchAiSummary: document.getElementById("batch-ai-summary"),
      batchDone: document.getElementById("batch-done"),
      filterButton: document.getElementById("filter-button"),
      filterDialog: document.getElementById("filter-dialog"),
      filterForm: document.getElementById("filter-form"),
      filterFolder: document.getElementById("filter-folder"),
      filterKind: document.getElementById("filter-kind"),
      filterPreview: document.getElementById("filter-preview"),
      filterPreviewHint: document.getElementById("filter-preview-hint"),
      filterReset: document.getElementById("filter-reset-button"),
      filterRecentPreset: document.getElementById("filter-recent-preset"),
      filterSavedFrom: document.getElementById("filter-saved-from"),
      filterSavedTo: document.getElementById("filter-saved-to"),
      filterSource: document.getElementById("filter-source"),
      filterTag: document.getElementById("filter-tag"),
      filterVisibility: document.getElementById("filter-visibility"),
      folderCreateForm: document.getElementById("folder-create-form"),
      folderCreateName: document.getElementById("folder-create-name"),
      folderCreateParent: document.getElementById("folder-create-parent"),
      folderManagerError: document.getElementById("folder-manager-error"),
      folderManagerList: document.getElementById("folder-manager-list"),
      feedLoader: document.getElementById("feed-loader"),
      feedLoadMore: document.getElementById("feed-load-more"),
      feedLoadStatus: document.getElementById("feed-load-status"),
      appShell: document.getElementById("app-shell"),
      pagination: document.getElementById("pagination"),
      pageTitle: document.getElementById("page-title"),
      policyDefaultForm: document.getElementById("policy-default-form"),
      policyDefaultStorage: document.getElementById("policy-default-storage"),
      policyDefaultVisibility: document.getElementById("policy-default-visibility"),
      policyError: document.getElementById("policy-error"),
      policyRuleError: document.getElementById("policy-rule-error"),
      policyRuleStatus: document.getElementById("policy-rule-status"),
      policyRuleForm: document.getElementById("policy-rule-form"),
      policyRuleKind: document.getElementById("policy-rule-kind"),
      policyRuleMode: document.getElementById("policy-rule-mode"),
      policyRulePrefix: document.getElementById("policy-rule-prefix"),
      policyRuleTags: document.getElementById("policy-rule-tags"),
      policyRules: document.getElementById("policy-rules"),
      policyRuleToggle: document.getElementById("policy-rule-toggle"),
      policyRuleVisibility: document.getElementById("policy-rule-visibility"),
      resultCount: document.getElementById("result-count"),
      activeFilterSummary: document.getElementById("active-filter-summary"),
      activeFilterChips: document.getElementById("active-filter-chips"),
      clearFiltersButton: document.getElementById("clear-filters-button"),
      results: document.getElementById("results"),
      resultsSection: document.querySelector(".results-section"),
      resultsHeader: document.querySelector(".results-header"),
      search: document.getElementById("search-input"),
      settingsButton: document.getElementById("settings-button"),
      settingsDialog: document.getElementById("settings-dialog"),
      settingsView: document.getElementById("settings-view-select"),
      uiLanguage: document.getElementById("ui-language"),
      settingsPanels: Array.from(document.querySelectorAll("[data-settings-content]")),
      settingsTabs: Array.from(document.querySelectorAll("[data-settings-panel]")),
      sidebarToggle: document.getElementById("sidebar-toggle"),
      sortControl: document.getElementById("sort-control"),
      sortTrigger: document.getElementById("sort-trigger"),
      sortPopover: document.getElementById("sort-popover"),
      sortOptions: Array.from(document.querySelectorAll("[data-sort-value]")),
      viewScopeLabel: document.getElementById("view-scope-label"),
    };

    function renderContentTypeOptions(select, options) {
      if (!select) return;
      select.replaceChildren();
      if (options?.includeAutomatic) {
        const automatic = document.createElement("option");
        automatic.value = "";
        automatic.textContent = t("form.autoFromUrl");
        select.append(automatic);
      }
      if (options?.includeAny) {
        const any = document.createElement("option");
        any.value = "";
        any.textContent = options?.anyLabel || "Any";
        select.append(any);
      }
      ContentTypes.TYPES.forEach((type) => {
        const option = document.createElement("option");
        option.value = type.value;
        option.textContent = type.label;
        select.append(option);
      });
    }

    function rerenderOptions(select, render) {
      if (!select) return;
      const value = select.value;
      render();
      select.value = value;
    }

    renderContentTypeOptions(elements.filterKind, { includeAny: true });
    renderContentTypeOptions(elements.addKind, { includeAutomatic: true });
    renderContentTypeOptions(elements.batchKind);

    const restoredQuery = QueryState.readLocation(new URL(global.location.href).searchParams, { view: readSavedView() });
    const state = {
      search: restoredQuery.search,
      filters: restoredQuery.filters,
      sort: restoredQuery.sort,
      page: restoredQuery.page,
      sidebarCollapsed: readSidebarCollapsed(),
      view: restoredQuery.view,
      serviceCapabilities: {},
      management: false,
      batchBusy: false,
      selectedIds: new Set(),
      selectedQuery: null,
      selectionAnchorId: null,
      currentItems: [],
      total: 0,
      totalPages: 0,
      pageSize: PAGE_SIZE,
      feedNextPage: 2,
      feedHasMore: false,
      feedLoading: false,
      feedError: null,
      detailEntryId: null,
      detailBusy: false,
    };

    let refreshVersion = 0;
    let refreshController = null;
    let detailLoadVersion = 0;
    let detailController = null;
    let searchTimer = null;
    let dialogReturnTarget = null;
    let responsive = null;
    let folderTree = [];
    let folderTreeLoaded = false;
    let feedObserver = null;
    let activationRefreshReady = false;
    let lastActivationRefreshAt = 0;
    let renderedResultsKey = null;
    const settingsController = createSettingsController({
      source,
      elements,
      document,
      i18n: UiLanguage,
      confirm: global.confirm.bind(global),
      setStatus: View.setStatus,
      refreshEntries: refresh,
      connectExtension: sendPairingToExtension,
      onConnectionApproved: clearConnectionRequest,
      async onFoldersChanged() {
        folderTreeLoaded = false;
        await refresh();
      },
    });
    UiLanguage.bind(elements.uiLanguage, document);

    function attachTagSuggestions(input) {
      return TagSuggestions.create({
        input,
        document,
        fetchSuggestions(options) { return source.suggestTags(options); }
      });
    }

    function sendPairingToExtension(extensionId, pairing) {
      return new Promise((resolve, reject) => {
        if (!global.chrome?.runtime?.sendMessage) {
          reject(new Error("Chrome extension messaging is unavailable in this browser."));
          return;
        }
        global.chrome.runtime.sendMessage(extensionId, {
          type: "WBH_PAIR_WITH_CODE",
          code: pairing.code,
          label: pairing.label
        }, (response) => {
          if (global.chrome.runtime.lastError || !response?.ok) {
            reject(new Error(response?.error?.message || "The extension did not accept the connection."));
            return;
          }
          resolve(response.data);
        });
      });
    }

    function connectionRequestId() {
      return new URL(global.location.href).searchParams.get("connect") || "";
    }

    function clearConnectionRequest() {
      const url = new URL(global.location.href);
      url.searchParams.delete("connect");
      global.history.replaceState(global.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    }

    function syncQueryLocation() {
      const url = QueryState.writeLocation(global.location.href, state);
      global.history.replaceState(global.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    }

    function refreshAfterExternalChange() {
      if (!activationRefreshReady || document.visibilityState === "hidden") return;
      const now = Date.now();
      if (now - lastActivationRefreshAt < 750) return;
      lastActivationRefreshAt = now;
      folderTreeLoaded = false;
      void refresh();
    }

    function syncManagementState(options) {
      const next = state.selectedIds.size > 0 || Boolean(state.selectedQuery);
      state.management = next;
      elements.appShell.classList.toggle("is-managing", next);
      View.syncRenderedManagement(elements.results, next, renderedSelectedIds());
      updateBatchControls();
      if (!next && options?.focusEntryId !== undefined && options.focusEntryId !== null) {
        elements.results.querySelector(`[data-entry-id="${String(options.focusEntryId)}"]`)?.focus();
      }
    }

    function clearSelection(options) {
      elements.batchStatus.textContent = "";
      document.getElementById("batch-editor-feedback").textContent = "";
      state.selectedIds = new Set();
      state.selectedQuery = null;
      state.selectionAnchorId = null;
      syncManagementState(options);
    }

    function updateBatchControls() {
      const querySelected = Boolean(state.selectedQuery);
      const selectedCount = querySelected ? state.selectedQuery.expectedCount : state.selectedIds.size;
      const visibleIds = state.currentItems.map((entry) => entry.id);
      const selectableIds = visibleIds.slice(0, MAX_SELECTION);
      const selectedVisible = querySelected ? selectableIds.length : selectableIds.filter((id) => state.selectedIds.has(id)).length;
      elements.batchBar.hidden = !state.management;
      elements.batchSelectedCount.textContent = t("selection.mobileCount", { count: selectedCount });
      elements.batchSelectAll.checked = selectableIds.length > 0 && selectedVisible === selectableIds.length;
      elements.batchSelectAll.indeterminate = selectedVisible > 0 && selectedVisible < selectableIds.length;
      elements.batchSelectResults.hidden = !state.management || state.total < 1 || (!querySelected && selectedCount >= state.total);
      elements.batchSelectResults.setAttribute("aria-pressed", String(querySelected));
      elements.batchSelectResults.textContent = t(querySelected ? "selection.allSelected" : "selection.selectAll", { count: querySelected ? selectedCount : state.total });
      const permanentDeleteAvailable = state.serviceCapabilities.permanent_delete === true;
      const deleteOption = elements.batchOperation.querySelector('option[value="delete"]');
      if (deleteOption) deleteOption.disabled = !permanentDeleteAvailable;
      elements.batchApply.disabled = selectedCount === 0
        || state.batchBusy
        || (elements.batchOperation.value === "delete" && !permanentDeleteAvailable);
      elements.batchAiSummary.disabled = selectedCount === 0 || state.batchBusy;
      document.querySelectorAll("[data-batch-action]").forEach((button) => { button.disabled = state.batchBusy || (button.dataset.batchAction === "delete" && !permanentDeleteAvailable); });
      if (elements.batchOperation.value === "delete" && !permanentDeleteAvailable) {
        elements.batchApply.dataset.tooltip = t("error.restartForDelete");
      } else {
        elements.batchApply.removeAttribute("data-tooltip");
      }
      responsive?.syncSelection(selectedCount);
    }

    function syncSortControl() {
      const presentation = SortModel.describe(state.sort);
      elements.sortTrigger.replaceChildren(document.createTextNode(presentation.triggerLabel.replace(/[↑↓]/g,'').trim()), global.WBHIcons.create(presentation.triggerLabel.includes('↑')?'up':'down'));
      elements.sortTrigger.setAttribute("aria-label", `Sort: ${presentation.criterionLabel}, ${presentation.directionLabel}`);
      elements.sortOptions.forEach((button) => {
        const selected = button.dataset.sortValue === presentation.sort;
        button.setAttribute("aria-checked", String(selected));
        button.tabIndex = selected ? 0 : -1;
      });
    }

    function closeSortPopover(options) {
      if (elements.sortPopover.hidden) return;
      elements.sortPopover.hidden = true;
      elements.sortTrigger.setAttribute("aria-expanded", "false");
      if (options?.returnFocus) elements.sortTrigger.focus();
    }

    function openSortPopover(options) {
      responsive?.revealHeader();
      elements.sortPopover.hidden = false;
      elements.sortTrigger.setAttribute("aria-expanded", "true");
      syncSortControl();
      if (options?.focusOption) {
        elements.sortOptions.find((button) => button.getAttribute("aria-checked") === "true")?.focus();
      }
    }

    function commitSort(value) {
      const next = SortModel.canonical(value);
      if (state.sort === next) {
        closeSortPopover({ returnFocus: true });
        return;
      }
      state.sort = next;
      state.page = 1;
      clearSelection();
      syncSortControl();
      closeSortPopover({ returnFocus: true });
      void refresh();
    }

    function renderedSelectedIds() {
      return state.selectedQuery
        ? new Set(state.currentItems.map((entry) => entry.id))
        : state.selectedIds;
    }

    function renderCurrentResults(options) {
      const appendItems = Array.isArray(options?.appendItems) ? options.appendItems : null;
      View.renderResults({
        container: elements.results,
        items: appendItems || state.currentItems,
        append: Boolean(appendItems),
        view: state.view,
        management: state.management,
        selectedIds: renderedSelectedIds(),
        emptyState: emptyResultState(),
        onSelect(entryId, options) {
          elements.batchStatus.textContent = "";
          if (state.selectedQuery) state.selectedQuery = null;
          const next = View.nextSelection(
            state.currentItems,
            state.selectedIds,
            state.selectionAnchorId,
            entryId,
            { ...options, maxSelected: MAX_SELECTION }
          );
          state.selectedIds = next.selectedIds;
          state.selectionAnchorId = next.anchorId;
          syncManagementState(options?.preserveFocus ? undefined : { focusEntryId: entryId });
          if (next.limitReached) View.setStatus(t("selection.max", { count: MAX_SELECTION }), "error");
        },
        onOpen: openDetail,
      });
      renderedResultsKey = View.resultsRenderKey(state.currentItems, state.view);
      updateBatchControls();
    }

    function entryListQuery(page, signal) {
      return QueryState.entryQuery({
        filters: state.filters, search: state.search, sort: state.sort, view: state.view,
        page, pageSize: PAGE_SIZE, signal
      });
    }

    function renderCurrentPagination() {
      View.renderPagination({
        container: elements.pagination,
        page: state.page,
        totalPages: state.view === "feed" ? 0 : state.totalPages,
        total: state.total,
        pageSize: state.pageSize,
        onPage(nextPage) {
          state.page = nextPage;
          clearSelection();
          void refresh().then(() => elements.pagination.querySelector('[aria-current="page"]')?.focus({ preventScroll: true }));
        },
      });
    }

    function updateFeedLoader() {
      const visible = state.view === "feed" && (state.feedHasMore || state.feedLoading || state.feedError);
      elements.feedLoader.hidden = !visible;
      elements.feedLoader.setAttribute("aria-busy", String(state.feedLoading));
      elements.feedLoadMore.disabled = state.feedLoading || !state.feedHasMore;
      elements.feedLoadMore.textContent = t(state.feedError ? "action.retry" : "action.loadMore");
      elements.feedLoadStatus.textContent = state.feedLoading
        ? t("app.loadingMore")
        : state.feedError || "";
      if (feedObserver) {
        feedObserver.unobserve(elements.feedLoader);
        if (visible && state.feedHasMore && !state.feedLoading && !state.feedError) feedObserver.observe(elements.feedLoader);
      }
    }

    async function loadMoreFeed() {
      if (state.view !== "feed" || state.feedLoading || !state.feedHasMore) return [];
      const version = refreshVersion;
      const signal = refreshController?.signal;
      state.feedLoading = true;
      state.feedError = null;
      updateFeedLoader();
      try {
        const result = await source.listEntries(entryListQuery(state.feedNextPage, signal));
        if (version !== refreshVersion || state.view !== "feed") return [];
        const knownIds = new Set(state.currentItems.map((entry) => entry.id));
        const appended = result.items.filter((entry) => !knownIds.has(entry.id));
        state.currentItems.push(...appended);
        state.page = result.page;
        state.total = result.total;
        state.totalPages = result.total_pages;
        state.pageSize = result.page_size;
        state.feedNextPage = result.page + 1;
        state.feedHasMore = result.page < result.total_pages;
        renderCurrentResults({ appendItems: appended });
        return appended;
      } catch (error) {
        if (version !== refreshVersion || error?.name === "AbortError") return [];
        state.feedError = error instanceof Error ? error.message : "More image URLs could not be loaded.";
        return [];
      } finally {
        if (version === refreshVersion && state.view === "feed") {
          state.feedLoading = false;
          updateFeedLoader();
        }
      }
    }

    function updateBatchValueControl() {
      elements.batchStatus.textContent = "";
      const operation = elements.batchOperation.value;
      elements.batchFolder.hidden = operation !== "set_folder";
      elements.batchTags.hidden = operation !== "add_tags" && operation !== "remove_tags";
      if (elements.batchTags.parentElement?.classList.contains("tag-combobox")) {
        elements.batchTags.parentElement.hidden = elements.batchTags.hidden;
      }
      elements.batchKind.hidden = operation !== "set_kind";
      elements.batchVisibility.hidden = operation !== "set_visibility";
      const fields = {
        set_folder: [elements.batchFolder, "Folder"], add_tags: [elements.batchTags, "Tags"],
        remove_tags: [elements.batchTags, "Tags"], set_kind: [elements.batchKind, "Content type"],
        set_visibility: [elements.batchVisibility, "Visibility"]
      };
      elements.batchValueLabel.hidden = !fields[operation];
      if (fields[operation]) {
        elements.batchValueLabel.htmlFor = fields[operation][0].id;
        elements.batchValueLabel.textContent = fields[operation][1];
      }
    }

    function setActiveView(view) {
      state.view = ALLOWED_VIEWS.has(view) ? view : "grid";
      if (elements.settingsView) elements.settingsView.value = state.view;
      saveView(state.view);
      if (state.view === "feed") elements.viewScopeLabel.textContent = t("app.viewFeed");
      else if (state.view === "list") elements.viewScopeLabel.textContent = t("app.viewList");
      else elements.viewScopeLabel.textContent = t("app.viewGrid");
      renderActiveFilters();
    }

    function setSidebarCollapsed(collapsed) {
      state.sidebarCollapsed = Boolean(collapsed);
      elements.appShell.classList.toggle("is-sidebar-collapsed", state.sidebarCollapsed);
      const mobileDrawer = global.matchMedia?.("(max-width: 900px)").matches === true;
      const expanded = mobileDrawer
        ? elements.appShell.classList.contains("is-mobile-sidebar-open")
        : !state.sidebarCollapsed;
      elements.sidebarToggle.setAttribute("aria-expanded", String(expanded));
      const label = t(expanded ? "sidebar.hide" : "sidebar.show");
      elements.sidebarToggle.setAttribute("aria-label", label);
      elements.sidebarToggle.dataset.tooltip = label;
      saveSidebarCollapsed(state.sidebarCollapsed);
    }

    function updateFilterControl() {
      const active = activeFilterItems().some((item) => !item.fixed);
      const title = active ? t("filter.active", { count: activeFilterItems().filter((item) => !item.fixed).length }) : t("action.openFilters");
      elements.filterButton.classList.toggle("is-active", active);
      elements.filterButton.setAttribute("aria-label", active ? `${t("action.openFilters")}, ${title}` : t("action.openFilters"));
      elements.filterButton.dataset.tooltip = active ? title : t("action.openFilters");
    }

    function chooseStructure(type, value, label) {
      state.filters = QueryState.selectStructure(state.filters, type, value, label);
      state.page = 1;
      clearSelection();
      updateFilterControl();
      renderActiveFilters();
      if (elements.filterDialog.open) elements.filterDialog.close();
      void refresh();
    }

    function activeFilterItems() {
      return QueryState.activeItems(state.filters, state.view);
    }

    function renderActiveFilters() {
      if (!elements.activeFilterChips) return;
      const items = activeFilterItems();
      elements.activeFilterChips.replaceChildren();
      items.forEach((item) => {
        const chip = document.createElement(item.fixed ? "span" : "button");
        chip.className = `active-filter-chip${item.fixed ? " is-fixed" : ""}`;
        chip.textContent = item.label;
        if (!item.fixed) chip.append(global.WBHIcons.create("close"));
        if (!item.fixed) {
          chip.type = "button";
          chip.setAttribute("aria-label", t("filter.remove", { label: item.label }));
          chip.addEventListener("click", () => removeFilter(item.key));
        }
        elements.activeFilterChips.append(chip);
      });
      elements.activeFilterSummary.hidden = items.length === 0;
      elements.clearFiltersButton.hidden = !items.some((item) => !item.fixed);
      updateFilterControl();
    }

    function removeFilter(key) {
      state.filters = QueryState.removeFilter(state.filters, key);
      state.page = 1;
      clearSelection();
      syncFilterForm();
      renderActiveFilters();
      void refresh();
    }

    function clearAllFilters() {
      state.filters = QueryState.emptyFilters();
      state.page = 1;
      clearSelection();
      syncFilterForm();
      renderActiveFilters();
      void refresh();
    }

    function clearSearch() {
      global.clearTimeout(searchTimer);
      searchTimer = null;
      elements.search.value = "";
      state.search = "";
      state.page = 1;
      clearSelection();
      elements.search.focus();
      void refresh();
    }

    function showAllEntries() {
      global.clearTimeout(searchTimer);
      searchTimer = null;
      elements.search.value = "";
      state.search = "";
      state.filters = QueryState.emptyFilters();
      state.page = 1;
      clearSelection();
      setActiveView("grid");
      syncFilterForm();
      elements.search.focus();
      void refresh();
    }

    function emptyResultState() {
      const showAll = { label: t("action.showAllEntries"), onClick: showAllEntries };
      const add = { label: t("action.addUrl"), onClick() { void openSettingsDialog("add"); } };
      const actions = state.search
        ? [{ label: t("action.clearSearch"), onClick: clearSearch }, showAll]
        : activeFilterItems().length || state.view !== "grid" ? [showAll, add] : [add];
      return { message: t("app.noMatches"), actions };
    }

    function returnToDefaultView() {
      global.clearTimeout(searchTimer);
      searchTimer = null;
      elements.search.value = "";
      state.search = "";
      state.filters = QueryState.defaultFilters();
      state.page = 1;
      clearSelection();
      syncFilterForm();
      renderActiveFilters();
      void refresh();
    }

    function syncFilterForm() {
      const filters = state.filters;
      const imposedPreview = state.view === "feed" ? "with" : state.view === "list" ? "without" : "";
      elements.filterPreview.value = imposedPreview || filters.preview;
      elements.filterPreview.disabled = Boolean(imposedPreview);
      elements.filterPreviewHint.textContent = imposedPreview
        ? `${state.view === "feed" ? "Feed" : "List"} fixes this filter.`
        : "";
      elements.filterKind.value = filters.kind;
      elements.filterSource.value = filters.sourceDomain;
      elements.filterVisibility.value = filters.visibility;
      elements.filterFolder.value = filters.folderId;
      elements.filterTag.value = filters.tag;
      elements.filterSavedFrom.value = filters.savedFrom ? String(filters.savedFrom).slice(0, 10) : "";
      elements.filterSavedTo.value = filters.savedTo ? String(filters.savedTo).slice(0, 10) : "";
      elements.filterRecentPreset.setAttribute("aria-pressed", String(filters.recentPreset === true));
      elements.filterRecentPreset.classList.toggle("is-active", filters.recentPreset === true);
    }

    function scopeTitle() {
      return QueryState.title(state.filters);
    }

    async function refreshSidebar(version, signal) {
      try {
        const query = QueryState.entryScopeQuery({
          filters: state.filters,
          search: state.search,
          view: state.view,
        });
        const [allFolders, folders, urlGroups] = await Promise.all([
          folderTreeLoaded ? Promise.resolve(folderTree) : source.listFolders({ signal }),
          source.listFolders({ query, signal }),
          source.listUrlGroups({ query, signal }),
        ]);

        if (version !== refreshVersion) return;
        folderTree = allFolders;
        folderTreeLoaded = true;
        View.renderSidebar({
          folders,
          urlGroups,
          activeStructure: { folderId: state.filters.folderId, urlGroupId: state.filters.urlGroupId },
          onStructure: chooseStructure,
        });
        View.renderFolderOptions(elements.addFolder, allFolders);
        View.renderFolderOptions(elements.batchFolder, allFolders);
        View.renderFolderOptions(elements.filterFolder, allFolders);
        if (elements.filterFolder.options[0]) elements.filterFolder.options[0].textContent = "Any Folder";
        syncFilterForm();
      } catch (_error) {
        if (version !== refreshVersion) return;
        View.renderSidebar({
          folders: [],
          urlGroups: [],
          error: "Facets unavailable",
          activeStructure: { folderId: state.filters.folderId, urlGroupId: state.filters.urlGroupId },
          onStructure: chooseStructure,
        });
      }
    }

    async function refresh() {
      syncQueryLocation();
      const currentVersion = ++refreshVersion;
      refreshController?.abort();
      refreshController = new AbortController();
      const signal = refreshController.signal;
      elements.resultsSection.setAttribute("aria-busy", "true");
      elements.pageTitle.textContent = scopeTitle();
      if (!elements.results.querySelector("[data-entry-id]")) {
        View.setStatus(t("app.loading"), "loading");
      }
      state.feedLoading = false;
      state.feedError = null;
      if (state.view === "feed") {
        state.page = 1;
        state.feedNextPage = 2;
        state.feedHasMore = false;
      }
      updateFeedLoader();

      try {
        const result = await source.listEntries(entryListQuery(state.page, signal));

        if (currentVersion !== refreshVersion) {
          return;
        }

        if (state.view !== "feed" && result.total_pages > 0 && state.page > result.total_pages) {
          state.page = result.total_pages;
          await refresh();
          return;
        }

        elements.resultCount.textContent = `${result.total} ${result.total === 1 ? "entry" : "entries"}`;
        state.page = result.page;
        state.total = result.total;
        state.totalPages = result.total_pages;
        state.pageSize = result.page_size;
        const nextResultsKey = View.resultsRenderKey(result.items, state.view);
        state.currentItems = result.items;
        state.feedNextPage = result.page + 1;
        state.feedHasMore = state.view === "feed" && result.page < result.total_pages;
        if (result.total === 0 || nextResultsKey !== renderedResultsKey) {
          renderCurrentResults();
        } else {
          View.syncRenderedManagement(elements.results, state.management, renderedSelectedIds());
          updateBatchControls();
        }
        renderCurrentPagination();
        if (elements.detailDialog.open) syncDetailNavigation();
        updateFeedLoader();
        await refreshSidebar(currentVersion, signal);
        if (currentVersion !== refreshVersion) {
          return;
        }
        elements.resultsSection.setAttribute("aria-busy", "false");

        View.setStatus("", "neutral");
      } catch (error) {
        if (currentVersion !== refreshVersion) {
          return;
        }
        if (error?.name === "AbortError") return;
        if (error?.code === "URL_GROUP_NOT_FOUND" && state.filters.urlGroupId) {
          state.filters.urlGroupId = "";
          state.filters.urlGroupLabel = "";
          renderActiveFilters();
          View.setStatus(t("error.urlGroupChanged"), "error");
          await refresh();
          return;
        }
        View.renderEmpty(elements.results, t("error.viewLoadGuidance"), [{ label: t("action.retry"), onClick() { void refresh(); } }]);
        renderedResultsKey = null;
        View.renderPagination({
          container: elements.pagination,
          page: 1,
          totalPages: 0,
          onPage() {},
        });
        state.feedHasMore = false;
        state.feedError = null;
        updateFeedLoader();
        View.setStatus(error instanceof Error ? error.message : t("error.viewLoad"), "error");
        elements.resultsSection.setAttribute("aria-busy", "false");
      }
    }

    async function renderOpenDetail(entryId, suppliedEntry, supplied) {
      const version = ++detailLoadVersion;
      if (detailController) detailController.abort();
      detailController = new AbortController();
      const signal = detailController.signal;
      const [entry, commentPage, assets] = await Promise.all([
        suppliedEntry || source.getEntry(entryId, { includeArchived: true, signal }),
        supplied?.commentPage || source.listComments(entryId, { page: 1, page_size: 100, signal }),
        supplied?.assets || source.listVisualAssets(entryId, { signal }),
      ]);

      if (version !== detailLoadVersion || signal.aborted) return false;

      if (!entry) {
        throw new RangeError("Entry not found.");
      }

      View.renderDetail({
        container: elements.detailContent,
        entry,
        commentPage: Array.isArray(commentPage)
          ? { items: commentPage, page: 1, page_size: commentPage.length, total: commentPage.length, total_pages: 1 }
          : commentPage,
        mode: supplied?.mode,
        noteDraft: supplied?.noteDraft,
        assets,
        folders: folderTree,
        attachTagSuggestions,
        deleteAvailable: state.serviceCapabilities.permanent_delete === true,
        deleteUnavailableReason: t("error.restartForDelete"),
        async onEdit(changes) {
          const updated = await source.editEntry(entryId, changes);
          await refresh();
          View.setStatus(t("status.entryUpdated"), "success");
          return updated;
        },
        async onDelete() {
          await source.deleteEntry(entryId);
          state.detailEntryId = null;
          if (elements.detailDialog.open) elements.detailDialog.close();
          clearSelection();
          await refresh();
          View.setStatus(t("status.urlDeleted"), "success");
        },
        async onSetCover(assetId) {
          await source.setCover(assetId);
          await renderOpenDetail(entryId);
          await refresh();
        },
        async onClearCover() {
          await source.clearCover(entryId);
          await renderOpenDetail(entryId);
          await refresh();
        },
        async onRemoveAsset(assetId) {
          await source.removeVisualAsset(assetId);
          await renderOpenDetail(entryId);
          await refresh();
        },
        async onComment(body) {
          await source.addComment(entryId, body);
          await renderOpenDetail(entryId, undefined, { mode: 'edit' });
          elements.detailContent.querySelector("#detail-comment")?.focus();
          View.setStatus(t("status.noteAdded"), "success");
        },
        async onLoadMoreComments() {
          const mode = elements.detailContent.dataset.mode;
          const noteDraft = elements.detailContent.querySelector('#detail-comment')?.value;
          const current = Array.isArray(commentPage?.items) ? commentPage : {
            items: Array.isArray(commentPage) ? commentPage : [],
            page: 1,
            page_size: 100,
            total: Array.isArray(commentPage) ? commentPage.length : 0,
            total_pages: 1
          };
          const next = await source.listComments(entryId, {
            page: Number(current.page || 1) + 1,
            page_size: 100,
            signal
          });
          if (version !== detailLoadVersion || signal.aborted) return;
          const combined = {
            ...next,
            items: [...current.items, ...(next.items || [])]
          };
          await renderOpenDetail(entryId, undefined, { commentPage: combined, assets, mode, noteDraft });
          const nextLoad = elements.detailContent.querySelector("[data-load-more-notes]");
          (nextLoad || elements.detailContent.querySelector("#detail-comment"))?.focus();
        },
      });
      return true;
    }

    function detailNavigationInput() {
      return {
        items: state.currentItems,
        entryId: state.detailEntryId,
        view: state.view,
        page: state.page,
        totalPages: state.totalPages,
        feedHasMore: state.feedHasMore
      };
    }

    function syncDetailNavigation() {
      const availability = DetailNavigation.navigationState(detailNavigationInput());
      elements.detailPrevious.disabled = state.detailBusy || !availability.previous;
      elements.detailNext.disabled = state.detailBusy || !availability.next;
      elements.detailDialog.setAttribute("aria-busy", String(state.detailBusy));
    }

    async function navigateDetail(direction) {
      if (state.detailBusy || !elements.detailDialog.open || !state.detailEntryId) return;
      if (typeof elements.detailContent.wbhFlushPendingEdits === "function") {
        const saved = await elements.detailContent.wbhFlushPendingEdits();
        if (!saved) return;
      }
      const target = DetailNavigation.navigationTarget(detailNavigationInput(), direction);
      if (target.type === "none") return;
      state.detailBusy = true;
      syncDetailNavigation();
      try {
        let targetEntryId = target.entryId || null;
        if (target.type === "page") {
          const result = await source.listEntries(entryListQuery(target.page));
          state.page = result.page;
          state.total = result.total;
          state.totalPages = result.total_pages;
          state.pageSize = result.page_size;
          state.currentItems = result.items;
          state.feedNextPage = result.page + 1;
          state.feedHasMore = false;
          renderCurrentResults();
          renderCurrentPagination();
          targetEntryId = DetailNavigation.boundaryEntryId(result.items, direction);
        } else if (target.type === "feed-more") {
          const appended = await loadMoreFeed();
          targetEntryId = DetailNavigation.boundaryEntryId(appended, "next");
        }
        if (!targetEntryId) {
          throw new Error(state.feedError || "The neighboring Entry could not be loaded.");
        }
        if (!(await renderOpenDetail(targetEntryId))) return;
        state.detailEntryId = targetEntryId;
        syncEntryLocation(targetEntryId, "replaceState");
      } catch (error) {
        View.setStatus(error instanceof Error ? error.message : t("error.neighborLoad"), "error");
      } finally {
        state.detailBusy = false;
        syncDetailNavigation();
      }
    }

    function locationEntryId() {
      const raw = new URL(global.location.href).searchParams.get("entry");
      return DetailNavigation.locationEntryId(raw, demoMode);
    }

    function syncEntryLocation(entryId, method) {
      const url = new URL(global.location.href);
      if (entryId) url.searchParams.set("entry", String(entryId));
      else url.searchParams.delete("entry");
      global.history[method || "pushState"]({}, "", url);
    }

    async function openDetail(entryId, trigger, options) {
      try {
        const opening = !elements.detailDialog.open;
        if (opening) dialogReturnTarget = trigger instanceof HTMLElement ? trigger : document.activeElement;
        if (!(await renderOpenDetail(entryId))) return;
        state.detailEntryId = entryId;
        if (opening) showDialog(elements.detailDialog);
        if (!options?.skipHistory && locationEntryId() !== entryId) {
          syncEntryLocation(entryId, options?.historyMethod || "pushState");
        }
        syncDetailNavigation();
        if (opening) elements.detailDialog.querySelector("[data-dialog-close]")?.focus();
      } catch (error) {
        if (error?.name === "AbortError") return;
        View.setStatus(error instanceof Error ? error.message : t("error.detailLoad"), "error");
      }
    }

    function resetAddForm(options) {
      elements.addForm.reset();
      elements.addKind.value = "";
      elements.addVisibility.value = "default";
      elements.addOptions.open = false;
      elements.addOptionsState.hidden = true;
      View.renderFolderOptions(elements.addFolder, folderTree);
      elements.addError.textContent = "";
      elements.addError.hidden = true;
      elements.addUrl.removeAttribute("aria-invalid");
      if (options?.clearResult !== false) {
        elements.addResult.replaceChildren();
        elements.addResult.hidden = true;
      }
    }

    function renderAddOutcome(outcome, context) {
      const alreadySaved = outcome?.outcome_code === "already_saved";
      const entryId = outcome?.entry?.id;
      let message = t("app.saved");
      if (alreadySaved) {
        const prefix = t(outcome?.entry?.deleted_at ? "app.duplicateArchived" : "app.duplicateActive");
        const fields = context?.suppliedFields || [];
        message = fields.length ? `${prefix} ${t("app.suppliedNotApplied", { fields: fields.join(", ") })}` : prefix;
      } else if (entryId && context?.isRendered === false) {
        message = t("app.hiddenAfterSave");
      }
      elements.addResult.replaceChildren(document.createTextNode(message));
      if (entryId) {
        const shortcut = document.createElement("button");
        shortcut.type = "button";
        shortcut.className = "status-entry-link";
        shortcut.textContent = t("action.openEntry");
        shortcut.addEventListener("click", () => {
          elements.settingsDialog.close();
          global.setTimeout(() => { void openDetail(entryId, elements.settingsButton); }, 0);
        });
        elements.addResult.append(" ", shortcut);
      }
      elements.addResult.hidden = false;
    }

    function openFilterDialog() {
      dialogReturnTarget = document.activeElement;
      syncFilterForm();
      showDialog(elements.filterDialog);
      elements.filterPreview.focus();
    }

    function applyFilters(event) {
      event.preventDefault();
      if (elements.filterSavedFrom.value && elements.filterSavedTo.value
        && elements.filterSavedFrom.value > elements.filterSavedTo.value) {
        View.setStatus(t("validation.dateRange"), "error");
        elements.filterSavedFrom.focus();
        return;
      }
      const selectedFolder = elements.filterFolder.selectedOptions[0];
      state.filters = QueryState.applyForm(state.filters, {
        preview: state.view === "grid" ? elements.filterPreview.value : state.filters.preview,
        kind: elements.filterKind.value,
        sourceDomain: elements.filterSource.value.trim().toLocaleLowerCase("en-US"),
        visibility: elements.filterVisibility.value,
        folderId: elements.filterFolder.value,
        folderLabel: elements.filterFolder.value ? selectedFolder?.textContent.trim() || elements.filterFolder.value : "",
        tag: elements.filterTag.value.trim(),
        savedFrom: elements.filterSavedFrom.value,
        savedTo: elements.filterSavedTo.value,
        urlGroupId: state.filters.urlGroupId,
        urlGroupLabel: state.filters.urlGroupLabel,
      });
      state.page = 1;
      clearSelection();
      renderActiveFilters();
      elements.filterDialog.close();
      void refresh();
    }

    async function submitAdd(event) {
      event.preventDefault();
      const url = elements.addUrl.value.trim();
      const title = elements.addTitle.value.trim();

      if (!isHttpUrl(url)) {
        elements.addError.textContent = t("validation.completeUrl");
        elements.addError.hidden = false;
        elements.addUrl.setAttribute("aria-invalid", "true");
        elements.addUrl.focus();
        return;
      }

      const submitButton = elements.addForm.querySelector('button[type="submit"]');
      submitButton.disabled = true;
      elements.addError.hidden = true;
      elements.addResult.hidden = true;
      elements.addUrl.removeAttribute("aria-invalid");

      try {
        const explicitPolicy = {};
        if (elements.addVisibility.value !== "default") explicitPolicy.visibility = elements.addVisibility.value;
        const tags = elements.addTags.value.split(",").map((tag) => tag.trim()).filter(Boolean);
        const comment = elements.addComment.value.trim();
        const folderId = elements.addFolder.value ? Number(elements.addFolder.value) : undefined;
        const suppliedFields = [
          title && "Title",
          comment && "Note",
          tags.length && "Tags",
          folderId && "Folder",
          elements.addKind.value && "Content type",
          elements.addVisibility.value !== "default" && "Visibility"
        ].filter(Boolean);
        const outcome = await source.addEntry({
          url,
          title,
          comment: comment || undefined,
          tags,
          folderId,
          kind: elements.addKind.value || undefined,
          ...explicitPolicy,
        });
        await refresh();
        if (outcome?.outcome_code === "created") resetAddForm({ clearResult: false });
        renderAddOutcome(outcome, {
          suppliedFields,
          isRendered: state.currentItems.some((entry) => entry.id === outcome?.entry?.id)
        });
        elements.addUrl.focus();
      } catch (error) {
        elements.addError.textContent = error instanceof Error ? error.message : t("error.urlSave");
        elements.addError.hidden = false;
      } finally {
        submitButton.disabled = false;
      }
    }

    async function applyBatch() {
      if (state.batchBusy) return;
      const entryIds = Array.from(state.selectedIds);
      const selectedCount = state.selectedQuery ? state.selectedQuery.expectedCount : entryIds.length;
      if (!selectedCount) return;
      const selectedOperation = elements.batchOperation.value;
      const operation = selectedOperation === "set_visibility"
        ? "set_policy"
        : selectedOperation;
      if (operation === "delete" && state.serviceCapabilities.permanent_delete !== true) {
        setBatchStatus(t("error.restartForDelete"), "error");
        return;
      }
      let value = {};
      if (operation === "set_folder") value = { folder_id: elements.batchFolder.value ? Number(elements.batchFolder.value) : null };
      if (operation === "add_tags" || operation === "remove_tags") {
        value = { tags: elements.batchTags.value.split(",").map((tag) => tag.trim()).filter(Boolean) };
        if (!value.tags.length) {
          setBatchStatus(t("validation.tagsRequired"), "error");
          elements.batchTags.focus();
          return;
        }
      }
      if (operation === "set_kind") value = { kind: elements.batchKind.value };
      if (selectedOperation === "set_visibility") value = { visibility: elements.batchVisibility.value };
      if (operation === "delete" && !global.confirm(t("confirm.deleteSelection", { count: selectedCount }))) return;
      state.batchBusy = true;
      elements.batchApply.disabled = true;
      elements.batchStatus.textContent = "";
      document.getElementById("batch-editor-feedback").textContent = "";
      try {
        const scope = state.selectedQuery
          ? {
              query: state.selectedQuery.query,
              expected_count: state.selectedQuery.expectedCount,
              expected_digest: state.selectedQuery.expectedDigest
            }
          : { entry_ids: entryIds };
        const result = await source.batchEntries({ ...scope, operation, value, reason: "Changed from Web UI selection." });
        if (operation === "delete") clearSelection();
        await refresh();
        if (operation !== "delete" && state.total === 0) {
          clearSelection();
        } else if (operation !== "delete" && state.selectedQuery) {
          const snapshot = await source.selectionSnapshot(state.selectedQuery.query);
          if (snapshot.expected_count === 0) {
            clearSelection();
          } else {
            state.selectedQuery = {
              ...state.selectedQuery,
              expectedCount: snapshot.expected_count,
              expectedDigest: snapshot.expected_digest
            };
            syncManagementState();
          }
        }
        setBatchStatus(operation === "delete"
          ? t("selection.deleted", { count: result.deleted || result.changed })
          : t("selection.updated", { count: result.changed }), "success");
      } catch (error) {
        if (error?.code === "BATCH_QUERY_CHANGED") {
          clearSelection();
          await refresh();
          setBatchStatus(t("selection.changed"), "error");
          return;
        }
        setBatchStatus(error instanceof Error ? error.message : t("error.batchUpdate"), "error");
      } finally {
        state.batchBusy = false;
        updateBatchControls();
      }
    }

    async function summarizeSelected() {
      if (state.batchBusy) return;
      const scope = state.selectedQuery
        ? {
            query: state.selectedQuery.query,
            expected_count: state.selectedQuery.expectedCount,
            expected_digest: state.selectedQuery.expectedDigest
          }
        : { entry_ids: Array.from(state.selectedIds) };
      state.batchBusy = true;
      updateBatchControls();
      try {
        const result = await source.startAiUrlSummary({ mode: 'selected', ...scope });
        setBatchStatus(result.newly_queued
          ? t('selection.aiStarted', { count: result.newly_queued })
          : t('selection.aiAlreadyRunning'), result.newly_queued ? 'success' : 'warning');
        await openSettingsDialog('ai');
      } catch (error) {
        if (error?.code === 'AI_SUMMARY_BUSY') {
          setBatchStatus(t('selection.aiAlreadyRunning'), 'warning');
          await openSettingsDialog('ai');
        } else if (error?.code === 'BATCH_QUERY_CHANGED') {
          clearSelection();
          await refresh();
          setBatchStatus(t('selection.changed'), 'error');
        } else {
          setBatchStatus(error?.code === 'ROUTE_NOT_FOUND'
            ? t('error.aiServerRestart')
            : error instanceof Error ? error.message : t('error.aiSummaryStart'), 'error');
        }
      } finally {
        state.batchBusy = false;
        updateBatchControls();
      }
    }

    function setBatchStatus(message, tone) {
      elements.batchStatus.textContent = message;
      document.getElementById("batch-editor-feedback").textContent = message;
      document.getElementById("batch-editor-feedback").dataset.tone = tone;
      elements.batchStatus.dataset.tone = tone;
      View.setStatus(message, tone);
    }

    async function openSettingsDialog(panel) {
      dialogReturnTarget = document.activeElement;
      showDialog(elements.settingsDialog);
      await settingsController.activate(panel, { focusContent: true });
    }

    function showDialog(dialog) {
      responsive?.revealHeader();
      document.documentElement.classList.add("has-open-dialog");
      try {
        dialog.showModal();
      } catch (error) {
        if (!document.querySelector("dialog[open]")) document.documentElement.classList.remove("has-open-dialog");
        throw error;
      }
    }

    elements.search.addEventListener("input", () => {
      global.clearTimeout(searchTimer);
      searchTimer = global.setTimeout(() => {
        state.search = elements.search.value.trim();
        state.page = 1;
        clearSelection();
        void refresh();
      }, 160);
    });

    elements.sortTrigger.addEventListener("click", () => {
      if (elements.sortPopover.hidden) openSortPopover();
      else closeSortPopover();
    });
    elements.addUrl.addEventListener("input", () => {
      elements.addError.hidden = true;
      elements.addUrl.removeAttribute("aria-invalid");
      elements.addResult.hidden = true;
    });
    function updateAddOptionsState() {
      elements.addOptionsState.hidden = !(
        elements.addComment.value.trim() || elements.addTags.value.trim() || elements.addFolder.value
        || elements.addKind.value || elements.addVisibility.value !== "default"
      );
    }
    elements.addOptions.addEventListener("input", updateAddOptionsState);
    elements.addOptions.addEventListener("change", updateAddOptionsState);
    elements.sortTrigger.addEventListener("keydown", (event) => {
      if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
      event.preventDefault();
      openSortPopover({ focusOption: true });
    });
    elements.sortOptions.forEach((button, index) => {
      button.addEventListener("click", () => commitSort(button.dataset.sortValue));
      button.addEventListener("keydown", (event) => {
        if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        let nextIndex = index;
        if (event.key === 'ArrowUp') nextIndex = (index - 1 + elements.sortOptions.length) % elements.sortOptions.length;
        if (event.key === 'ArrowDown') nextIndex = (index + 1) % elements.sortOptions.length;
        if (event.key === 'Home') nextIndex = 0;
        if (event.key === 'End') nextIndex = elements.sortOptions.length - 1;
        elements.sortOptions[nextIndex].focus();
      });
    });
    elements.sortPopover.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closeSortPopover({ returnFocus: true });
    });
    document.addEventListener("pointerdown", (event) => {
      if (!elements.sortPopover.hidden && !elements.sortControl.contains(event.target)) closeSortPopover();
    });

    elements.settingsView?.addEventListener("change", () => {
      setActiveView(elements.settingsView.value);
      state.page = 1;
      clearSelection();
      void refresh();
    });

    elements.feedLoadMore.addEventListener("click", () => { void loadMoreFeed(); });
    elements.detailPrevious.addEventListener("click", () => { void navigateDetail("previous"); });
    elements.detailNext.addEventListener("click", () => { void navigateDetail("next"); });
    elements.batchSelectAll.addEventListener("change", () => {
      elements.batchStatus.textContent = "";
      if (!elements.batchSelectAll.checked && state.selectedQuery) {
        clearSelection();
        return;
      }
      const visibleIds = state.currentItems.map((entry) => entry.id);
      const selectableIds = visibleIds.slice(0, MAX_SELECTION);
      state.selectedQuery = null;
      state.selectedIds = elements.batchSelectAll.checked
        ? new Set(selectableIds)
        : new Set();
      state.selectionAnchorId = elements.batchSelectAll.checked ? selectableIds.at(-1) || null : null;
      syncManagementState({ focusEntryId: selectableIds[0] || null });
      if (elements.batchSelectAll.checked && visibleIds.length > MAX_SELECTION) {
        View.setStatus(t("selection.max", { count: MAX_SELECTION }), "error");
      }
    });
    elements.batchSelectResults.addEventListener("click", async () => {
      elements.batchStatus.textContent = "";
      if (state.selectedQuery) {
        state.selectedQuery = null;
      } else if (state.total > 0) {
        elements.batchSelectResults.disabled = true;
        try {
          const query = QueryState.entryScopeQuery({ filters: state.filters, search: state.search, view: state.view });
          const snapshot = await source.selectionSnapshot(query);
          state.selectedQuery = {
            query,
            expectedCount: snapshot.expected_count,
            expectedDigest: snapshot.expected_digest
          };
        } catch (error) {
          setBatchStatus(error instanceof Error ? error.message : t("error.selectAll"), "error");
        } finally {
          elements.batchSelectResults.disabled = false;
        }
      }
      syncManagementState();
    });
    elements.batchOperation.addEventListener("change", updateBatchValueControl);
    elements.batchApply.addEventListener("click", () => { void applyBatch(); });
    elements.batchAiSummary.addEventListener("click", () => { void summarizeSelected(); });
    elements.batchDone.addEventListener("click", () => clearSelection({ focusEntryId: state.currentItems[0]?.id }));
    elements.settingsButton.addEventListener("click", () => { void openSettingsDialog(); });
    elements.settingsTabs.forEach((tab, index) => {
      tab.addEventListener("click", () => { void settingsController.activate(tab.dataset.settingsPanel, { focusContent: tab.dataset.settingsPanel === "add" }); });
      tab.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        let nextIndex = index;
        if (event.key === "ArrowLeft") nextIndex = (index - 1 + elements.settingsTabs.length) % elements.settingsTabs.length;
        if (event.key === "ArrowRight") nextIndex = (index + 1) % elements.settingsTabs.length;
        if (event.key === "Home") nextIndex = 0;
        if (event.key === "End") nextIndex = elements.settingsTabs.length - 1;
        void settingsController.activate(elements.settingsTabs[nextIndex].dataset.settingsPanel, { focusTab: true });
      });
    });
    elements.chromeApproveButton.addEventListener("click", () => { void settingsController.approveChromeConnection(); });
    elements.defaultViewButton.addEventListener("click", returnToDefaultView);
    elements.filterButton.addEventListener("click", openFilterDialog);
    elements.filterForm.addEventListener("submit", applyFilters);
    elements.filterReset.addEventListener("click", clearAllFilters);
    elements.filterRecentPreset.addEventListener("click", () => {
      state.filters = QueryState.applyRecentPreset(state.filters, () => new Date());
      syncFilterForm();
    });
    elements.filterSavedFrom.addEventListener("input", () => {
      elements.filterRecentPreset.setAttribute("aria-pressed", "false");
      elements.filterRecentPreset.classList.remove("is-active");
    });
    elements.filterSavedTo.addEventListener("input", () => {
      elements.filterRecentPreset.setAttribute("aria-pressed", "false");
      elements.filterRecentPreset.classList.remove("is-active");
    });
    elements.clearFiltersButton.addEventListener("click", clearAllFilters);
    elements.sidebarToggle.addEventListener("click", () => setSidebarCollapsed(!state.sidebarCollapsed));
    elements.addForm.addEventListener("submit", submitAdd);
    elements.folderCreateForm?.addEventListener("submit", settingsController.submitFolder);
    elements.policyDefaultForm.addEventListener("submit", settingsController.submitDefault);
    elements.policyRuleForm.addEventListener("submit", settingsController.submitRule);
    elements.policyRuleToggle.addEventListener("click", settingsController.toggleRuleEditor);
    elements.chromeClientsShowAll.addEventListener("click", settingsController.showAllChromeClients);
    elements.aiUrlSummaryStart.addEventListener("click", settingsController.startAiUrlSummary);

    async function closeDialog(dialog) {
      if (!dialog?.open) {
        return;
      }
      if (dialog === elements.detailDialog && typeof elements.detailContent.wbhFlushPendingEdits === "function") {
        const saved = await elements.detailContent.wbhFlushPendingEdits();
        if (!saved) {
          return;
        }
      }
      dialog.close();
    }

    document.addEventListener("click", (event) => {
      const closeButton = event.target.closest("[data-dialog-close]");
      if (!closeButton) {
        return;
      }
      const dialog = closeButton.closest("dialog");
      void closeDialog(dialog);
    });

    elements.detailDialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      void closeDialog(elements.detailDialog);
    });

    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !state.management || document.querySelector("dialog[open], :popover-open")) return;
      event.preventDefault();
      const focusedEntryId = document.activeElement?.closest?.("[data-entry-id]")?.dataset.entryId;
      clearSelection({ focusEntryId: focusedEntryId });
    });

    document.addEventListener("keydown", (event) => {
      if (!elements.detailDialog.open || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (elements.detailContent.dataset.mode === "edit") return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      event.preventDefault();
      void navigateDetail(event.key === "ArrowLeft" ? "previous" : "next");
    });

    [elements.settingsDialog, elements.detailDialog, elements.filterDialog, elements.batchDialog].forEach((dialog) => {
      dialog.addEventListener("close", () => {
        if (dialog === elements.detailDialog) {
          if (detailController) detailController.abort();
          detailLoadVersion += 1;
          state.detailEntryId = null;
          state.detailBusy = false;
          if (locationEntryId()) syncEntryLocation(null, "replaceState");
        }
        if (dialogReturnTarget instanceof HTMLElement && dialogReturnTarget.isConnected && dialogReturnTarget.getClientRects().length) {
          dialogReturnTarget.focus();
        } else if (dialog === elements.batchDialog) {
          elements.results.querySelector('[data-entry-id]')?.focus({ preventScroll: true });
        }
        dialogReturnTarget = null;
        if (!document.querySelector("dialog[open]")) document.documentElement.classList.remove("has-open-dialog");
      });
    });

    if (typeof global.IntersectionObserver === "function") {
      feedObserver = new global.IntersectionObserver((records) => {
        if (records.some((record) => record.isIntersecting)) void loadMoreFeed();
      }, { rootMargin: "240px 0px" });
    }

    installTooltipBehavior(document);
    responsive = ResponsiveWorkflows.install({
      window: global, document, elements, t,
      openDialog(dialog, trigger) {
        dialogReturnTarget = trigger;
        showDialog(dialog);
      },
      clearSelection() { clearSelection({ focusEntryId: state.currentItems[0]?.id }); }
    });
    setActiveView(state.view);
    setSidebarCollapsed(state.sidebarCollapsed);
    updateFilterControl();
    elements.search.value = state.search;
    syncSortControl();
    renderContentTypeOptions(elements.policyRuleKind, { includeAny: true, anyLabel: "Detect from URL" });
    resetAddForm();
    attachTagSuggestions(elements.addTags);
    attachTagSuggestions(elements.batchTags);
    attachTagSuggestions(elements.policyRuleTags);
    updateBatchValueControl();
    updateBatchControls();
    global.addEventListener("popstate", () => {
      const entryId = locationEntryId();
      if (entryId) void openDetail(entryId, null, { skipHistory: true });
      else if (elements.detailDialog.open) elements.detailDialog.close();
    });
    global.addEventListener("focus", refreshAfterExternalChange);
    document.addEventListener("visibilitychange", refreshAfterExternalChange);
    document.addEventListener("wbh-languagechange", () => {
      rerenderOptions(elements.filterKind, () => renderContentTypeOptions(elements.filterKind, { includeAny: true }));
      rerenderOptions(elements.addKind, () => renderContentTypeOptions(elements.addKind, { includeAutomatic: true }));
      rerenderOptions(elements.batchKind, () => renderContentTypeOptions(elements.batchKind));
      rerenderOptions(elements.policyRuleKind, () => renderContentTypeOptions(elements.policyRuleKind, { includeAny: true, anyLabel: t("form.autoFromUrl") }));
      setActiveView(state.view);
      setSidebarCollapsed(state.sidebarCollapsed);
      updateFilterControl();
      updateBatchControls();
      if (!activationRefreshReady) return;
      void (async function refreshLocalizedSurface() {
        await settingsController.activate(settingsController.activePanel());
        await refresh();
      }());
    });
    void (async function bootstrap() {
      const extensionId = connectionRequestId();
      try {
        const initialized = typeof source.initialize === "function" ? await source.initialize() : null;
        state.serviceCapabilities = initialized?.service?.capabilities || {};
        updateBatchControls();
        await refresh();
        activationRefreshReady = true;
        const entryId = locationEntryId();
        if (entryId) void openDetail(entryId, null, { skipHistory: true });
      } catch (error) {
        View.setStatus(error instanceof Error ? error.message : t("error.registryInitialize"), "error");
      }
      if (extensionId) {
        try {
          await openSettingsDialog("chrome");
        } catch (error) {
          View.setStatus(error instanceof Error ? error.message : t("error.registryInitialize"), "error");
        }
        settingsController.requestChromeApproval(extensionId);
      }
    }());
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})(window);
