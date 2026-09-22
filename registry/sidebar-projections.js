"use strict";

const { listEntryReferences } = require("./entry-query.js");
const { getFolderTree } = require("./folders.js");
const { deriveUrlGroupIndex } = require("./url-groups.js");

const FILTER_KEYS = Object.freeze([
  "search", "kind", "provider", "sourceDomain", "visibility", "agentAccess",
  "contentFocus", "preview", "folderId", "includeDescendants", "unfiled",
  "savedFrom", "savedTo", "tag", "urlGroupId"
]);

function getSidebarFolderTree(registry, filters = {}) {
  const tree = getFolderTree(registry);
  const scopedFilters = without(filters, ["folderId", "includeDescendants", "unfiled"]);
  const filtered = hasFilters(scopedFilters);
  const counts = filtered ? matchingFolderCounts(registry, scopedFilters) : directFolderCounts(tree);
  return projectFolders(tree, counts, numericId(filters.folderId), { pruneZero: filtered });
}

function listSidebarUrlGroups(registry, filters = {}) {
  const allEntries = listEntryReferences(registry);
  const index = deriveUrlGroupIndex(allEntries);
  const scopedFilters = without(filters, ["urlGroupId"]);
  if (!hasFilters(scopedFilters)) return index.groups;

  const matchingIds = new Set(listEntryReferences(registry, scopedFilters).map((entry) => entry.id));
  const activeId = String(filters.urlGroupId || "");
  return index.groups.flatMap((group) => {
    const children = group.children.map((child) => projectUrlGroup(child, index.membership, matchingIds))
      .filter((child) => child.entry_count > 0 || child.id === activeId);
    const projected = projectUrlGroup(group, index.membership, matchingIds);
    return projected.entry_count > 0 || projected.id === activeId || children.length
      ? [{ ...projected, children }]
      : [];
  });
}

function matchingFolderCounts(registry, filters) {
  const counts = new Map();
  for (const entry of listEntryReferences(registry, filters)) {
    if (entry.folder_id === null) continue;
    counts.set(entry.folder_id, (counts.get(entry.folder_id) || 0) + 1);
  }
  return counts;
}

function directFolderCounts(nodes, counts = new Map()) {
  for (const node of nodes) {
    counts.set(node.id, Number(node.entry_count || 0));
    directFolderCounts(node.children || [], counts);
  }
  return counts;
}

function projectFolders(nodes, counts, activeId, options = {}) {
  return nodes.flatMap((node) => {
    const children = projectFolders(node.children || [], counts, activeId, options);
    const direct = counts.get(node.id) || 0;
    const total = direct + children.reduce((sum, child) => sum + child.entry_count_total, 0);
    const keep = options.pruneZero !== true || total > 0 || children.length || node.id === activeId;
    return keep ? [{
      ...node,
      entry_count: total,
      entry_count_direct: direct,
      entry_count_total: total,
      children
    }] : [];
  });
}

function projectUrlGroup(group, membership, matchingIds) {
  let count = 0;
  for (const id of membership.get(group.id) || []) {
    if (matchingIds.has(id)) count += 1;
  }
  return { ...group, entry_count: count, children: [] };
}

function without(filters, omittedKeys) {
  const omitted = new Set(omittedKeys);
  return Object.fromEntries(Object.entries(filters || {}).filter(([key]) => !omitted.has(key)));
}

function hasFilters(filters) {
  return FILTER_KEYS.some((key) => filters[key] !== undefined && filters[key] !== null && filters[key] !== "");
}

function numericId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

module.exports = {
  directFolderCounts,
  getSidebarFolderTree,
  listSidebarUrlGroups,
  projectFolders
};
