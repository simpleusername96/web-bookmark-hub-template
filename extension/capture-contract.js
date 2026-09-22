(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.WBHCaptureContract = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const MAX_ITEMS = 100;
  const MAX_ASSETS = 100;
  const MAX_COMMENT = 20000;
  const MAX_TAGS = 50;
  const MAX_SHORTCUT_SCREENSHOT_BYTES = 3 * 1024 * 1024;

  function buildCurrentTabCapture(tab, metadata) {
    if (!tab || !Number.isSafeInteger(Number(tab.id))) throw contractError("TAB_INVALID", "The active tab is unavailable.");
    const entryUrl = httpUrl(tab.url, "TAB_URL_INVALID");
    const input = normalizeUserMetadata(metadata);
    return {
      adapter: "current-tab",
      items: [{
        entryUrl,
        selectedAt: new Date().toISOString(),
        assetUrls: [],
        comment: input.comment,
        tags: input.tags,
        folderId: input.folderId,
        ...policyFields(input)
      }]
    };
  }

  function buildCapturePresence(candidates, options) {
    if (!Array.isArray(candidates) || candidates.length < 1 || candidates.length > MAX_ITEMS) {
      throw contractError("PRESENCE_LIMIT_INVALID", `Check between 1 and ${MAX_ITEMS} images.`);
    }
    const settings = options || {};
    const pageUrl = httpUrl(settings.pageUrl, "PAGE_URL_INVALID");
    const profiles = Array.isArray(settings.profiles) ? settings.profiles : [];
    return candidates.map(function normalizePresenceCandidate(candidate) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        throw contractError("CAPTURE_ITEM_INVALID", "Image candidate is invalid.");
      }
      const entryUrl = httpUrl(candidate.entryUrl, "ENTRY_URL_INVALID");
      const adapter = optionalString(candidate.adapter, 120) || "generic";
      if (adapter !== "generic") {
        const profile = profiles.find(function matchProfile(item) { return item && item.id === adapter; });
        if (!profile || !isProfileRelated(pageUrl, entryUrl, profile)) {
          throw contractError("TEMPLATE_RELATIONSHIP_INVALID", "Template item is outside the active profile.");
        }
      }
      if (!Array.isArray(candidate.assetUrls) || candidate.assetUrls.length < 1) {
        throw contractError("ASSET_LIMIT_INVALID", "Image candidate must contain an image reference.");
      }
      const presenceAssetUrls = Array.isArray(candidate.presenceAssetUrls) && candidate.presenceAssetUrls.length
        ? candidate.presenceAssetUrls
        : candidate.assetUrls.slice(0, 1);
      if (presenceAssetUrls.length > 4) {
        throw contractError("ASSET_LIMIT_INVALID", "Image candidate contains too many presence references.");
      }
      return {
        entryUrl,
        assetUrls: [...new Set(presenceAssetUrls.map(function normalizePresenceAsset(value) {
          return httpUrl(value, "ASSET_URL_INVALID");
        }))]
      };
    });
  }

  function genericImageCandidate(input) {
    if (!input || input.visible === false || Number(input.intersectionRatio) <= 0) return null;
    if (Number(input.width) < 96 || Number(input.height) < 96) return null;
    let assetUrl;
    try {
      assetUrl = httpUrl(input.currentSrc || input.src, "ASSET_URL_INVALID");
    } catch (_error) {
      return null;
    }
    let entryUrl;
    try {
      entryUrl = httpUrl(input.anchorHref, "ENTRY_URL_INVALID");
    } catch (_error) {
      try {
        entryUrl = httpUrl(input.pageUrl, "ENTRY_URL_INVALID");
      } catch (_nested) {
        return null;
      }
    }
    return {
      entryUrl,
      publishedAt: optionalTimestamp(input.publishedAt),
      assetUrls: [assetUrl],
      adapter: "generic"
    };
  }

  function normalizeSelectedCapture(candidates, options) {
    if (!Array.isArray(candidates) || candidates.length < 1 || candidates.length > MAX_ITEMS) {
      throw contractError("ITEM_LIMIT_INVALID", `Select between 1 and ${MAX_ITEMS} items.`);
    }
    const settings = options || {};
    const pageUrl = httpUrl(settings.pageUrl, "PAGE_URL_INVALID");
    const profiles = Array.isArray(settings.profiles) ? settings.profiles : [];
    const user = normalizeUserMetadata(settings.userMetadata);
    const selectedAt = optionalTimestamp(settings.selectedAt) || new Date().toISOString();
    const grouped = new Map();
    const adapters = new Set();

    candidates.forEach(function normalizeCandidate(candidate) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        throw contractError("CAPTURE_ITEM_INVALID", "Selected item is invalid.");
      }
      const entryUrl = httpUrl(candidate.entryUrl, "ENTRY_URL_INVALID");
      const adapter = optionalString(candidate.adapter, 120) || "generic";
      if (adapter !== "generic") {
        const profile = profiles.find(function matchProfile(item) { return item && item.id === adapter; });
        if (!profile || !isProfileRelated(pageUrl, entryUrl, profile)) {
          throw contractError("TEMPLATE_RELATIONSHIP_INVALID", "Template item is outside the active profile.");
        }
      }
      adapters.add(adapter);
      if (!Array.isArray(candidate.assetUrls) || candidate.assetUrls.length < 1 || candidate.assetUrls.length > MAX_ASSETS) {
        throw contractError("ASSET_LIMIT_INVALID", `Selected item must contain 1-${MAX_ASSETS} image references.`);
      }
      const assets = candidate.assetUrls.map(function normalizeAsset(value) {
        return httpUrl(value, "ASSET_URL_INVALID");
      });
      let item = grouped.get(entryUrl);
      if (!item) {
        item = {
          entryUrl,
          publishedAt: optionalTimestamp(candidate.publishedAt),
          selectedAt,
          assetUrls: [],
          comment: user.comment,
          tags: user.tags,
          folderId: user.folderId,
          ...policyFields(user)
        };
        grouped.set(entryUrl, item);
      }
      assets.forEach(function appendAsset(asset) {
        if (!item.assetUrls.includes(asset)) item.assetUrls.push(asset);
      });
      if (item.assetUrls.length > MAX_ASSETS) throw contractError("ASSET_LIMIT_INVALID", `Selected item exceeds ${MAX_ASSETS} images.`);
    });

    return {
      adapter: adapters.size === 1 ? [...adapters][0] : "generic",
      items: [...grouped.values()]
    };
  }

  function normalizeUserMetadata(value) {
    const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const tags = input.tags === undefined ? [] : input.tags;
    if (!Array.isArray(tags) || tags.length > MAX_TAGS) throw contractError("TAGS_INVALID", "Tags are invalid.");
    const normalizedTags = tags.map(function normalizeTag(tag) {
      const value = optionalString(tag, 80);
      if (!value) throw contractError("TAGS_INVALID", "Tags are invalid.");
      return value.replace(/\s+/gu, " ");
    });
    const folderId = input.folderId === undefined || input.folderId === null || input.folderId === ""
      ? undefined
      : Number(input.folderId);
    if (folderId !== undefined && (!Number.isSafeInteger(folderId) || folderId < 1)) {
      throw contractError("FOLDER_INVALID", "Folder is invalid.");
    }
    const visibility = optionalChoice(input.visibility, ["normal", "private"], "VISIBILITY_INVALID");
    return {
      comment: optionalString(input.comment, MAX_COMMENT),
      tags: [...new Set(normalizedTags)],
      folderId,
      visibility
    };
  }

  function isProfileRelated(pageUrlValue, entryUrlValue, profile) {
    let page;
    let entry;
    try {
      page = new URL(pageUrlValue);
      entry = new URL(entryUrlValue);
    } catch (_error) {
      return false;
    }
    const suffixes = Array.isArray(profile?.hostSuffixes) ? profile.hostSuffixes : [];
    const hostMatches = function hostMatches(hostname) {
      return suffixes.some(function matchSuffix(suffix) {
        const normalized = String(suffix).toLowerCase();
        return hostname === normalized || hostname.endsWith(`.${normalized}`);
      });
    };
    if (!hostMatches(page.hostname.toLowerCase()) || !hostMatches(entry.hostname.toLowerCase())) return false;
    if (profile.detailPathRegex instanceof RegExp && !profile.detailPathRegex.test(entry.pathname)) return false;
    return true;
  }

  function captureFullySucceeded(result) {
    return summarizeCaptureResult(result).completed;
  }

  function summarizeCaptureResult(result) {
    const items = Array.isArray(result?.items) ? result.items : [];
    const saved = items.filter(function savedEntry(item) {
      return Number.isSafeInteger(Number(item?.entry_id))
        && /^(?:created|already_saved)(?:_with_asset_skips)?$/.test(String(item?.outcome_code || ""));
    });
    const assets = saved.flatMap(function itemAssets(item) {
      return Array.isArray(item.assets) ? item.assets : [];
    });
    const failedAssets = assets.filter(function failedAsset(asset) {
      return !["attached", "duplicate", "downloaded", "local_duplicate"].includes(asset?.outcome_code);
    });
    const localCopyFailures = failedAssets.filter(function localFailure(asset) {
      return asset?.visual_asset_id !== undefined
        || asset?.local_visual_asset_id !== undefined
        || /^CAPTURE_IMAGE_/.test(String(asset?.outcome_code || ""));
    });
    const created = saved.filter(function createdEntry(item) { return String(item.outcome_code).startsWith("created"); });
    const existing = saved.filter(function existingEntry(item) { return String(item.outcome_code).startsWith("already_saved"); });
    const itemFailures = items.length - saved.length;
    return {
      completed: items.length > 0 && itemFailures === 0 && failedAssets.length === 0,
      replayed: Boolean(result?.replayed),
      entriesSaved: saved.length,
      entriesCreated: created.length,
      entriesAlreadySaved: existing.length,
      entryIds: saved.map(function entryId(item) { return Number(item.entry_id); }),
      itemsFailed: itemFailures,
      assetsFailed: failedAssets.length,
      localCopiesFailed: localCopyFailures.length,
      referencesFailed: failedAssets.length - localCopyFailures.length,
      remoteReferencesAdded: Number(result?.counts?.remote_references_added) || 0,
      localImagesAdded: Number(result?.counts?.local_images_added) || 0,
      localImagesReused: Number(result?.counts?.local_images_reused) || 0
    };
  }

  function shortcutEnrichmentDecision(result) {
    const item = Array.isArray(result?.items) ? result.items[0] : null;
    const enrichment = item?.enrichment;
    return {
      collect: Boolean(item?.entry_id && enrichment?.allowed && enrichment?.needs_summary),
      allowed: enrichment?.allowed === true,
      needsSummary: enrichment?.needs_summary === true,
      reason: typeof enrichment?.reason === "string" ? enrichment.reason : null
    };
  }

  function boundedShortcutScreenshotDataUrl(value) {
    if (typeof value !== "string") return null;
    const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
    if (!match) return null;
    const padding = match[1].endsWith("==") ? 2 : match[1].endsWith("=") ? 1 : 0;
    const decodedBytes = Math.floor(match[1].length * 3 / 4) - padding;
    return decodedBytes > 0 && decodedBytes <= MAX_SHORTCUT_SCREENSHOT_BYTES ? value : null;
  }

  function httpUrl(value, code) {
    let url;
    try {
      url = new URL(String(value || "").trim());
    } catch (_error) {
      throw contractError(code, "A complete HTTP(S) URL is required.");
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      throw contractError(code, "A credential-free HTTP(S) URL is required.");
    }
    return url.href;
  }

  function optionalString(value, maxLength) {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string") throw contractError("TEXT_INVALID", "Capture text is invalid.");
    const text = value.trim();
    if (!text) return undefined;
    if (text.length > maxLength) throw contractError("TEXT_TOO_LONG", "Capture text is too long.");
    return text;
  }

  function optionalTimestamp(value) {
    if (value === undefined || value === null || value === "") return undefined;
    const date = new Date(String(value));
    if (!Number.isFinite(date.getTime())) throw contractError("TIMESTAMP_INVALID", "Capture timestamp is invalid.");
    return date.toISOString();
  }

  function optionalChoice(value, allowed, code) {
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value !== "string" || !allowed.includes(value)) {
      throw contractError(code, "Capture policy is invalid.");
    }
    return value;
  }

  function policyFields(value) {
    const fields = {};
    if (value.visibility !== undefined) fields.visibility = value.visibility;
    return fields;
  }

  function contractError(code, message) {
    const error = new TypeError(message);
    error.code = code;
    return error;
  }

  return {
    MAX_ASSETS,
    MAX_ITEMS,
    MAX_SHORTCUT_SCREENSHOT_BYTES,
    boundedShortcutScreenshotDataUrl,
    buildCapturePresence,
    buildCurrentTabCapture,
    captureFullySucceeded,
    genericImageCandidate,
    httpUrl,
    isProfileRelated,
    normalizeSelectedCapture,
    normalizeUserMetadata,
    shortcutEnrichmentDecision,
    summarizeCaptureResult
  };
}));
