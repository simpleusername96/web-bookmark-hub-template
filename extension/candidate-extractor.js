(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.WBHCandidateExtractor = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function createCandidateExtractor(options) {
    const documentRef = options.documentRef;
    const windowRef = options.windowRef;
    const contract = options.contract;
    const profiles = Array.isArray(options.profiles) ? options.profiles : [];

    function scan() {
      const profile = activeProfile();
      if (profile) {
        const templateRecords = isDetailPage(profile)
          ? detailRecords(profile)
          : cardRecords(profile);
        return templateRecords;
      }
      return genericRecords();
    }

    function activeProfile() {
      const hostname = windowRef.location.hostname.toLowerCase();
      return profiles.find(function matchingProfile(profile) {
        const hostMatch = (profile.hostSuffixes || []).some(function matchSuffix(suffix) {
          const value = String(suffix || "").toLowerCase();
          return hostname === value || hostname.endsWith(`.${value}`);
        });
        if (!hostMatch) return false;
        return testRegex(profile.gridPathRegex, windowRef.location.pathname)
          || testRegex(profile.detailPathRegex, windowRef.location.pathname);
      }) || null;
    }

    function isDetailPage(profile) {
      return testRegex(profile.detailPathRegex, windowRef.location.pathname);
    }

    function cardRecords(profile) {
      const records = new Map();
      queryAll(documentRef, profile.cardSelectors || []).forEach(function cardAnchor(anchor) {
        if (!anchor || typeof anchor.href !== "string") return;
        const entryUrl = normalizeTemplateEntryUrl(anchor.href, profile);
        if (!entryUrl || !contract.isProfileRelated(windowRef.location.href, entryUrl, profile)) return;
        const host = findCardHost(anchor, profile);
        if (!host || !isVisible(host, 1, true)) return;
        const metadata = {
          entryUrl,
          publishedAt: firstTimestamp(host, profile.cardDateSelectors || []),
          adapter: profile.id
        };
        collectMediaRecords(host, profile.cardMediaSelectors || ["img", "video"], 80).forEach(function addMedia(media) {
          const candidate = { ...metadata, assetUrls: [media.assetUrl], presenceAssetUrls: media.presenceAssetUrls };
          addRecord(records, {
            key: candidateKey(candidate),
            host: media.host,
            candidate
          });
        });
      });
      return [...records.values()];
    }

    function detailRecords(profile) {
      const root = findDetailRoot(profile);
      if (!root) return [];
      const entryUrl = detailEntryUrl(root, profile);
      if (!entryUrl || !contract.isProfileRelated(windowRef.location.href, entryUrl, profile)) return [];
      const selectors = profile.detailMediaSelectors || ["img", "video"];
      return collectMediaRecords(root, selectors, 96).map(function detailMedia(media) {
        const candidate = {
          entryUrl,
          publishedAt: firstTimestamp(root, profile.detailDateSelectors || profile.cardDateSelectors || []),
          assetUrls: [media.assetUrl],
          presenceAssetUrls: media.presenceAssetUrls,
          adapter: profile.id
        };
        return { key: candidateKey(candidate), host: media.host, candidate };
      });
    }

    function genericRecords() {
      const records = new Map();
      queryAll(documentRef, ["img", "video"]).forEach(function genericMedia(media) {
        if (!isVisible(media, 96, true)) return;
        const presenceAssetUrls = mediaReferences(media);
        const assetUrl = presenceAssetUrls[0];
        if (!assetUrl) return;
        const anchor = typeof media.closest === "function" ? media.closest("a[href]") : null;
        const candidate = contract.genericImageCandidate({
          currentSrc: assetUrl,
          anchorHref: anchor?.href,
          pageUrl: windowRef.location.href,
          width: media.getBoundingClientRect().width,
          height: media.getBoundingClientRect().height,
          intersectionRatio: 1,
          visible: true
        });
        if (!candidate) return;
        candidate.presenceAssetUrls = presenceAssetUrls;
        addRecord(records, {
          key: candidateKey(candidate),
          host: media,
          candidate
        });
      });
      return [...records.values()];
    }

    function findCardHost(anchor, profile) {
      if (profile.id === "x-media") {
        const article = anchor.closest?.("article[data-testid='tweet'], article[role='article']");
        if (article) return article;
      }
      for (const selector of profile.cardContainerSelectors || []) {
        try {
          const host = anchor.closest?.(selector);
          if (host) return host;
        } catch (_error) {}
      }
      return anchor;
    }

    function findDetailRoot(profile) {
      const roots = queryAll(documentRef, profile.detailRootSelectors || [])
        .filter(function visibleRoot(node) { return isVisible(node, 96, true); });
      if (roots.length) return roots[0];
      return null;
    }

    function detailEntryUrl(root, profile) {
      if (testRegex(profile.detailPathRegex, windowRef.location.pathname)) {
        return normalizeTemplateEntryUrl(windowRef.location.href, profile);
      }
      for (const node of queryAll(root, profile.detailPermalinkSelectors || [])) {
        const anchor = node.href ? node : node.closest?.("a[href]");
        const value = normalizeTemplateEntryUrl(anchor?.href, profile);
        if (value) return value;
      }
      return "";
    }

    function collectMediaRecords(rootNode, selectors, minSize) {
      const records = [];
      const seen = new Set();
      queryAll(rootNode, selectors).forEach(function collect(node) {
        if (!isVisible(node, minSize, true)) return;
        const presenceAssetUrls = mediaReferences(node);
        const reference = presenceAssetUrls[0];
        if (!reference || seen.has(reference)) return;
        seen.add(reference);
        records.push({ host: node, assetUrl: reference, presenceAssetUrls });
      });
      return records;
    }

    function primaryMediaHost(rootNode, selectors, minSize) {
      return queryAll(rootNode, selectors)
        .filter(function visibleMedia(node) { return isVisible(node, minSize, true) && mediaReference(node); })
        .sort(function largestFirst(left, right) {
          return rectArea(right.getBoundingClientRect()) - rectArea(left.getBoundingClientRect());
        })[0] || null;
    }

    function mediaReference(node) {
      return mediaReferences(node)[0] || "";
    }

    function mediaReferences(node) {
      const tagName = String(node?.tagName || "").toUpperCase();
      const values = tagName === "VIDEO"
        ? [node.poster]
        : [node.currentSrc, node.src, node.getAttribute?.("src"), node.getAttribute?.("data-src")];
      const references = [];
      values.forEach(function addReference(raw) {
        try {
          const value = contract.httpUrl(raw, "ASSET_URL_INVALID");
          if (!references.includes(value)) references.push(value);
        } catch (_error) {}
      });
      return references;
    }

    function isVisible(node, minSize, requireViewport) {
      if (!node || typeof node.getBoundingClientRect !== "function") return false;
      const rect = node.getBoundingClientRect();
      if (rect.width < minSize || rect.height < minSize) return false;
      const style = windowRef.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
      if (!requireViewport) return true;
      return rect.bottom > 0 && rect.right > 0 && rect.top < windowRef.innerHeight && rect.left < windowRef.innerWidth;
    }

    function firstTimestamp(rootNode, selectors) {
      for (const node of queryAll(rootNode, selectors)) {
        const value = node.getAttribute?.("datetime") || node.getAttribute?.("title") || node.textContent;
        if (!value) continue;
        const date = new Date(String(value));
        if (Number.isFinite(date.getTime())) return date.toISOString();
      }
      return undefined;
    }

    function queryAll(rootNode, selectors) {
      const nodes = [];
      for (const selector of selectors || []) {
        try {
          if (rootNode.matches?.(selector)) nodes.push(rootNode);
          nodes.push(...rootNode.querySelectorAll(selector));
        } catch (_error) {}
      }
      return [...new Set(nodes)];
    }

    return { activeProfile, scan };
  }

  function addRecord(records, incoming) {
    const previous = records.get(incoming.key);
    if (!previous) {
      records.set(incoming.key, incoming);
      return;
    }
    records.set(incoming.key, {
      key: previous.key,
      host: previous.host,
      candidate: mergeCandidate(previous.candidate, incoming.candidate)
    });
  }

  function mergeCandidate(previous, incoming) {
    return {
      entryUrl: previous.entryUrl,
      publishedAt: previous.publishedAt || incoming.publishedAt,
      assetUrls: [...new Set([...(previous.assetUrls || []), ...(incoming.assetUrls || [])])],
      presenceAssetUrls: [...new Set([...(previous.presenceAssetUrls || []), ...(incoming.presenceAssetUrls || [])])],
      adapter: previous.adapter || incoming.adapter || "generic"
    };
  }

  function candidateKey(candidate) {
    const adapter = String(candidate?.adapter || "generic");
    let url;
    try {
      url = new URL(String(candidate?.entryUrl || ""));
    } catch (_error) {
      return `${adapter}|${String(candidate?.entryUrl || "")}|${candidateAssetKey(candidate)}`;
    }
    url.hash = "";
    if (adapter !== "generic") url.search = "";
    return `${adapter}|${url.href}|${candidateAssetKey(candidate)}`;
  }

  function candidateAssetKey(candidate) {
    const value = Array.isArray(candidate?.assetUrls) ? candidate.assetUrls[0] : "";
    try {
      const url = new URL(String(value || ""));
      url.hash = "";
      return url.href;
    } catch (_error) {
      return String(value || "");
    }
  }

  function normalizeTemplateEntryUrl(value, profile) {
    let url;
    try {
      url = new URL(String(value || ""));
    } catch (_error) {
      return "";
    }
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return "";
    url.hash = "";
    if (profile?.id === "x-media") {
      url.pathname = url.pathname.replace(/\/(?:photo|video)\/\d+\/?$/iu, "");
    }
    return url.href;
  }

  function testRegex(regex, value) {
    if (!(regex instanceof RegExp)) return false;
    regex.lastIndex = 0;
    return regex.test(value);
  }

  function rectArea(rect) {
    return Math.max(0, Number(rect?.width) || 0) * Math.max(0, Number(rect?.height) || 0);
  }

  return {
    candidateKey,
    createCandidateExtractor,
    mergeCandidate,
    normalizeTemplateEntryUrl
  };
}));
