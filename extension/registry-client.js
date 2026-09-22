(function (root, factory) {
  "use strict";
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.WBHRegistryClient = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  const CONFIG_KEY = "webBookmarkHubRegistryConfig";
  const CANONICAL_BASE_URL = "http://127.0.0.1:3042/";
  const Transport = root.WBHTransportContract
    || (typeof require === "function" ? require("./transport-contract.js") : null);
  if (!Transport) throw new Error("Registry transport contract is required.");

  function createRegistryClient(options) {
    const settings = options || {};
    const chromeApi = settings.chromeApi || chrome;
    const fetchImpl = settings.fetchImpl || fetch;

    async function getConfig() {
      const stored = await chromeApi.storage.local.get(CONFIG_KEY);
      const config = stored?.[CONFIG_KEY];
      if (!config || typeof config !== "object") return null;
      const storedBaseUrl = normalizeLoopbackBaseUrl(config.baseUrl);
      const baseUrl = CANONICAL_BASE_URL;
      const normalized = {
        baseUrl,
        token: typeof config.token === "string" ? config.token : "",
        client: config.client || null
      };
      if (baseUrl !== storedBaseUrl) {
        await chromeApi.storage.local.set({ [CONFIG_KEY]: normalized });
      }
      return normalized;
    }

    async function pair(input) {
      const baseUrl = normalizeBaseUrl(input?.baseUrl);
      const code = String(input?.code || "").trim();
      if (!code) throw clientError("PAIRING_CODE_REQUIRED", "Enter the one-time pairing code.");
      const extensionId = chromeApi.runtime.id;
      const response = await fetchJson(fetchImpl, new URL("api/v1/pairing-exchanges", baseUrl).href, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: Transport.serializeJsonBody({ code, extension_id: extensionId, label: input?.label || "Chrome" })
      });
      const config = { baseUrl, token: response.token, client: response.client };
      await chromeApi.storage.local.set({ [CONFIG_KEY]: config });
      return redactedConnection(config);
    }

    async function capture(payload, idempotencyKey) {
      const config = await requireConfig();
      return fetchJson(fetchImpl, new URL("api/v1/captures", config.baseUrl).href, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${config.token}`,
          "content-type": "application/json",
          "idempotency-key": idempotencyKey
        },
        body: Transport.serializeJsonBody(payload)
      });
    }

    async function capturePresence(items) {
      const config = await requireConfig();
      return fetchJson(fetchImpl, new URL("api/v1/captures/presence", config.baseUrl).href, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${config.token}`,
          "content-type": "application/json"
        },
        body: Transport.serializeJsonBody({ items })
      });
    }

    async function enrichShortcut(entryId, payload) {
      const config = await requireConfig();
      return fetchJson(fetchImpl, new URL(`api/v1/captures/${Number(entryId)}/shortcut-evidence`, config.baseUrl).href, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${config.token}`,
          "content-type": "application/json"
        },
        body: Transport.serializeJsonBody(payload, Transport.MAX_SHORTCUT_EVIDENCE_BODY_BYTES)
      });
    }

    async function listFolders() {
      const config = await requireConfig();
      return fetchJson(fetchImpl, new URL("api/v1/folders/tree", config.baseUrl).href, {
        headers: { accept: "application/json", authorization: `Bearer ${config.token}` }
      });
    }

    async function suggestTags(options) {
      const config = await requireConfig();
      const url = new URL("api/v1/tags/suggestions", config.baseUrl);
      url.searchParams.set("q", String(options?.query || ""));
      (Array.isArray(options?.exclude) ? options.exclude : []).forEach(function appendExcluded(tag) {
        url.searchParams.append("exclude", tag);
      });
      url.searchParams.set("limit", String(options?.limit || 8));
      return fetchJson(fetchImpl, url.href, {
        headers: { accept: "application/json", authorization: `Bearer ${config.token}` }
      });
    }

    async function connection() {
      const config = await getConfig();
      if (!config?.token) return disconnected("authorization_required");
      try {
        const liveClient = await fetchJson(fetchImpl, new URL("api/v1/client", config.baseUrl).href, {
          headers: { accept: "application/json", authorization: `Bearer ${config.token}` }
        });
        const verified = { ...config, client: liveClient };
        await chromeApi.storage.local.set({ [CONFIG_KEY]: verified });
        return redactedConnection(verified);
      } catch (error) {
        if (["API_CLIENT_UNAUTHORIZED", "EXTENSION_ORIGIN_MISMATCH"].includes(error?.code)) {
          await chromeApi.storage.local.remove(CONFIG_KEY);
          return disconnected("authorization_required");
        }
        if (error?.code === "REGISTRY_UNAVAILABLE") return disconnected("unavailable");
        throw error;
      }
    }

    async function requireConfig() {
      const config = await getConfig();
      if (!config?.token) throw clientError("REGISTRY_NOT_PAIRED", "Pair this extension with Web Bookmark Hub first.");
      return config;
    }

    return { capture, capturePresence, connection, enrichShortcut, getConfig, listFolders, pair, suggestTags };
  }

  async function fetchJson(fetchImpl, url, init) {
    let response;
    try {
      response = await fetchImpl(url, init);
    } catch (_error) {
      throw clientError("REGISTRY_UNAVAILABLE", "Web Bookmark Hub 서버에 연결할 수 없습니다. Fastrun Manager에서 web-bookmark-hub를 실행한 뒤 다시 시도하세요.");
    }
    let payload;
    try {
      payload = await response.json();
    } catch (_error) {
      throw clientError("REGISTRY_RESPONSE_INVALID", "The local Registry returned an invalid response.");
    }
    if (!response.ok || !payload?.ok) {
      throw clientError(payload?.error?.code || "REGISTRY_REQUEST_FAILED", payload?.error?.message || "The Registry request failed.");
    }
    return payload.data;
  }

  function normalizeBaseUrl(value) {
    const baseUrl = normalizeLoopbackBaseUrl(value);
    if (baseUrl !== CANONICAL_BASE_URL) {
      throw clientError("REGISTRY_URL_INVALID", `Registry address must be ${CANONICAL_BASE_URL}.`);
    }
    return baseUrl;
  }

  function normalizeLoopbackBaseUrl(value) {
    let url;
    try {
      url = new URL(String(value || "").trim());
    } catch (_error) {
      throw clientError("REGISTRY_URL_INVALID", "Use the explicit loopback Registry address.");
    }
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password) {
      throw clientError("REGISTRY_URL_INVALID", "Registry address must be http://127.0.0.1:<port>/.");
    }
    return `${url.origin}/`;
  }

  function entryDetailUrl(entryId, baseUrl) {
    const id = Number(entryId);
    if (!Number.isSafeInteger(id) || id < 1) throw clientError("ENTRY_ID_INVALID", "Entry ID must be a positive integer.");
    const url = new URL(normalizeBaseUrl(baseUrl || CANONICAL_BASE_URL));
    url.searchParams.set("entry", String(id));
    return url.href;
  }

  function redactedConnection(config) {
    return { connected: true, state: "connected", baseUrl: config.baseUrl, client: config.client || null };
  }

  function disconnected(state) {
    return { connected: false, state, baseUrl: CANONICAL_BASE_URL, client: null };
  }

  function clientError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  return { CANONICAL_BASE_URL, CONFIG_KEY, createRegistryClient, entryDetailUrl, normalizeBaseUrl };
}));
