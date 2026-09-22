"use strict";

const { createHash } = require("node:crypto");

const { RegistryError } = require("./errors.js");
const { isTrackingParameter, normalizeSourceDomain } = require("./url-policy.js");

const MIN_DEEP_GROUP_SUPPORT = 2;

function listUrlGroups(registry) {
  const rows = registry.db.prepare(`
    SELECT id, url_canonical
    FROM entries
    WHERE deleted_at IS NULL
    ORDER BY id ASC
  `).all();
  return deriveUrlGroupIndex(rows).groups;
}

function resolveUrlGroupEntryIds(registry, urlGroupId) {
  const id = String(urlGroupId ?? "").trim();
  if (!id) {
    throw new RegistryError("VALIDATION_ERROR", "url_group_id cannot be empty.", {
      field: "url_group_id"
    });
  }
  const rows = registry.db.prepare(`
    SELECT id, url_canonical
    FROM entries
    WHERE deleted_at IS NULL
    ORDER BY id ASC
  `).all();
  const membership = deriveUrlGroupIndex(rows).membership.get(id);
  if (!membership) {
    throw new RegistryError("URL_GROUP_NOT_FOUND", "URL Group not found.", {
      urlGroupId: id
    });
  }
  return [...membership].sort((left, right) => left - right);
}

function deriveUrlGroups(entries) {
  return deriveUrlGroupIndex(entries).groups;
}

function deriveUrlGroupIndex(entries) {
  const domains = new Map();
  for (const entry of entries || []) {
    const id = normalizeEntryId(entry?.id);
    const analyzed = analyzeCanonicalUrl(entry?.url_canonical);
    if (id === null || analyzed === null) {
      continue;
    }

    let domain = domains.get(analyzed.authority);
    if (!domain) {
      domain = createPathNode("", "", 0);
      domains.set(analyzed.authority, domain);
    }
    domain.entryIds.add(id);

    let node = domain;
    for (const pathPart of analyzed.pathParts) {
      let child = node.children.get(pathPart.segment);
      if (!child) {
        child = createPathNode(pathPart.segment, pathPart.prefix, pathPart.depth);
        node.children.set(pathPart.segment, child);
      }
      child.entryIds.add(id);
      node = child;
    }

    if (analyzed.queryKeys.length) {
      const signature = JSON.stringify(analyzed.queryKeys);
      let shape = node.queryShapes.get(signature);
      if (!shape) {
        shape = { keys: analyzed.queryKeys, entryIds: new Set() };
        node.queryShapes.set(signature, shape);
      }
      shape.entryIds.add(id);
    }
  }

  const membership = new Map();
  const groups = [...domains.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([authority, root]) => buildDomainGroup(authority, root, membership));
  return { groups, membership };
}

function buildDomainGroup(authority, root, membership) {
  const id = groupId({ kind: "domain", authority });
  membership.set(id, new Set(root.entryIds));
  return {
    id,
    label: authority,
    kind: "domain",
    depth: 0,
    entry_count: root.entryIds.size,
    children: buildFlatChildren(authority, root, membership)
  };
}

function buildFlatChildren(authority, root, membership) {
  const candidates = collectCandidates(authority, root);
  let active = [...candidates];
  let assignments = assignEntries(root.entryIds, active);
  while (active.some((candidate) => (assignments.get(candidate.id)?.size || 0) < MIN_DEEP_GROUP_SUPPORT)) {
    active = active.filter((candidate) => (assignments.get(candidate.id)?.size || 0) >= MIN_DEEP_GROUP_SUPPORT);
    assignments = assignEntries(root.entryIds, active);
  }
  return active.map((candidate) => {
    const entryIds = assignments.get(candidate.id) || new Set();
    membership.set(candidate.id, new Set(entryIds));
    return {
      id: candidate.id,
      label: candidate.label,
      kind: candidate.kind,
      depth: 1,
      entry_count: entryIds.size,
      children: []
    };
  }).sort(compareGroups);
}

function collectCandidates(authority, root) {
  const candidates = [];
  function visit(node) {
    if (node.depth > 0 && node.entryIds.size >= MIN_DEEP_GROUP_SUPPORT) {
      candidates.push({
        id: groupId({ kind: "path", authority, path: node.prefix }),
        label: `${authority}${node.prefix}`,
        kind: "path",
        specificity: node.depth * 2,
        entryIds: node.entryIds
      });
    }
    for (const shape of node.queryShapes.values()) {
      if (shape.entryIds.size < MIN_DEEP_GROUP_SUPPORT) continue;
      const pathname = node.prefix || "/";
      const query = shape.keys.map((key) => `${encodeURIComponent(key)}=*`).join("&");
      candidates.push({
        id: groupId({ kind: "query", authority, path: pathname, queryKeys: shape.keys }),
        label: `${authority}${pathname}?${query}`,
        kind: "query",
        specificity: node.depth * 2 + 1,
        entryIds: shape.entryIds
      });
    }
    for (const child of node.children.values()) visit(child);
  }
  visit(root);
  return candidates;
}

function assignEntries(entryIds, candidates) {
  const assignments = new Map(candidates.map((candidate) => [candidate.id, new Set()]));
  for (const id of entryIds) {
    const selected = candidates
      .filter((candidate) => candidate.entryIds.has(id))
      .sort((left, right) => right.specificity - left.specificity || compareText(left.label, right.label))[0];
    if (selected) assignments.get(selected.id).add(id);
  }
  return assignments;
}

function createPathNode(segment, prefix, depth) {
  return {
    segment,
    prefix,
    depth,
    entryIds: new Set(),
    children: new Map(),
    queryShapes: new Map()
  };
}

function analyzeCanonicalUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    return null;
  }
  const hostname = normalizeSourceDomain(parsed.hostname);
  if (!hostname) {
    return null;
  }
  const authority = parsed.port ? `${hostname}:${parsed.port}` : hostname;
  const pathParts = pathPartsFrom(parsed.pathname);
  const queryKeys = [...new Set(
    [...parsed.searchParams.keys()].filter((key) => !isTrackingParameter(key))
  )].sort(compareText);
  return { authority, pathParts, queryKeys };
}

function pathPartsFrom(pathname) {
  if (!pathname || pathname === "/") {
    return [];
  }
  const segments = pathname.slice(1).split("/");
  let prefix = "";
  return segments.map((segment, index) => {
    prefix += `/${segment}`;
    return { segment, prefix, depth: index + 1 };
  });
}

function normalizeEntryId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function groupId(basis) {
  return createHash("sha256")
    .update(JSON.stringify(basis), "utf8")
    .digest("base64url");
}

function compareGroups(left, right) {
  const labelOrder = compareText(left.label, right.label);
  if (labelOrder !== 0) {
    return labelOrder;
  }
  return compareText(left.kind, right.kind);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

module.exports = {
  MIN_DEEP_GROUP_SUPPORT,
  analyzeCanonicalUrl,
  deriveUrlGroupIndex,
  deriveUrlGroups,
  listUrlGroups,
  resolveUrlGroupEntryIds
};
