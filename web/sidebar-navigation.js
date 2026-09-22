(function exposeSidebarNavigation(root, factory) {
  const uiLanguage = typeof module === 'object' && module.exports ? require('./ui-language.js') : root?.WBHUiLanguage;
  const api = factory(root, uiLanguage);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && root.WBHView) api.install(root.WBHView);
}(typeof globalThis !== 'undefined' ? globalThis : this, function sidebarNavigationFactory(root, uiLanguage) {
  'use strict';
  const EXPANSION_STORAGE_KEY = 'web-bookmark-hub:tree-expansion:v1';
  const MOBILE_QUERY = '(max-width: 900px)';
  const t = function translate(key, values) { return uiLanguage?.text ? uiLanguage.text(key, values) : key; };
  function install(view, options) {
    if (!view || typeof view.renderSidebar !== 'function' || view.__sidebarNavigationInstalled) return view;
    const documentRef = options?.document || root?.document;
    const windowRef = options?.window || documentRef?.defaultView || root;
    if (!documentRef) return view;
    const expansion = readExpansion(windowRef);
    bindMobileDrawer(documentRef, windowRef);
    view.renderSidebar = function renderImprovedSidebar(settings) {
      return renderSidebar(documentRef, windowRef, expansion, settings || {});
    };
    view.__sidebarNavigationInstalled = true;
    return view;
  }
  function renderSidebar(documentRef, windowRef, expansion, settings) {
    const onScope = typeof settings.onStructure === 'function' ? settings.onStructure : function noop() {};
    const folders = Array.isArray(settings.folders) ? settings.folders : [];
    const urlGroups = Array.isArray(settings.urlGroups) ? settings.urlGroups : [];
    const active = settings.activeStructure || {};
    const folderTarget = documentRef.getElementById('folders');
    const urlTarget = documentRef.getElementById('url-groups');
    if (!folderTarget || !urlTarget) return;
    folderTarget.replaceChildren();
    urlTarget.replaceChildren();
    if (settings.error) {
      folderTarget.append(emptyState(documentRef, settings.error));
      urlTarget.append(emptyState(documentRef, settings.error));
    } else {
      renderTree(documentRef, windowRef, expansion, folderTarget, folders, {
        scopeType: 'folder', activeId: String(active.folderId || ''), onScope,
        emptyMessage: t('sidebar.noFolders'),
        describe(item) {
          const label = String(item.name || 'Untitled Folder');
          return { label, count: numericCount(item.entry_count_total ?? item.entry_count), fullLabel: label };
        }
      });
      renderTree(documentRef, windowRef, expansion, urlTarget, urlGroups, {
        scopeType: 'url_group', activeId: String(active.urlGroupId || ''), onScope,
        emptyMessage: t('sidebar.noUrls'),
        describe(item) {
          const fullLabel = String(item.label || 'Unknown URL group');
          return { label: item.kind === 'domain' ? fullLabel : compactUrlLabel(fullLabel), count: numericCount(item.entry_count), fullLabel };
        }
      });
    }
    syncSectionDefault(folderTarget, settings.error || folders.length > 0);
    syncSectionDefault(urlTarget, settings.error || urlGroups.length > 0);
    bindTreeTools(documentRef, windowRef, expansion);
  }
  function syncSectionDefault(target, hasContent) {
    const section = target.closest?.('details.nav-group');
    if (!section || section.dataset.defaultDisclosureApplied === 'true') return;
    section.open = Boolean(hasContent);
    section.dataset.defaultDisclosureApplied = 'true';
  }
  function renderTree(documentRef, windowRef, expansion, target, roots, config) {
    if (!roots.length) { target.append(emptyState(documentRef, config.emptyMessage)); return; }
    roots.forEach((item) => target.append(createBranch(documentRef, windowRef, expansion, item, 0, config)));
  }
  function createBranch(documentRef, windowRef, expansion, item, depth, config) {
    const children = Array.isArray(item.children) ? item.children : [];
    const hasChildren = children.length > 0;
    const description = config.describe(item);
    const wrapper = documentRef.createElement('div');
    wrapper.className = 'tree-branch-improved';
    wrapper.dataset.treeScope = config.scopeType;
    wrapper.dataset.treeId = String(item.id);
    const row = documentRef.createElement('div');
    row.className = 'tree-node-improved';
    row.style.setProperty('--tree-depth', String(depth));
    const toggle = documentRef.createElement('button');
    toggle.type = 'button';
    toggle.className = 'tree-toggle-improved';
    toggle.dataset.treeToggle = 'true';
    toggle.dataset.leaf = String(!hasChildren);
    const select = documentRef.createElement('button');
    select.type = 'button';
    select.className = 'tree-select-improved';
    select.textContent = description.label;
    select.dataset.tooltip = description.fullLabel;
    select.dataset.treeSelect = 'true';
    const count = documentRef.createElement('span');
    count.className = 'tree-count-improved';
    count.textContent = String(description.count);
    count.setAttribute('aria-hidden', 'true');
    const selected = String(item.id) === config.activeId;
    select.setAttribute('aria-pressed', String(selected));
    row.classList.toggle('is-active', selected);
    const includesDescendants = config.scopeType === 'folder' && hasChildren;
    select.setAttribute('aria-label', `${description.fullLabel}${includesDescendants ? ', including subfolders' : ''}, ${description.count} entries`);
    select.addEventListener('click', function chooseScope() {
      config.onScope(includesDescendants ? 'folder_descendants' : config.scopeType, item.id, description.fullLabel);
      closeMobileDrawer(documentRef, windowRef, { returnFocus: false });
    });
    row.append(toggle, select, count);
    wrapper.append(row);
    if (!hasChildren) {
      toggle.textContent = ''; toggle.disabled = true; toggle.tabIndex = -1; toggle.setAttribute('aria-hidden', 'true');
      return wrapper;
    }
    const childrenBox = documentRef.createElement('div');
    childrenBox.className = 'tree-children-improved';
    children.forEach((child) => childrenBox.append(createBranch(documentRef, windowRef, expansion, child, depth + 1, config)));
    wrapper.append(childrenBox);
    const key = `${config.scopeType}:${String(item.id)}`;
    const forcedOpen = containsActiveDescendant(item, config.activeId);
    wrapper.dataset.activePath = String(forcedOpen);
    const expanded = forcedOpen || expansion.has(key) ? (forcedOpen || expansion.get(key) === true) : defaultExpanded(config.scopeType, depth);
    syncExpansion(toggle, childrenBox, expanded, description.fullLabel);
    toggle.addEventListener('click', function toggleBranch() {
      const next = toggle.getAttribute('aria-expanded') !== 'true';
      expansion.set(key, next); persistExpansion(windowRef, expansion); syncExpansion(toggle, childrenBox, next, description.fullLabel);
    });
    return wrapper;
  }
  function bindTreeTools(documentRef, windowRef, expansion) {
    documentRef.querySelectorAll('[data-collapse-tree]').forEach(function bindCollapse(control) {
      if (control.dataset.bound === 'true') return;
      control.dataset.bound = 'true';
      control.addEventListener('click', function collapseSection(event) {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        const target = documentRef.getElementById(control.dataset.collapseTree);
        if (!target) return;
        target.querySelectorAll('.tree-branch-improved').forEach(function collapseBranch(branch) {
          const toggle = branchToggle(branch); const children = branchChildren(branch);
          if (!toggle || !children) return;
          const forceOpen = branch.dataset.activePath === 'true';
          const key = `${branch.dataset.treeScope}:${branch.dataset.treeId}`;
          if (!forceOpen) expansion.set(key, false);
          syncExpansion(toggle, children, forceOpen, branchSelect(branch)?.dataset.tooltip || 'Group');
        });
        persistExpansion(windowRef, expansion);
      });
    });
  }
  function bindMobileDrawer(documentRef, windowRef) {
    if (!windowRef || documentRef.documentElement.dataset.sidebarDrawerBound === 'true') return;
    documentRef.documentElement.dataset.sidebarDrawerBound = 'true';
    const shell = documentRef.getElementById('app-shell');
    const toggle = documentRef.getElementById('sidebar-toggle');
    const close = documentRef.getElementById('sidebar-mobile-close');
    const backdrop = documentRef.getElementById('sidebar-backdrop');
    if (!shell || !toggle || !backdrop) return;
    toggle.addEventListener('click', function toggleMobileDrawer(event) {
      if (!isNarrow(windowRef)) return;
      event.preventDefault(); event.stopImmediatePropagation();
      syncMobileDrawer(documentRef, !shell.classList.contains('is-mobile-sidebar-open'));
    }, { capture: true });
    close?.addEventListener('click', () => closeMobileDrawer(documentRef, windowRef, { returnFocus: true }));
    backdrop.addEventListener('click', () => closeMobileDrawer(documentRef, windowRef, { returnFocus: true }));
    documentRef.addEventListener('keydown', function manageDrawerKeyboard(event) {
      if (!shell.classList.contains('is-mobile-sidebar-open')) return;
      if (event.key === 'Escape') {
        event.preventDefault(); closeMobileDrawer(documentRef, windowRef, { returnFocus: true });
        return;
      }
      if (event.key !== 'Tab') return;
      const sidebar = documentRef.getElementById('sidebar');
      const focusable = Array.from(sidebar?.querySelectorAll('button:not([disabled]), input:not([disabled])') || [])
        .filter((control) => control.getClientRects().length > 0);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && documentRef.activeElement === first) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && documentRef.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    });
    windowRef.addEventListener?.('resize', () => syncMobileDrawer(documentRef, false));
    const initializeNarrowDrawer = () => windowRef.setTimeout?.(() => {
      if (isNarrow(windowRef)) syncMobileDrawer(documentRef, false);
    }, 0);
    if (documentRef.readyState === 'loading') {
      documentRef.addEventListener('DOMContentLoaded', initializeNarrowDrawer, { once: true });
    } else initializeNarrowDrawer();
  }
  function closeMobileDrawer(documentRef, windowRef, options) {
    if (!isNarrow(windowRef)) return;
    syncMobileDrawer(documentRef, false);
    if (options?.returnFocus) documentRef.getElementById('sidebar-toggle')?.focus();
    else documentRef.getElementById('search-input')?.focus();
  }
  function syncMobileDrawer(documentRef, open) {
    const shell = documentRef.getElementById('app-shell');
    const sidebar = documentRef.getElementById('sidebar');
    const mainContent = documentRef.getElementById('main-content');
    const toggle = documentRef.getElementById('sidebar-toggle');
    const backdrop = documentRef.getElementById('sidebar-backdrop');
    if (!shell || !sidebar || !toggle || !backdrop) return;
    const narrow = isNarrow(documentRef.defaultView || root);
    const concealed = narrow && !open;
    shell.classList.toggle('is-mobile-sidebar-open', open);
    documentRef.documentElement.classList.toggle('has-mobile-sidebar', open);
    sidebar.toggleAttribute('inert', concealed);
    if (concealed) sidebar.setAttribute('aria-hidden', 'true');
    else sidebar.removeAttribute('aria-hidden');
    if (mainContent) mainContent.toggleAttribute('inert', narrow && open);
    backdrop.hidden = !open;
    backdrop.tabIndex = -1;
    backdrop.setAttribute('aria-hidden', 'true');
    const expanded = narrow ? open : !shell.classList.contains('is-sidebar-collapsed');
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.setAttribute('aria-label', t(expanded ? 'sidebar.hide' : 'sidebar.show'));
    toggle.dataset.tooltip = t(expanded ? 'sidebar.hide' : 'sidebar.show');
    if (open) documentRef.getElementById('sidebar-mobile-close')?.focus();
  }
  function readExpansion(windowRef) {
    try {
      const parsed = JSON.parse(windowRef?.localStorage?.getItem(EXPANSION_STORAGE_KEY) || '{}');
      return new Map(Object.entries(parsed).map((entry) => [entry[0], entry[1] === true]));
    } catch (_error) { return new Map(); }
  }
  function persistExpansion(windowRef, expansion) {
    try { windowRef?.localStorage?.setItem(EXPANSION_STORAGE_KEY, JSON.stringify(Object.fromEntries(expansion))); }
    catch (_error) { /* Page-lifetime state remains usable. */ }
  }
  function syncExpansion(toggle, children, expanded, label) {
    toggle.replaceChildren(root.WBHIcons.create(expanded ? 'down' : 'chevron'));
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.setAttribute('aria-label', t(expanded ? 'sidebar.collapse' : 'sidebar.expand', { label }));
    children.hidden = !expanded;
  }
  function containsActiveDescendant(item, activeId) {
    if (!activeId) return false;
    return (Array.isArray(item.children) ? item.children : []).some((child) => String(child.id) === activeId || containsActiveDescendant(child, activeId));
  }
  function defaultExpanded(scopeType, depth) { return scopeType === 'folder' && depth === 0; }
  function compactUrlLabel(value) {
    const label = String(value || ''); const pathIndex = label.search(/[/?]/u);
    if (pathIndex < 0) return label;
    const suffix = label.slice(pathIndex); const queryIndex = suffix.indexOf('?');
    const pathname = queryIndex < 0 ? suffix : suffix.slice(0, queryIndex);
    const query = queryIndex < 0 ? '' : suffix.slice(queryIndex);
    const parts = pathname.split('/').filter(Boolean);
    return `${parts.length ? `/${parts.slice(-2).join('/')}` : '/'}${query}`;
  }
  function emptyState(documentRef, message) { const node = documentRef.createElement('p'); node.className = 'sidebar-empty'; node.textContent = message; return node; }
  function directChild(node, selector) { return Array.from(node.children || []).find((child) => child.matches(selector)) || null; }
  function branchToggle(branch) { return directChild(branch, '.tree-node-improved')?.querySelector('[data-tree-toggle]') || null; }
  function branchSelect(branch) { return directChild(branch, '.tree-node-improved')?.querySelector('[data-tree-select]') || null; }
  function branchChildren(branch) { return directChild(branch, '.tree-children-improved'); }
  function numericCount(value) { const count = Number(value); return Number.isFinite(count) && count >= 0 ? Math.trunc(count) : 0; }
  function isNarrow(windowRef) { return windowRef?.matchMedia?.(MOBILE_QUERY).matches === true; }
  return { EXPANSION_STORAGE_KEY, compactUrlLabel, defaultExpanded, install, numericCount, renderSidebar, syncSectionDefault };
}));
