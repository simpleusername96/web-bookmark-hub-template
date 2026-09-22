(function exposeResultsView(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WBHResultsView = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function resultsViewFactory() {
  'use strict';

  function resultsRenderKey(items, view) {
    const renderedView = ['grid', 'feed', 'list'].includes(view) ? view : 'grid';
    return renderedView + '\n' + JSON.stringify(Array.isArray(items) ? items : []);
  }

  function entryRenderKey(entry, view) { return view + '\n' + JSON.stringify(entry || null); }

  function reconcileChildren(container, desiredNodes) {
    let cursor = container.firstChild;
    desiredNodes.forEach(function placeNode(node) {
      if (node === cursor) { cursor = cursor.nextSibling; return; }
      container.insertBefore(node, cursor);
    });
    while (cursor) { const next = cursor.nextSibling; cursor.remove(); cursor = next; }
  }

  function nextSelection(items, selectedIds, anchorId, targetId, options) {
    const ids = (Array.isArray(items) ? items : []).map(function itemId(item) { return item && item.id; });
    const selected = new Set(selectedIds instanceof Set ? selectedIds : selectedIds || []);
    const targetIndex = ids.indexOf(targetId);
    const anchorIndex = ids.indexOf(anchorId);
    if (options && options.shiftKey && anchorIndex >= 0 && targetIndex >= 0) {
      ids.slice(Math.min(anchorIndex, targetIndex), Math.max(anchorIndex, targetIndex) + 1)
        .forEach(function selectRange(id) { selected.add(id); });
      return limitedSelection(selected, anchorId, options && options.maxSelected);
    }
    if (options && options.selected === false) selected.delete(targetId);
    else {
      const limit = selectionLimit(options && options.maxSelected);
      if (!selected.has(targetId) && selected.size >= limit) return { selectedIds: selected, anchorId: anchorId, limitReached: true };
      selected.add(targetId);
    }
    return limitedSelection(selected, targetId, options && options.maxSelected);
  }

  function selectionLimit(value) { return Number.isSafeInteger(Number(value)) ? Math.max(1, Number(value)) : Infinity; }
  function limitedSelection(selectedIds, anchorId, maxSelected) {
    const limit = selectionLimit(maxSelected);
    const selected = new Set();
    for (const id of selectedIds) { if (selected.size >= limit) break; selected.add(id); }
    return { selectedIds: selected, anchorId: anchorId, limitReached: selectedIds.size > selected.size };
  }

  function renderResults(options, deps) {
    const settings = options || {};
    const container = settings.container;
    if (!container) return;
    const view = ['grid', 'feed', 'list'].includes(settings.view) ? settings.view : 'grid';
    const management = settings.management === true;
    const append = settings.append === true && view === 'feed' && container.classList.contains('results-feed');
    const reusableNodes = new Map();
    if (!append && view !== 'list' && container.classList.contains('results-' + view)) {
      Array.from(container.children).forEach(function rememberNode(node) { if (node.dataset.entryId) reusableNodes.set(node.dataset.entryId, node); });
    }
    if (!append) { container.removeAttribute('role'); container.removeAttribute('aria-multiselectable'); }
    const items = Array.isArray(settings.items) ? settings.items : [];
    const t = typeof deps.t === 'function' ? deps.t : function untranslated(key) { return key; };
    if (!items.length) {
      if (!append) deps.renderEmpty(container, settings.emptyState?.message || t('app.emptyWithAction'), settings.emptyState?.actions);
      return;
    }
    const onOpen = typeof settings.onOpen === 'function' ? settings.onOpen : function noop() {};
    const onSelect = typeof settings.onSelect === 'function' ? settings.onSelect : function noop() {};
    const selectedIds = settings.selectedIds instanceof Set ? settings.selectedIds : new Set(settings.selectedIds || []);
    if (!append) { container.className = 'results results-' + view; container.classList.toggle('is-managing', management); }
    if (view === 'list') {
      deps.clear(container);
      const table = deps.element('table', 'bbs-table');
      table.append(deps.element('caption', 'visually-hidden', t('results.listCaption')));
      const head = deps.element('thead');
      const header = deps.element('tr', 'bbs-row bbs-head');
      ['select', 'title', 'source', 'tags', 'saved'].forEach(function appendHeader(name) {
        const label = t('results.column.' + name);
        const cell = deps.element('th', name === 'select' ? 'bbs-select-head' : name === 'saved' ? 'bbs-saved-head' : '');
        if (name === 'select') cell.append(deps.element('span', 'visually-hidden', label)); else cell.textContent = label;
        cell.scope = 'col'; header.append(cell);
      });
      head.append(header); table.append(head);
      const list = deps.element('tbody', 'bbs-list');
      items.forEach(function appendListItem(entry) { list.append(deps.listItem(entry, onOpen, selectedIds, onSelect, management)); });
      table.append(list); container.append(table); deps.syncRenderedManagement(container, management, selectedIds); return;
    }
    const desiredNodes = [];
    items.forEach(function prepareItem(entry) {
      const key = entryRenderKey(entry, view);
      const existing = reusableNodes.get(String(entry.id));
      const node = existing && existing.dataset.renderStale !== 'true' && deps.renderedEntryKeys.get(existing) === key
        ? existing : (view === 'feed' ? deps.feedItem(entry, onOpen, selectedIds, onSelect, management) : deps.gridItem(entry, onOpen, selectedIds, onSelect, management));
      if (!node) return;
      deps.renderedEntryKeys.set(node, key); desiredNodes.push(node);
    });
    container.className = 'results results-' + view;
    container.classList.toggle('is-managing', management);
    if (append) desiredNodes.forEach(function appendItem(node) { container.append(node); }); else reconcileChildren(container, desiredNodes);
    deps.syncRenderedManagement(container, management, selectedIds);
  }

  function renderPagination(options, deps) {
    const settings = options || {};
    const container = settings.container;
    if (!container) return;
    deps.clear(container);
    const totalPages = Math.max(0, Number(settings.totalPages) || 0);
    const page = Math.min(Math.max(1, Number(settings.page) || 1), Math.max(1, totalPages));
    if (totalPages <= 1) return;
    const onPage = typeof settings.onPage === 'function' ? settings.onPage : function noop() {};
    const t = typeof deps.t === 'function' ? deps.t : function untranslated(key) { return key; };
    const previous = deps.iconButton('previous', t('action.previousPage'), 'pagination-button icon-button', function previousPage() { onPage(page - 1); });
    previous.disabled = page <= 1; container.append(previous);
    paginationItems(page, totalPages).forEach(function appendPaginationItem(current) {
      if (current === 'ellipsis') { const ellipsis = deps.element('span', 'pagination-ellipsis', '…'); ellipsis.setAttribute('aria-hidden', 'true'); container.append(ellipsis); return; }
      const pageButton = deps.button(String(current), 'pagination-button', function selectPage() { onPage(current); });
      pageButton.setAttribute('aria-label', t('results.page', { page: current }));
      if (current === page) { pageButton.setAttribute('aria-current', 'page'); pageButton.classList.add('is-active'); }
      container.append(pageButton);
    });
    const next = deps.iconButton('next', t('action.nextPage'), 'pagination-button icon-button', function nextPage() { onPage(page + 1); });
    next.disabled = page >= totalPages; container.append(next);
  }

  function paginationItems(page, totalPages) {
    const normalizedTotal = Math.max(0, Number(totalPages) || 0);
    if (!normalizedTotal) return [];
    const normalizedPage = Math.min(Math.max(1, Number(page) || 1), normalizedTotal);
    const visiblePages = new Set([1, normalizedTotal]);
    for (let current = normalizedPage - 1; current <= normalizedPage + 1; current += 1) if (current >= 1 && current <= normalizedTotal) visiblePages.add(current);
    const sortedPages = Array.from(visiblePages).sort(function ascending(left, right) { return left - right; });
    const items = [];
    sortedPages.forEach(function appendPage(current, index) { if (index > 0 && current > sortedPages[index - 1] + 1) items.push('ellipsis'); items.push(current); });
    return items;
  }

  return { nextSelection, paginationItems, renderPagination, renderResults, resultsRenderKey };
}));
