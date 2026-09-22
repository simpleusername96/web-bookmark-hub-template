(function viewModule(root, factory) {
  const resultsView = typeof module === 'object' && module.exports ? require('./results-view.js') : root.WBHResultsView;
  const detailView = typeof module === 'object' && module.exports ? require('./detail-view.js') : root.WBHDetailView;
  const cardPresentation = typeof module === 'object' && module.exports ? require('./card-presentation.js') : root.WBHCardPresentation;
  const contentTypes = typeof module === 'object' && module.exports ? require('./content-types.js') : root.WBHContentTypes;
  const uiLanguage = typeof module === 'object' && module.exports ? require('./ui-language.js') : root.WBHUiLanguage;
  const icons = typeof module === 'object' && module.exports ? require('./ui-icons.js') : root.WBHIcons;
  const api = factory(icons, root && root.document, resultsView, detailView, cardPresentation, contentTypes, uiLanguage);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.WBHView = api;
  }
}(typeof window !== 'undefined' ? window : globalThis, function createView(Icons, documentRef, ResultsView, DetailView, CardPresentation, ContentTypes, UiLanguage) {
  'use strict';

  const PREVIEW_TONES = new Set(['amber', 'blue', 'cobalt', 'coral', 'green', 'ink', 'mint', 'ochre', 'paper', 'rose', 'slate', 'violet']);
  const HUMAN_PROVIDER_KEYS = new Set(['arxiv', 'chatgpt', 'github', 'pinterest', 'twitter', 'x', 'youtube']);
  const windowRef = documentRef && documentRef.defaultView || globalThis;
  const renderedEntryKeys = new WeakMap();
  const treeExpansion = new Map();
  const t = function translate(key, values) { return UiLanguage?.text ? UiLanguage.text(key, values) : key; };

  function clear(node) {
    if (node) node.replaceChildren();
  }

  function element(name, className, text) {
    const node = documentRef.createElement(name);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function button(text, className, onClick) {
    const node = element('button', className, text);
    node.type = 'button';
    if (onClick) node.addEventListener('click', onClick);
    return node;
  }

  function controlIcon(name) {
    return Icons.create(name, documentRef);
  }

  function iconButton(name, label, className, onClick) {
    const node = button('', className, onClick);
    node.setAttribute('aria-label', label);
    node.dataset.tooltip = label;
    node.append(controlIcon(name));
    return node;
  }

  function metadataOf(entry) {
    const metadata = entry && entry.typed_metadata;
    return metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
  }

  function entryTags(entry) {
    if (!entry || !Array.isArray(entry.tags)) return [];
    return entry.tags.map(function mapTag(tag) {
      if (typeof tag === 'string') return { name: tag, normalized_name: tag.toLowerCase() };
      return tag || {};
    }).filter(function hasName(tag) { return Boolean(tag.name || tag.normalized_name); });
  }

  function scopeMatches(activeScope, candidate) {
    if (!activeScope) return candidate.type === 'all';
    if (typeof activeScope === 'string') {
      return activeScope === candidate.type || activeScope === candidate.key;
    }
    const activeType = activeScope.scope || activeScope.type;
    return activeType === candidate.type && String(activeScope.value || '') === String(candidate.value || '');
  }

  function scopeButton(item, activeScope, onScope) {
    const node = button(item.label, 'sidebar-link', function selectScope() {
      onScope(item.scope.type, item.scope.value || null, item.label);
    });
    node.setAttribute('aria-pressed', scopeMatches(activeScope, item.scope) ? 'true' : 'false');
    if (scopeMatches(activeScope, item.scope)) node.classList.add('is-active');
    return node;
  }

  function formatDate(value) {
    if (!value) return t('status.dateUnknown');
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return t('status.dateUnknown');
    return date.toISOString().slice(0, 10);
  }

  function rawSource(entry) {
    if (!entry) return '';
    if (entry.source_domain) return String(entry.source_domain);
    if (entry.url_original || entry.url_canonical) {
      try {
        return new URL(entry.url_original || entry.url_canonical).hostname.replace(/^www\./i, '');
      } catch (_error) {
        // Fall through to the provider supplied by the adapter.
      }
    }
    return entry.provider ? String(entry.provider) : '';
  }

  function sourceDisplayName(value) {
    let source = String(value || '').trim().toLowerCase();
    if (!source) return t('app.unknownSource');
    try {
      if (source.includes('://')) source = new URL(source).hostname;
    } catch (_error) {
      // A provider key is also a valid presentation input.
    }
    source = source.replace(/^www\./, '').replace(/\.$/, '');
    const syntheticKey = source.endsWith('.example.test')
      ? source.slice(0, -'.example.test'.length).split('.').at(-1)
      : '';
    const knownSources = [
      { label: 'YouTube', values: ['youtube', 'youtube.com', 'youtu.be'] },
      { label: 'Twitter', values: ['x', 'twitter', 'twitter.com', 'x.com'] },
      { label: 'arXiv', values: ['arxiv', 'arxiv.org'] },
      { label: 'Pinterest', values: ['pinterest', 'pinterest.com'] },
      { label: 'GitHub', values: ['github', 'github.com'] },
      { label: 'ChatGPT', values: ['chatgpt', 'chatgpt.com', 'chat.openai.com'] },
    ];
    const match = knownSources.find(function findKnownSource(candidate) {
      return candidate.values.some(function matchesValue(known) {
        return source === known || source.endsWith('.' + known) || syntheticKey === known;
      });
    });
    if (match) return match.label;

    const labels = source.split('.').filter(Boolean);
    let name = syntheticKey || (labels.length > 1 ? labels[labels.length - 2] : labels[0]);
    const secondLevelSuffixes = new Set(['ac', 'co', 'com', 'gov', 'net', 'org']);
    if (labels.length > 2 && labels[labels.length - 1].length === 2 && secondLevelSuffixes.has(name)) {
      name = labels[labels.length - 3];
    }
    return String(name || source).split(/[-_]/).filter(Boolean).map(function capitalize(part) {
      return part.charAt(0).toUpperCase() + part.slice(1);
    }).join(' ');
  }

  function sourceLabel(entry) {
    const provider = String(entry && entry.provider || '').toLowerCase();
    if (HUMAN_PROVIDER_KEYS.has(provider)) return sourceDisplayName(provider);
    return sourceDisplayName(rawSource(entry));
  }

  function titleFor(entry) {
    if (CardPresentation && typeof CardPresentation.describe === 'function') {
      const presentation = CardPresentation.describe(entry);
      return presentation.title || sourceLabel(entry) + ' ' + (presentation.url || presentation.typeLabel);
    }
    return 'Untitled entry';
  }

  function preview(entry, size) {
    const metadata = metadataOf(entry);
    const requestedTone = String(metadata.preview_tone || '').toLowerCase();
    const tone = PREVIEW_TONES.has(requestedTone) ? requestedTone : 'slate';
    const node = element('div', 'preview');
    if (size) node.classList.add('preview-' + size);
    node.dataset.tone = tone;
    node.setAttribute('aria-hidden', 'true');
    const label = String(metadata.preview_label || entry.kind || sourceLabel(entry)).trim();
    const initials = label.slice(0, 2).toUpperCase() || '↗';
    node.append(element('span', 'preview-initials', initials));
    return node;
  }

  function createAutosaveCoordinator(options) { return DetailView.createAutosaveCoordinator(options); }

  function coverUrl(entry, options) {
    const settings = options || {};
    if (!entry || (!settings.ignoreContentFocus && entry.content_focus !== 'visual') || !entry.cover_image) return null;
    const cover = entry.cover_image;
    if (cover.storage_kind === 'local' && cover.status === 'ready' && Number.isSafeInteger(Number(cover.id))) {
      return '/api/v1/visual-assets/' + Number(cover.id) + '/content';
    }
    if (cover.storage_kind === 'remote' && cover.status === 'referenced') return secureImageUrl(cover.source_url);
    return null;
  }

  function resultsRenderKey(items, view) { return ResultsView.resultsRenderKey(items, view); }

  function visualPreview(entry, size, options) {
    const settings = options || {};
    if (!entry || (!settings.ignoreContentFocus && entry.content_focus !== 'visual')) return null;
    const fallback = preview(entry, size);
    const source = coverUrl(entry, settings);
    if (!source) return settings.fallbackNode || (settings.requireImage ? null : fallback);
    const frame = element('div', 'preview preview-image');
    if (size) frame.classList.add('preview-' + size);
    fallback.classList.add('preview-placeholder');
    const image = element('img', 'cover-image');
    image.alt = titleFor(entry);
    image.loading = 'lazy';
    image.referrerPolicy = 'no-referrer';
    image.addEventListener('load', function revealLoadedCover() {
      const reveal = function reveal() {
        if (size === 'detail') {
          frame.dataset.imageShape = image.naturalHeight > image.naturalWidth * 1.15 ? 'portrait' : 'landscape';
        }
        frame.classList.add('is-loaded');
      };
      if (typeof image.decode === 'function') image.decode().then(reveal, reveal);
      else reveal();
    });
    image.addEventListener('error', function replaceBrokenCover() {
      if (typeof settings.onFailure === 'function') settings.onFailure();
      if (settings.fallbackNode) {
        frame.replaceWith(settings.fallbackNode);
      } else if (settings.requireImage) {
        frame.remove();
      } else {
        fallback.classList.remove('preview-placeholder');
        fallback.remove();
        frame.replaceWith(fallback);
      }
    });
    frame.append(fallback, image);
    image.src = source;
    return frame;
  }

  function statusLine(entry) {
    const parts = [];
    if (entry.visibility === 'private') parts.push('Private');
    return parts;
  }

  function tagList(entry, limit) {
    const node = element('div', 'tags');
    const tags = entryTags(entry);
    const visibleLimit = limit || 3;
    tags.slice(0, visibleLimit).forEach(function appendTag(tag) {
      node.append(element('span', 'tag', tag.name || tag.normalized_name));
    });
    if (tags.length > visibleLimit) node.append(element('span', 'tag tag-more', '+' + (tags.length - visibleLimit)));
    return node;
  }

  function cardExternalLink(entry, href) {
    const link = element('a', 'entry-card-external');
    link.append(controlIcon('external'));
    link.href = href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.referrerPolicy = 'no-referrer';
    link.setAttribute('aria-label', 'Open original link from ' + sourceLabel(entry));
    link.setAttribute('data-tooltip', 'Open original link');
    function stopCardInteraction(event) {
      event.stopPropagation();
    }
    link.addEventListener('click', stopCardInteraction);
    link.addEventListener('dblclick', stopCardInteraction);
    link.addEventListener('pointerup', stopCardInteraction);
    link.addEventListener('keydown', stopCardInteraction);
    return link;
  }

  function metaLine(entry, href) {
    const node = element('div', 'entry-meta');
    const source = element('span', 'entry-source', sourceLabel(entry));
    const sourceKey = rawSource(entry);
    if (sourceKey) source.dataset.tooltip = sourceKey;
    const facts = element('span', 'entry-meta-facts');
    facts.append(
      element('span', 'entry-date', formatDate(entry.saved_at)),
      element('span', 'entry-kind', ContentTypes.label(entry.kind || 'page'))
    );
    node.append(source, facts);
    if (href) node.append(cardExternalLink(entry, href));
    return node;
  }

  function badgeList(entry) {
    const states = statusLine(entry);
    const node = element('div', 'badges');
    states.forEach(function appendBadge(state) {
      const className = state === 'Private' ? 'badge badge-private' : 'badge';
      node.append(element('span', className, state));
    });
    return node;
  }

  function configureSelectable(node, entry, selectedIds, onSelect, onOpen, management) {
    let touchOpenPending = false;
    node.tabIndex = 0;
    node.dataset.entryId = String(entry.id);
    if (management) node.setAttribute('aria-selected', String(selectedIds.has(entry.id)));
    else node.removeAttribute('aria-selected');
    const privacyLabel = entry.visibility === 'private' ? ' Private.' : '';
    node.setAttribute('aria-label', titleFor(entry) + '.' + privacyLabel + ' ' + t('selection.entryHelp'));
    node.addEventListener('click', function selectEntry(event) {
      if (touchOpenPending || event.detail > 1) return;
      onSelect(entry.id, {
        shiftKey: event.shiftKey,
        selected: node.getAttribute('aria-selected') !== 'true'
      });
    });
    node.addEventListener('dblclick', function openEntry() {
      if (node.getAttribute('aria-selected') !== 'true') {
        onSelect(entry.id, { selected: true });
      }
      onOpen(entry.id, node);
    });
    node.addEventListener('pointerup', function openTouchEntry(event) {
      if (event.pointerType !== 'touch') return;
      touchOpenPending = true;
      onOpen(entry.id, node);
      windowRef.setTimeout(function allowClickAfterTouch() { touchOpenPending = false; }, 500);
    });
    node.addEventListener('keydown', function handleEntryKey(event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        onOpen(entry.id, node);
      } else if (event.key === ' ' || event.key === 'Spacebar') {
        event.preventDefault();
        onSelect(entry.id, { shiftKey: event.shiftKey, selected: node.getAttribute('aria-selected') !== 'true' });
      }
    });
  }

  function selectionTarget(entry, selectedIds, onSelect, touchOnly) {
    const target = element('label', 'entry-select-target' + (touchOnly ? ' entry-touch-select' : ''));
    const checkbox = element('input', touchOnly ? 'entry-select-checkbox' : 'entry-select-checkbox bbs-select-checkbox');
    checkbox.type = 'checkbox';
    checkbox.checked = selectedIds.has(entry.id);
    checkbox.setAttribute('aria-label', t('selection.selectEntry', { title: titleFor(entry) }));
    ['click', 'dblclick', 'pointerup', 'keydown', 'keyup'].forEach(function isolate(type) {
      target.addEventListener(type, function stopCardEvent(event) { event.stopPropagation(); });
    });
    checkbox.addEventListener('click', function selectFromCheckbox(event) {
      onSelect(entry.id, { shiftKey: event.shiftKey, selected: checkbox.checked, preserveFocus: true });
    });
    target.append(checkbox);
    return target;
  }

  function appendResultFooter(body, entry, tags, selectedIds, onSelect) {
    const footer = element('div', 'entry-card-footer');
    if (!tags.childElementCount) footer.classList.add('has-no-tags');
    footer.append(tags, selectionTarget(entry, selectedIds, onSelect, true));
    body.append(footer);
  }

  function gridItem(entry, onOpen, selectedIds, onSelect, management) {
    const presentation = CardPresentation.describe(entry);
    const card = element('article', 'entry-card entry-card-grid');
    card.dataset.cardState = presentation.state;
    if (presentation.isPrivate) card.classList.add('is-private');
    const body = element('div', 'entry-card-body');
    const href = externalUrl(presentation.url);
    body.append(metaLine(entry, href));
    const main = element('div', 'entry-card-main');
    main.dataset.cardState = presentation.state;
    if (presentation.state === 'cover') {
      const fallbackStage = cardFallbackStage(presentation);
      const visual = visualPreview(entry, 'card', {
        ignoreContentFocus: true,
        fallbackNode: fallbackStage,
        onFailure() {
          card.dataset.cardState = 'type';
          main.dataset.cardState = 'type';
        }
      });
      if (visual) main.append(visual);
    }
    if (presentation.state !== 'cover') {
      const context = presentation.summary || entry.typed_metadata?.note || '';
      main.append(element('p', 'entry-card-summary', context || t('results.noSummary')));
      if (!context) main.classList.add('has-no-summary');
    }
    body.append(main);
    if (presentation.title) {
      const title = element('h3', 'entry-title entry-card-title', presentation.title);
      title.dataset.tooltip = presentation.title;
      body.append(title);
    }
    const tags = tagList(entry, 3);
    appendResultFooter(body, entry, tags, selectedIds, onSelect);
    card.append(body);
    card.setAttribute('role', management ? 'option' : 'listitem');
    configureSelectable(card, entry, selectedIds, onSelect, onOpen, management);
    return card;
  }

  function cardFallbackStage(presentation) {
    const fallback = element('div', 'entry-card-type-fallback');
    fallback.append(
      element('strong', '', presentation.typeLabel),
      element('span', '', t('app.previewUnavailable'))
    );
    return fallback;
  }

  function feedItem(entry, onOpen, selectedIds, onSelect, management) {
    const presentation = CardPresentation.describe(entry);
    const fallback = element('div', 'preview preview-feed entry-feed-fallback');
    fallback.append(cardFallbackStage(presentation));
    const visual = visualPreview(entry, 'feed', {
      ignoreContentFocus: true,
      requireImage: true,
      fallbackNode: fallback
    });
    if (!visual) return null;
    const row = element('article', 'entry-feed');
    if (entry.visibility === 'private') row.classList.add('is-private');
    const header = element('div', 'entry-feed-header');
    header.append(metaLine(entry, externalUrl(presentation.url)));
    const body = element('div', 'entry-feed-content');
    if (presentation.title) {
      const title = element('h3', 'entry-title', presentation.title);
      title.dataset.tooltip = presentation.title;
      body.append(title);
    }
    const tags = tagList(entry, 4);
    appendResultFooter(body, entry, tags, selectedIds, onSelect);
    row.append(header);
    row.append(visual);
    row.append(body);
    row.setAttribute('role', management ? 'option' : 'listitem');
    configureSelectable(row, entry, selectedIds, onSelect, onOpen, management);
    return row;
  }

  function listItem(entry, onOpen, selectedIds, onSelect, management) {
    const row = element('tr', 'bbs-row');
    if (entry.visibility === 'private') row.classList.add('is-private');
    const selectCell = element('td', 'bbs-select-cell');
    selectCell.append(selectionTarget(entry, selectedIds, onSelect, false));
    row.append(selectCell);
    const titleCell = element('td', 'bbs-row-title');
    const visibleTitle = CardPresentation.describe(entry).title;
    if (visibleTitle) {
      const title = element('span', 'bbs-title-text', visibleTitle);
      title.dataset.tooltip = visibleTitle;
      titleCell.append(title);
    }
    row.append(titleCell);
    const source = element('td', 'bbs-row-cell', sourceLabel(entry));
    const sourceKey = rawSource(entry);
    if (sourceKey) source.dataset.tooltip = sourceKey;
    const tagCell = tagList(entry, 2);
    const tagDataCell = element('td', 'bbs-row-cell');
    if (tagCell.childElementCount) tagDataCell.append(tagCell);
    const savedCell = element('td', 'bbs-row-cell bbs-saved-cell');
    const savedTime = element('time', '', formatDate(entry.saved_at));
    if (entry.saved_at) savedTime.dateTime = entry.saved_at;
    savedCell.append(savedTime);
    row.append(source, tagDataCell, savedCell);
    configureSelectable(row, entry, selectedIds, onSelect, onOpen, management);
    return row;
  }

  function nextSelection(items, selectedIds, anchorId, targetId, options) {
    return ResultsView.nextSelection(items, selectedIds, anchorId, targetId, options);
  }

  function syncRenderedSelection(container, selectedIds) {
    if (!container) return;
    const selected = selectedIds instanceof Set ? selectedIds : new Set(selectedIds || []);
    container.querySelectorAll('[data-entry-id]').forEach(function syncEntry(node) {
      const checked = selected.has(parseEntryId(node.dataset.entryId, selected));
      const checkbox = node.querySelector('.entry-select-checkbox');
      if (checkbox) checkbox.checked = checked;
      if (!container.classList.contains('is-managing')) {
        node.removeAttribute('aria-selected');
        return;
      }
      node.setAttribute('aria-selected', String(checked));
    });
  }

  function syncRenderedManagement(container, management, selectedIds) {
    if (!container) return;
    const active = management === true;
    container.classList.toggle('is-managing', active);
    if (container.classList.contains('results-list')) {
      const table = container.querySelector('.bbs-table');
      if (table) {
        if (active) {
          table.setAttribute('role', 'grid');
          table.setAttribute('aria-multiselectable', 'true');
        } else {
          table.removeAttribute('role');
          table.removeAttribute('aria-multiselectable');
        }
      }
    } else {
      container.setAttribute('role', active ? 'listbox' : 'list');
      if (active) container.setAttribute('aria-multiselectable', 'true');
      else container.removeAttribute('aria-multiselectable');
      container.querySelectorAll('[data-entry-id]').forEach(function syncEntryRole(node) {
        node.setAttribute('role', active ? 'option' : 'listitem');
      });
    }
    syncRenderedSelection(container, selectedIds);
  }

  function parseEntryId(raw, selectedIds) {
    if (selectedIds.has(raw)) return raw;
    const numeric = Number(raw);
    return Number.isSafeInteger(numeric) && selectedIds.has(numeric) ? numeric : raw;
  }

  function renderSidebar(options) {
    const settings = options || {};
    const onScope = typeof settings.onStructure === 'function' ? settings.onStructure : function noop() {};
    const folderTargets = Array.from(documentRef.querySelectorAll('#folders'));
    const groupTargets = Array.from(documentRef.querySelectorAll('#url-groups'));
    folderTargets.forEach(clear);
    groupTargets.forEach(clear);
    const folders = Array.isArray(settings.folders) ? settings.folders : [];
    const urlGroups = Array.isArray(settings.urlGroups) ? settings.urlGroups : [];
    const activeStructure = settings.activeStructure || {};
    folderTargets.forEach(function renderFolderTarget(target) {
      renderTree(target, folders, 'folder', Object.assign({}, settings, {
        activeScope: { scope: 'folder', value: activeStructure.folderId || '' }
      }), onScope, function folderLabel(folder) {
        return folder.name + (folder.entry_count ? ' (' + folder.entry_count + ')' : '');
      }, 'No Folders yet');
    });
    groupTargets.forEach(function renderGroupTarget(target) {
      renderTree(target, urlGroups, 'url_group', Object.assign({}, settings, {
        activeScope: { scope: 'url_group', value: activeStructure.urlGroupId || '' }
      }), onScope, function groupLabel(group) {
        const label = group.kind === 'domain' ? group.label : compactGroupLabel(group.label);
        return label + (group.entry_count ? ' (' + group.entry_count + ')' : '');
      }, 'No URLs yet');
    });
  }

  function compactGroupLabel(value) {
    const label = String(value || '');
    const pathIndex = label.search(/[/?]/u);
    return pathIndex < 0 ? label : label.slice(pathIndex);
  }

  function renderTree(target, roots, scopeType, settings, onScope, labelFor, emptyMessage) {
    if (settings.error) {
      target.append(element('p', 'sidebar-empty', settings.error));
      return;
    }
    if (!roots.length) target.append(element('p', 'sidebar-empty', emptyMessage));
    function createNode(item, depth) {
      const label = labelFor(item);
      const children = Array.isArray(item.children) ? item.children : [];
      if (children.length) {
        const branch = element('details', 'tree-branch');
        const expansionKey = scopeType + ':' + String(item.id);
        branch.open = treeExpansion.get(expansionKey) !== false;
        branch.addEventListener('toggle', function rememberTreeExpansion() {
          treeExpansion.set(expansionKey, branch.open);
        });
        const summary = element('summary', 'tree-parent', label);
        summary.style.setProperty('--tree-depth', String(depth));
        summary.dataset.tooltip = label;
        const childList = element('div', 'tree-children');
        children.forEach(function appendChild(childItem) {
          childList.append(createNode(childItem, depth + 1));
        });
        branch.append(summary, childList);
        return branch;
      }
      const node = scopeButton({ label: label, scope: { type: scopeType, value: item.id } }, settings.activeScope, onScope);
      node.classList.add('nav-item', 'tree-item');
      node.style.setProperty('--tree-depth', String(depth));
      node.dataset.tooltip = label;
      return node;
    }
    roots.forEach(function rootItem(item) { target.append(createNode(item, 0)); });
  }

  function renderFolderOptions(select, folders) {
    if (!select) return;
    clear(select);
    const empty = element('option', '', 'No Folder');
    empty.value = '';
    select.append(empty);
    function append(folder, depth) {
      const option = element('option', '', '— '.repeat(depth) + folder.name);
      option.value = String(folder.id);
      select.append(option);
      (Array.isArray(folder.children) ? folder.children : []).forEach(function child(item) { append(item, depth + 1); });
    }
    (Array.isArray(folders) ? folders : []).forEach(function rootFolder(folder) { append(folder, 0); });
  }

  function renderResults(options) {
    return ResultsView.renderResults(options, { clear, element, gridItem, feedItem, listItem, renderedEntryKeys, renderEmpty, syncRenderedManagement, t });
  }

  function renderPagination(options) {
    return ResultsView.renderPagination(options, { clear, element, button, iconButton, t });
  }

  function paginationItems(page, totalPages) { return ResultsView.paginationItems(page, totalPages); }

  function externalUrl(value) {
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null;
    } catch (error) {
      return null;
    }
  }

  function renderDetail(options) {
    return DetailView.renderDetail(options, {
      clear, element, button, iconButton, titleFor, sourceLabel, badgeList, visualPreview, externalUrl,
      formatDate, entryTags, tagList, renderFolderOptions, detailField, detailSelect, windowRef, t
    });
  }

  function secureImageUrl(value) {
    const candidate = externalUrl(value);
    return candidate && new URL(candidate).protocol === 'https:' ? candidate : null;
  }

  function detailField(labelText, id, value, type) {
    const wrapper = element('div', 'form-field');
    const label = element('label', '', labelText);
    const input = element('input');
    input.id = 'detail-' + id;
    input.type = type || 'text';
    input.value = value;
    label.htmlFor = input.id;
    wrapper.append(label, input);
    return { wrapper: wrapper, input: input };
  }

  function detailSelect(labelText, id, choices, value) {
    const wrapper = element('div', 'form-field');
    const label = element('label', '', labelText);
    const select = element('select');
    select.id = id;
    label.htmlFor = id;
    choices.forEach(function appendChoice(choice) {
      const option = element('option', '', choice[1]);
      option.value = choice[0];
      select.append(option);
    });
    select.value = value;
    wrapper.append(label, select);
    return { wrapper: wrapper, select: select };
  }

  function renderEmpty(container, message, actions) {
    if (!container) return;
    clear(container);
    container.className = 'results results-empty';
    const text = element('p', 'empty-message', message || 'Nothing to show yet.');
    container.append(text);
    if (Array.isArray(actions) && actions.length) {
      const controls = element('div', 'empty-state-actions');
      actions.forEach(function appendAction(action, index) {
        controls.append(button(action.label, index === 0 ? 'button button-primary' : 'button', action.onClick));
      });
      container.append(controls);
    }
  }

  function setStatus(message, tone) {
    const target = documentRef.querySelector('#app-status, #status');
    if (!target) return;
    target.textContent = message || '';
    target.dataset.tone = tone || 'neutral';
  }

  return {
    coverUrl: coverUrl,
    createAutosaveCoordinator: createAutosaveCoordinator,
    formatDate: formatDate,
    nextSelection: nextSelection,
    paginationItems: paginationItems,
    resultsRenderKey: resultsRenderKey,
    sourceDisplayName: sourceDisplayName,
    renderSidebar: renderSidebar,
    renderFolderOptions: renderFolderOptions,
    renderResults: renderResults,
    syncRenderedManagement: syncRenderedManagement,
    syncRenderedSelection: syncRenderedSelection,
    renderPagination: renderPagination,
    renderDetail: renderDetail,
    renderEmpty: renderEmpty,
    setStatus: setStatus
  };
}));
