(function (root, factory) {
  "use strict";
  const createApiSource = factory(root);
  if (typeof module === "object" && module.exports) module.exports = createApiSource;
  root.createApiSource = createApiSource;
  root.WBH_CREATE_SOURCE = function createProductionSource() { return createApiSource(); };
}(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  class ApiError extends Error {
    constructor(code, message, status, details) {
      super(message);
      this.name = "ApiError";
      this.code = code;
      this.status = status;
      if (details !== undefined) this.details = details;
    }
  }

  function createApiSource(options) {
    const settings = options || {};
    const fetchImpl = settings.fetch || root.fetch?.bind(root);
    if (typeof fetchImpl !== "function") throw new Error("The Registry API requires fetch support.");
    const baseUrl = normalizeBaseUrl(settings.baseUrl || root.location?.origin || "http://127.0.0.1");
    const uuid = typeof settings.randomUUID === "function"
      ? settings.randomUUID
      : function browserUuid() { return root.crypto.randomUUID(); };
    let sessionPromise = null;
    let servicePromise = null;

    function serviceInfo() {
      if (!servicePromise) {
        servicePromise = rawRequest("/api/v1/health", { method: "GET" }, { skipSession: true })
          .catch(function resetOnFailure(error) {
            servicePromise = null;
            throw error;
          });
      }
      return servicePromise;
    }

    function session() {
      if (!sessionPromise) {
        sessionPromise = rawRequest("/api/v1/session", { method: "GET" }, { skipSession: true })
          .catch(function resetOnFailure(error) {
            sessionPromise = null;
            throw error;
          });
      }
      return sessionPromise;
    }

    async function rawRequest(pathname, init, behavior) {
      const requestInit = Object.assign({
        method: "GET",
        credentials: "same-origin",
        headers: { accept: "application/json" }
      }, init || {});
      requestInit.headers = Object.assign({ accept: "application/json" }, init?.headers || {});
      if (!behavior?.skipSession) await session();
      const response = await fetchImpl(new URL(pathname, baseUrl).href, requestInit);
      let payload;
      try {
        payload = await response.json();
      } catch (_error) {
        throw new ApiError("API_RESPONSE_INVALID", "The Registry returned an invalid response.", response.status);
      }
      if (!response.ok || !payload?.ok) {
        const error = new ApiError(
          payload?.error?.code || "API_REQUEST_FAILED",
          payload?.error?.message || "The Registry request failed.",
          response.status,
          payload?.error?.details
        );
        if (error.code === "WEB_SESSION_UNAUTHORIZED" && !behavior?.skipSession && !behavior?.retriedSession) {
          sessionPromise = null;
          servicePromise = null;
          const renewedSession = await session();
          const retryInit = Object.assign({}, init || {});
          retryInit.headers = Object.assign({}, init?.headers || {});
          if (Object.keys(retryInit.headers).some((name) => name.toLowerCase() === "x-csrf-token")) {
            const csrfHeader = Object.keys(retryInit.headers).find((name) => name.toLowerCase() === "x-csrf-token");
            retryInit.headers[csrfHeader] = renewedSession.csrf_token;
          }
          return rawRequest(pathname, retryInit, { retriedSession: true });
        }
        throw error;
      }
      return payload.data;
    }

    async function request(pathname, init) {
      return rawRequest(pathname, init);
    }

    async function initialize() {
      const [service, activeSession] = await Promise.all([serviceInfo(), session()]);
      return { service, session: activeSession };
    }

    async function requireCapability(name) {
      const service = await serviceInfo();
      if (service?.capabilities?.[name] === true) return service;
      throw new ApiError(
        "SERVER_RESTART_REQUIRED",
        "The Registry server must be restarted before permanent Delete is available.",
        409,
        { capability: name, service }
      );
    }

    async function requireRuleSaveMethod(rule) {
      if (!Object.prototype.hasOwnProperty.call(rule || {}, "capture_mode")) return;
      const service = await serviceInfo();
      if (Number(service?.schema_version) >= 14) return;
      servicePromise = null;
      throw new ApiError("SERVER_RESTART_REQUIRED", "Restart Web Bookmark Hub before saving rules with a save method.", 409);
    }

    async function mutate(pathname, body, options) {
      const activeSession = await session();
      const idempotencyKey = options?.idempotencyKey || uuid();
      return rawRequest(pathname, {
        method: options?.method || "POST",
        signal: options?.signal,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
          "x-csrf-token": activeSession.csrf_token
        },
        body: JSON.stringify(body || {})
      });
    }

    return {
      baseUrl,
      initialize,
      getServiceInfo: serviceInfo,
      listEntries: function listEntries(query) {
        const params = entryQuery(query || {});
        return request(`/api/v1/entries?${params.toString()}`, { signal: query?.signal });
      },
      getEntry: async function getEntry(id, options) {
        try {
          const suffix = options?.includeArchived ? "?include_archived=1" : "";
          return await request(`/api/v1/entries/${numericId(id, "entry id")}${suffix}`, { signal: options?.signal });
        } catch (error) {
          if (error instanceof ApiError && error.status === 404) return null;
          throw error;
        }
      },
      topTags: function topTags(options) {
        const params = new URLSearchParams();
        if (options?.limit !== undefined) params.set("limit", String(options.limit));
        return request(`/api/v1/insights/tags?${params.toString()}`, { signal: options?.signal });
      },
      selectionSnapshot: function selectionSnapshot(query) {
        const params = entryQuery(query || {});
        return request(`/api/v1/entries/selection-snapshot?${params.toString()}`, { signal: query?.signal });
      },
      suggestTags: function suggestTags(options) {
        const params = new URLSearchParams();
        params.set("q", String(options?.query || ""));
        (Array.isArray(options?.exclude) ? options.exclude : []).forEach(function appendExcluded(tag) {
          params.append("exclude", tag);
        });
        params.set("limit", String(options?.limit || 8));
        return request(`/api/v1/tags/suggestions?${params.toString()}`, { signal: options?.signal });
      },
      listFolders: function listFolders(options) {
        const params = entryQuery(options?.query || {});
        const suffix = params.size ? `?${params.toString()}` : "";
        return request(`/api/v1/folders/tree${suffix}`, { signal: options?.signal });
      },
      getFolder: function getFolder(id, options) {
        return request(`/api/v1/folders/${numericId(id, "folder id")}`, { signal: options?.signal });
      },
      createFolder: function createFolder(input, options) {
        return mutate("/api/v1/folders", compact({
          name: input?.name,
          parent_id: ownValue(input, "parent_id")
        }, { keepNull: true }), options);
      },
      updateFolder: function updateFolder(id, input, options) {
        return mutate(`/api/v1/folders/${numericId(id, "folder id")}`, compact({
          name: ownValue(input, "name"),
          parent_id: ownValue(input, "parent_id")
        }, { keepNull: true }), { ...options, method: "PATCH" });
      },
      deleteFolder: function deleteFolder(id, options) {
        return mutate(`/api/v1/folders/${numericId(id, "folder id")}`, {}, { ...options, method: "DELETE" });
      },
      listUrlGroups: function listUrlGroups(options) {
        const params = entryQuery(options?.query || {});
        const suffix = params.size ? `?${params.toString()}` : "";
        return request(`/api/v1/url-groups${suffix}`, { signal: options?.signal });
      },
      addEntry: function addEntry(draft, options) {
        const body = compact({
          url: draft?.url,
          title: draft?.title,
          kind: draft?.kind,
          published_at: draft?.publishedAt || draft?.published_at,
          folder_id: draft?.folderId || draft?.folder_id,
          content_focus: draft?.contentFocus || draft?.content_focus,
          tags: draft?.tags,
          comment: draft?.comment,
          visibility: draft?.visibility
        });
        return mutate("/api/v1/entries", body, options);
      },
      editEntry: function editEntry(id, changes, options) {
        return mutate(`/api/v1/entries/${numericId(id, "entry id")}`, compact({
          url: ownValue(changes, "url"),
          title: ownValue(changes, "title"),
          kind: ownValue(changes, "kind"),
          typed_metadata: ownValue(changes, "typed_metadata"),
          published_at: ownValue(changes, "published_at"),
          updated_at: ownValue(changes, "updated_at"),
          folder_id: ownValue(changes, "folder_id"),
          content_focus: ownValue(changes, "content_focus"),
          tags: ownValue(changes, "tags"),
          visibility: ownValue(changes, "visibility"),
          reason: ownValue(changes, "reason")
        }, { keepNull: true }), { ...options, method: "PATCH" });
      },
      deleteEntry: async function deleteEntry(id, options) {
        await requireCapability("permanent_delete");
        return mutate(`/api/v1/entries/${numericId(id, "entry id")}`, {}, {
          ...options,
          method: "DELETE"
        });
      },
      batchEntries: async function batchEntries(input, options) {
        if (input?.operation === "delete") await requireCapability("permanent_delete");
        return mutate("/api/v1/entries/batch", input, options);
      },
      listEntryRevisions: function listEntryRevisions(id, options) {
        return request(`/api/v1/entries/${numericId(id, "entry id")}/revisions`, { signal: options?.signal });
      },
      listVisualAssets: function listVisualAssets(id, options) {
        return request(`/api/v1/entries/${numericId(id, "entry id")}/visual-assets`, { signal: options?.signal });
      },
      setCover: function setCover(assetId, options) {
        return mutate(`/api/v1/visual-assets/${numericId(assetId, "visual asset id")}/set-cover`, {}, options);
      },
      clearCover: function clearCover(entryId, options) {
        return mutate(`/api/v1/entries/${numericId(entryId, "entry id")}/clear-cover`, {}, options);
      },
      removeVisualAsset: function removeVisualAsset(assetId, options) {
        return mutate(`/api/v1/visual-assets/${numericId(assetId, "visual asset id")}`, {}, {
          ...options,
          method: "DELETE"
        });
      },
      getCapturePolicy: function getCapturePolicy(options) {
        return request("/api/v1/capture-policy", { signal: options?.signal });
      },
      updateCapturePolicy: function updateCapturePolicy(policy, options) {
        return mutate("/api/v1/capture-policy", compact({
          visibility: policy?.visibility,
          selected_image_storage: policy?.selected_image_storage
        }), { ...options, method: "PATCH" });
      },
      listCapturePolicyRules: function listCapturePolicyRules(options) {
        return request("/api/v1/capture-policy/rules", { signal: options?.signal });
      },
      createCapturePolicyRule: async function createCapturePolicyRule(rule, options) {
        await requireRuleSaveMethod(rule);
        return mutate("/api/v1/capture-policy/rules", humanCaptureRule(rule), options);
      },
      updateCapturePolicyRule: async function updateCapturePolicyRule(id, rule, options) {
        await requireRuleSaveMethod(rule);
        return mutate(`/api/v1/capture-policy/rules/${numericId(id, "rule id")}`, humanCaptureRule(rule), {
          ...options,
          method: "PATCH"
        });
      },
      deleteCapturePolicyRule: function deleteCapturePolicyRule(id, options) {
        return mutate(`/api/v1/capture-policy/rules/${numericId(id, "rule id")}`, {}, {
          ...options,
          method: "DELETE"
        });
      },
      previewCapturePolicyRule: function previewCapturePolicyRule(id, options) {
        return request(`/api/v1/capture-policy/rules/${numericId(id, "rule id")}/preview`, {
          signal: options?.signal
        });
      },
      applyCapturePolicyRule: function applyCapturePolicyRule(id, reason, options) {
        return mutate(`/api/v1/capture-policy/rules/${numericId(id, "rule id")}/apply`, compact({ reason }), options);
      },
      listComments: function listComments(entryId, options) {
        const params = new URLSearchParams();
        if (options?.page !== undefined) params.set("page", String(options.page));
        if (options?.page_size !== undefined) params.set("page_size", String(options.page_size));
        return request(`/api/v1/entries/${numericId(entryId, "entry id")}/comments?${params.toString()}`, {
          signal: options?.signal
        });
      },
      addComment: function addComment(entryId, text, options) {
        return mutate(`/api/v1/entries/${numericId(entryId, "entry id")}/comments`, { text }, options);
      },
      createPairingCode: function createPairingCode(options) {
        return mutate("/api/v1/pairing-codes", {}, options);
      },
      listClients: function listClients(options) {
        return request("/api/v1/clients", { signal: options?.signal });
      },
      revokeClient: function revokeClient(clientId, options) {
        return mutate(`/api/v1/clients/${numericId(clientId, "client id")}/revoke`, {}, options);
      },
      getAiUrlSummary: function getAiUrlSummary(options) {
        return request("/api/v1/ai-url-summary", { signal: options?.signal });
      },
      startAiUrlSummary: function startAiUrlSummary(scope, options) {
        return mutate("/api/v1/ai-url-summary", scope, options);
      }
    };
  }

  function entryQuery(query) {
    const params = new URLSearchParams();
    setIfPresent(params, "search", query.search);
    setIfPresent(params, "sort", query.sort);
    setIfPresent(params, "page", query.page);
    setIfPresent(params, "page_size", query.page_size);
    setIfPresent(params, "kind", query.kind);
    setIfPresent(params, "provider", query.provider);
    setIfPresent(params, "source_domain", query.source_domain);
    setIfPresent(params, "visibility", query.visibility);
    setIfPresent(params, "agent_access", query.agent_access);
    setIfPresent(params, "content_focus", query.content_focus);
    setIfPresent(params, "preview", query.preview);
    setIfPresent(params, "folder_id", query.folder_id);
    setIfPresent(params, "include_descendants", query.include_descendants);
    setIfPresent(params, "tag", query.tag);
    setIfPresent(params, "url_group_id", query.url_group_id);
    setIfPresent(params, "saved_from", query.saved_from);
    setIfPresent(params, "saved_to", query.saved_to);
    return params;
  }

  function setIfPresent(params, key, value) {
    if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
  }

  function compact(value, options) {
    return Object.fromEntries(Object.entries(value).filter(function present(pair) {
      return pair[1] !== undefined && (options?.keepNull || pair[1] !== null) && pair[1] !== "";
    }));
  }

  function ownValue(value, key) {
    return value && Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
  }

  function humanCaptureRule(rule) {
    return compact({
      url_prefix: rule?.url_prefix,
      hostname: rule?.hostname,
      path_prefix: rule?.path_prefix,
      capture_mode: rule?.capture_mode,
      kind: ownValue(rule, "kind"),
      tags: rule?.tags,
      visibility: rule?.visibility,
      enabled: rule?.enabled,
      position: rule?.position
    }, { keepNull: true });
  }

  function numericId(value, label) {
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id < 1) throw new TypeError(`${label} must be a positive integer.`);
    return id;
  }

  function normalizeBaseUrl(value) {
    const url = new URL(value);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname)) {
      throw new TypeError("Registry base URL must be loopback HTTP.");
    }
    return `${url.origin}/`;
  }

  createApiSource.ApiError = ApiError;
  createApiSource.entryQuery = entryQuery;
  return createApiSource;
}));
