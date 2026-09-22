(function exposeQueryState(root, factory) {
  const contentTypes = typeof module === 'object' && module.exports
    ? require('./content-types.js')
    : root?.WBHContentTypes;
  const api = factory(contentTypes);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WBHQueryState = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createQueryState(contentTypes) {
  'use strict';

  const FILTER_KEYS = [
    'preview', 'kind', 'sourceDomain', 'visibility', 'folderId', 'folderLabel',
    'folderIncludeDescendants', 'tag', 'savedFrom', 'savedTo', 'urlGroupId', 'urlGroupLabel'
  ];
  const STRING_FILTER_KEYS = FILTER_KEYS.filter(function excludeBoolean(key) { return key !== 'folderIncludeDescendants'; });
  const LOCATION_PARAMS = [
    'q', 'view', 'sort', 'page', 'preview', 'kind', 'source', 'visibility', 'folder', 'folder_label',
    'folder_descendants', 'tag', 'saved_from', 'saved_to', 'recent', 'url_group', 'url_group_label'
  ];
  const SORT_VALUES = new Set(['newest', 'oldest', 'updated_desc', 'updated_asc', 'title_asc', 'title_desc', 'source_asc', 'source_desc']);
  const VIEW_VALUES = new Set(['grid', 'feed', 'list']);

  function emptyFilters() {
    return {
      preview: '', kind: '', sourceDomain: '', visibility: '', folderId: '', folderLabel: '',
      folderIncludeDescendants: false, tag: '', savedFrom: '', savedTo: '',
      urlGroupId: '', urlGroupLabel: '', recentPreset: false
    };
  }

  function defaultFilters() {
    return Object.assign(emptyFilters(), { visibility: 'normal' });
  }

  function copyFilters(filters) {
    const next = emptyFilters();
    STRING_FILTER_KEYS.forEach(function copy(key) { next[key] = String(filters?.[key] || ''); });
    next.folderIncludeDescendants = filters?.folderIncludeDescendants === true;
    next.recentPreset = filters?.recentPreset === true;
    return next;
  }

  function recentDate(now) {
    const date = new Date(typeof now === 'function' ? now() : now || Date.now());
    date.setUTCDate(date.getUTCDate() - 14);
    return date.toISOString().slice(0, 10);
  }

  function applyRecentPreset(filters, now) {
    const next = copyFilters(filters);
    next.savedFrom = recentDate(now);
    next.savedTo = '';
    next.recentPreset = true;
    return next;
  }

  function applyForm(filters, values) {
    const next = copyFilters(Object.assign({}, filters, values));
    if (Object.prototype.hasOwnProperty.call(values || {}, 'folderId')
      && !Object.prototype.hasOwnProperty.call(values || {}, 'folderIncludeDescendants')) {
      next.folderIncludeDescendants = false;
    }
    if (!next.folderId) next.folderIncludeDescendants = false;
    next.recentPreset = false;
    return next;
  }

  function selectStructure(filters, type, value, label) {
    const next = copyFilters(filters);
    const normalized = String(value || '');
    if (type === 'folder' || type === 'folder_descendants') {
      const includeDescendants = type === 'folder_descendants';
      const togglingOff = next.folderId === normalized
        && next.folderIncludeDescendants === includeDescendants;
      next.folderId = togglingOff ? '' : normalized;
      next.folderLabel = togglingOff ? '' : String(label || 'Folder');
      next.folderIncludeDescendants = togglingOff ? false : includeDescendants;
      next.urlGroupId = '';
      next.urlGroupLabel = '';
    } else if (type === 'url_group') {
      const togglingOff = next.urlGroupId === normalized;
      next.urlGroupId = togglingOff ? '' : normalized;
      next.urlGroupLabel = togglingOff ? '' : String(label || 'URL group');
      next.folderId = '';
      next.folderLabel = '';
      next.folderIncludeDescendants = false;
    }
    return next;
  }

  function removeFilter(filters, key) {
    const next = copyFilters(filters);
    if (!FILTER_KEYS.includes(key)) return next;
    if (key === 'folderIncludeDescendants') {
      next.folderIncludeDescendants = false;
      return next;
    }
    next[key] = '';
    if (key === 'folderId') {
      next.folderLabel = '';
      next.folderIncludeDescendants = false;
    }
    if (key === 'urlGroupId') next.urlGroupLabel = '';
    if (key === 'savedFrom' || key === 'savedTo') next.recentPreset = false;
    return next;
  }

  function activeItems(filters, view) {
    const value = copyFilters(filters);
    const items = [];
    if (view === 'feed') items.push({ label: 'Feed: Has image', fixed: true });
    else if (view === 'list') items.push({ label: 'List: No image', fixed: true });
    else if (value.preview) items.push({ key: 'preview', label: value.preview === 'with' ? 'Has image' : 'No image' });
    if (value.kind) items.push({ key: 'kind', label: `Content type: ${contentTypes.label(value.kind)}` });
    if (value.sourceDomain) items.push({ key: 'sourceDomain', label: `Source: ${value.sourceDomain}` });
    if (value.visibility) items.push({ key: 'visibility', label: `Visibility: ${value.visibility}` });
    if (value.folderId) {
      const suffix = value.folderIncludeDescendants ? ' + subfolders' : '';
      items.push({ key: 'folderId', label: `Folder: ${value.folderLabel || value.folderId}${suffix}` });
    }
    if (value.tag) items.push({ key: 'tag', label: `Tag: ${value.tag}` });
    if (value.savedFrom) items.push({ key: 'savedFrom', label: value.recentPreset ? 'Saved: Last 14 days' : `Saved from: ${value.savedFrom}` });
    if (value.savedTo) items.push({ key: 'savedTo', label: `Saved to: ${value.savedTo}` });
    if (value.urlGroupId) items.push({ key: 'urlGroupId', label: `URL: ${value.urlGroupLabel || value.urlGroupId}` });
    return items;
  }

  function entryQuery(options) {
    const settings = options || {};
    return Object.assign(entryScopeQuery(settings), {
      sort: settings.sort || 'newest',
      page: settings.page,
      page_size: settings.pageSize,
      signal: settings.signal
    });
  }

  function entryScopeQuery(options) {
    const settings = options || {};
    const filters = copyFilters(settings.filters);
    return {
      search: settings.search || undefined,
      preview: settings.view === 'feed' ? 'with' : settings.view === 'list' ? 'without' : filters.preview || undefined,
      kind: filters.kind || undefined, source_domain: filters.sourceDomain || undefined,
      visibility: filters.visibility || undefined, folder_id: filters.folderId || undefined,
      include_descendants: filters.folderId && filters.folderIncludeDescendants ? true : undefined,
      tag: filters.tag || undefined, saved_from: filters.savedFrom || undefined,
      saved_to: filters.savedTo || undefined, url_group_id: filters.urlGroupId || undefined
    };
  }

  function title(filters) {
    const value = copyFilters(filters);
    if (value.folderId) return value.folderLabel || 'Folder entries';
    if (value.urlGroupId) return value.urlGroupLabel || 'URL group entries';
    return 'All entries';
  }

  function readLocation(searchParams, options) {
    const params = searchParams instanceof URLSearchParams ? searchParams : new URLSearchParams(searchParams || '');
    const filters = defaultFilters();
    const defaultView = VIEW_VALUES.has(options?.view) ? options.view : 'grid';
    filters.preview = choice(params.get('preview'), ['with', 'without']);
    filters.kind = choice(params.get('kind'), contentTypes.TYPES.map((type) => type.value));
    filters.sourceDomain = String(params.get('source') || '').trim().toLocaleLowerCase('en-US');
    if (params.get('visibility') === 'any') filters.visibility = '';
    else if (params.has('visibility')) filters.visibility = choice(params.get('visibility'), ['normal', 'private']) || 'normal';
    filters.folderId = String(params.get('folder') || '');
    filters.folderLabel = filters.folderId ? String(params.get('folder_label') || '') : '';
    filters.folderIncludeDescendants = Boolean(filters.folderId) && params.get('folder_descendants') === '1';
    filters.tag = String(params.get('tag') || '').trim();
    filters.savedFrom = dateValue(params.get('saved_from'));
    filters.savedTo = dateValue(params.get('saved_to'));
    filters.recentPreset = params.get('recent') === '1' && Boolean(filters.savedFrom) && !filters.savedTo;
    filters.urlGroupId = String(params.get('url_group') || '');
    filters.urlGroupLabel = filters.urlGroupId ? String(params.get('url_group_label') || '') : '';
    if (filters.folderId && filters.urlGroupId) {
      filters.urlGroupId = '';
      filters.urlGroupLabel = '';
    }
    if (!filters.folderId) filters.folderIncludeDescendants = false;
    const page = Number.parseInt(params.get('page'), 10);
    return {
      search: String(params.get('q') || '').trim().slice(0, 1000),
      filters,
      sort: canonicalSort(params.get('sort')),
      view: choice(params.get('view'), [...VIEW_VALUES]) || defaultView,
      page: Number.isSafeInteger(page) && page > 0 ? page : 1
    };
  }

  function writeLocation(urlValue, state) {
    const url = new URL(String(urlValue));
    LOCATION_PARAMS.forEach((name) => url.searchParams.delete(name));
    const filters = copyFilters(state?.filters);
    const view = VIEW_VALUES.has(state?.view) ? state.view : 'grid';
    const sort = SORT_VALUES.has(state?.sort) ? state.sort : 'newest';
    const page = Number(state?.page);
    setParam(url, 'q', String(state?.search || '').trim());
    url.searchParams.set('view', view);
    if (sort !== 'newest') url.searchParams.set('sort', sort);
    if (view !== 'feed' && Number.isSafeInteger(page) && page > 1) url.searchParams.set('page', String(page));
    setParam(url, 'preview', filters.preview);
    setParam(url, 'kind', filters.kind);
    setParam(url, 'source', filters.sourceDomain);
    if (filters.visibility === '') url.searchParams.set('visibility', 'any');
    else if (filters.visibility !== 'normal') setParam(url, 'visibility', filters.visibility);
    setParam(url, 'folder', filters.folderId);
    if (filters.folderId) {
      setParam(url, 'folder_label', filters.folderLabel);
      if (filters.folderIncludeDescendants) url.searchParams.set('folder_descendants', '1');
    }
    setParam(url, 'tag', filters.tag);
    setParam(url, 'saved_from', filters.savedFrom);
    setParam(url, 'saved_to', filters.savedTo);
    if (filters.recentPreset && filters.savedFrom && !filters.savedTo) url.searchParams.set('recent', '1');
    setParam(url, 'url_group', filters.urlGroupId);
    if (filters.urlGroupId) setParam(url, 'url_group_label', filters.urlGroupLabel);
    return url;
  }

  function choice(value, allowed) {
    const normalized = String(value || '');
    return allowed.includes(normalized) ? normalized : '';
  }

  function canonicalSort(value) {
    const normalized = String(value || '');
    if (normalized === 'title') return 'title_asc';
    return SORT_VALUES.has(normalized) ? normalized : 'newest';
  }

  function dateValue(value) {
    const normalized = String(value || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return '';
    const date = new Date(`${normalized}T00:00:00Z`);
    return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== normalized ? '' : normalized;
  }

  function setParam(url, name, value) {
    if (value !== undefined && value !== null && String(value) !== '') url.searchParams.set(name, String(value));
  }

  return {
    activeItems,
    applyForm,
    applyRecentPreset,
    copyFilters,
    defaultFilters,
    emptyFilters,
    entryQuery,
    entryScopeQuery,
    recentDate,
    readLocation,
    removeFilter,
    selectStructure,
    title,
    writeLocation
  };
}));
