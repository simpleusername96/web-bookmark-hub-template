"use strict";

const { randomBytes } = require("node:crypto");

const {
  authenticateApiClient,
  createApiClient,
  listApiClients,
  normalizeExtensionId,
  revokeApiClient
} = require("../registry/api-clients.js");
const { RegistryError } = require("../registry/errors.js");

const SESSION_COOKIE = "wbh_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const PAIRING_TTL_MS = 5 * 60 * 1000;
const RATE_WINDOW_MS = 60 * 1000;
const MAX_PAIRING_CREATIONS = 5;
const MAX_EXCHANGE_FAILURES = 5;
const MAX_SESSIONS = 256;
const MAX_PAIRING_CODES = 64;
const MAX_RATE_KEYS = 1024;

function createAuthManager({ registry, clock = Date, randomBytesFn = randomBytes } = {}) {
  if (!registry) {
    throw new RegistryError("INTERNAL_ERROR", "Auth manager requires a Registry.");
  }
  const sessions = new Map();
  const pairingCodes = new Map();
  const creationAttempts = new Map();
  const exchangeAttempts = new Map();

  function issueSession() {
    const createdAt = nowMs(clock);
    pruneExpired(sessions, createdAt, (value) => value.expiresAt);
    const token = randomToken(randomBytesFn, 32);
    const csrfToken = randomToken(randomBytesFn, 32);
    const scopeId = randomToken(randomBytesFn, 16);
    sessions.set(token, {
      token,
      csrfToken,
      requesterScope: `web:${scopeId}`,
      createdAt,
      expiresAt: createdAt + SESSION_TTL_MS
    });
    capOldest(sessions, MAX_SESSIONS);
    return {
      csrf_token: csrfToken,
      expires_at: new Date(createdAt + SESSION_TTL_MS).toISOString(),
      set_cookie: `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict`
    };
  }

  function authenticateWeb(request, { csrf = false } = {}) {
    const token = parseCookies(headerValue(request.headers, "cookie"))[SESSION_COOKIE];
    const session = token ? sessions.get(token) : null;
    const timestamp = nowMs(clock);
    pruneExpired(sessions, timestamp, (value) => value.expiresAt);
    if (!session || session.expiresAt <= timestamp) {
      if (token) sessions.delete(token);
      throw new RegistryError("WEB_SESSION_UNAUTHORIZED", "Web session is missing or expired.");
    }
    if (csrf && !constantStringEqual(headerValue(request.headers, "x-csrf-token"), session.csrfToken)) {
      throw new RegistryError("CSRF_INVALID", "CSRF token is missing or invalid.");
    }
    return session;
  }

  function createPairingCodeForSession(session) {
    const timestamp = nowMs(clock);
    pruneExpired(pairingCodes, timestamp, (value) => value.expiresAt);
    enforceRateLimit(creationAttempts, session.token, timestamp, MAX_PAIRING_CREATIONS, "PAIRING_RATE_LIMITED");
    let code;
    do {
      code = randomBytesFn(4).toString("hex").toUpperCase();
    } while (pairingCodes.has(code));
    pairingCodes.set(code, {
      code,
      sessionToken: session.token,
      createdAt: timestamp,
      expiresAt: timestamp + PAIRING_TTL_MS,
      usedAt: null
    });
    capOldest(pairingCodes, MAX_PAIRING_CODES);
    return {
      code,
      expires_at: new Date(timestamp + PAIRING_TTL_MS).toISOString()
    };
  }

  function exchangePairingCode({ code: codeInput, extensionId: extensionIdInput, label, origin, remoteAddress }) {
    const timestamp = nowMs(clock);
    pruneExpired(pairingCodes, timestamp, (value) => value.expiresAt);
    const attemptKey = `${normalizeRemoteAddress(remoteAddress)}:${String(extensionIdInput || "").trim().toLowerCase()}`;
    enforceExistingRateLimit(exchangeAttempts, attemptKey, timestamp, MAX_EXCHANGE_FAILURES, "PAIRING_ATTEMPTS_EXCEEDED");
    let extensionId;
    try {
      extensionId = normalizeExtensionId(extensionIdInput);
    } catch (error) {
      recordFailure(exchangeAttempts, attemptKey, timestamp);
      throw error;
    }
    const expectedOrigin = `chrome-extension://${extensionId}`;
    if (origin && origin !== expectedOrigin) {
      recordFailure(exchangeAttempts, attemptKey, timestamp);
      throw new RegistryError("EXTENSION_ORIGIN_MISMATCH", "Chrome extension Origin does not match its extension ID.");
    }
    const code = String(codeInput || "").trim().toUpperCase();
    const pairing = pairingCodes.get(code);
    if (!pairing || pairing.usedAt !== null || pairing.expiresAt <= timestamp) {
      recordFailure(exchangeAttempts, attemptKey, timestamp);
      throw new RegistryError("PAIRING_CODE_INVALID", "Pairing code is invalid, expired, or already used.");
    }

    const token = randomToken(randomBytesFn, 32);
    const client = createApiClient(registry, {
      token,
      extensionId,
      label: label || "Chrome"
    }, { clock });
    pairing.usedAt = timestamp;
    exchangeAttempts.delete(attemptKey);
    return { token, client };
  }

  function authenticateBearer(request) {
    const authorization = headerValue(request.headers, "authorization");
    const match = /^Bearer ([A-Za-z0-9_-]{32,512})$/.exec(authorization);
    if (!match) {
      throw new RegistryError("API_CLIENT_UNAUTHORIZED", "Bearer token is missing or invalid.");
    }
    const client = authenticateApiClient(registry, match[1], { clock });
    const origin = headerValue(request.headers, "origin");
    if (origin && origin !== `chrome-extension://${client.extension_id}`) {
      throw new RegistryError("EXTENSION_ORIGIN_MISMATCH", "Chrome extension Origin does not match the authenticated client.");
    }
    return client;
  }

  return {
    authenticateBearer,
    authenticateWeb,
    createPairingCodeForSession,
    exchangePairingCode,
    issueSession,
    listClients: () => listApiClients(registry),
    revokeClient: (id) => revokeApiClient(registry, id, { clock })
  };
}

function validateLoopbackRequest(request, baseUrl) {
  const expected = new URL(baseUrl);
  const remoteAddress = normalizeRemoteAddress(request.remoteAddress);
  if (!isLoopbackAddress(remoteAddress)) {
    throw new RegistryError("LOOPBACK_REQUIRED", "Only loopback requests are accepted.");
  }
  if (headerValue(request.headers, "host") !== expected.host) {
    throw new RegistryError("HOST_INVALID", "Request Host is not the configured loopback service.");
  }
}

function validateWebRequestMetadata(request, baseUrl, {
  allowCrossSiteNavigation = false,
  allowSameOriginNoCors = false
} = {}) {
  const expectedOrigin = new URL(baseUrl).origin;
  const origin = headerValue(request.headers, "origin");
  if (origin && origin !== expectedOrigin) {
    throw new RegistryError("ORIGIN_INVALID", "Request Origin is not the configured web application.");
  }
  const fetchSite = headerValue(request.headers, "sec-fetch-site");
  const userNavigation = allowCrossSiteNavigation
    && fetchSite === "cross-site"
    && headerValue(request.headers, "sec-fetch-mode") === "navigate"
    && headerValue(request.headers, "sec-fetch-dest") === "document"
    && headerValue(request.headers, "sec-fetch-user") === "?1";
  if (fetchSite && !["same-origin", "same-site", "none"].includes(fetchSite) && !userNavigation) {
    throw new RegistryError("FETCH_METADATA_REJECTED", "Cross-site browser requests are not accepted.");
  }
  if (
    headerValue(request.headers, "sec-fetch-mode") === "no-cors"
    && !(allowSameOriginNoCors && fetchSite === "same-origin")
  ) {
    throw new RegistryError("FETCH_METADATA_REJECTED", "Opaque browser requests are not accepted.");
  }
}

function enforceRateLimit(store, key, timestamp, limit, code) {
  pruneRateStore(store, timestamp);
  const record = freshRateRecord(store.get(key), timestamp);
  if (record.count >= limit) {
    throw new RegistryError(code, "Too many pairing requests. Try again later.");
  }
  record.count += 1;
  store.set(key, record);
  capOldest(store, MAX_RATE_KEYS);
}

function enforceExistingRateLimit(store, key, timestamp, limit, code) {
  pruneRateStore(store, timestamp);
  const record = freshRateRecord(store.get(key), timestamp);
  if (record.count >= limit) {
    store.set(key, record);
    throw new RegistryError(code, "Too many failed pairing attempts. Try again later.");
  }
  store.set(key, record);
  capOldest(store, MAX_RATE_KEYS);
}

function recordFailure(store, key, timestamp) {
  pruneRateStore(store, timestamp);
  const record = freshRateRecord(store.get(key), timestamp);
  record.count += 1;
  store.set(key, record);
  capOldest(store, MAX_RATE_KEYS);
}

function pruneRateStore(store, timestamp) {
  pruneExpired(store, timestamp, (value) => value.startedAt + RATE_WINDOW_MS);
}

function pruneExpired(store, timestamp, expiresAt) {
  for (const [key, value] of store) {
    if (expiresAt(value) <= timestamp) store.delete(key);
  }
}

function capOldest(store, max) {
  while (store.size > max) store.delete(store.keys().next().value);
}

function freshRateRecord(record, timestamp) {
  if (!record || timestamp - record.startedAt >= RATE_WINDOW_MS) {
    return { count: 0, startedAt: timestamp };
  }
  return record;
}

function parseCookies(value) {
  const cookies = {};
  for (const part of String(value || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    cookies[part.slice(0, separator).trim()] = part.slice(separator + 1).trim();
  }
  return cookies;
}

function headerValue(headers, name) {
  if (!headers) return "";
  if (typeof headers.get === "function") return String(headers.get(name) || "");
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
  const value = key ? headers[key] : "";
  return Array.isArray(value) ? value.join(", ") : String(value || "");
}

function normalizeRemoteAddress(value) {
  const address = String(value || "").trim().toLowerCase();
  return address.startsWith("::ffff:") ? address.slice(7) : address;
}

function isLoopbackAddress(value) {
  return value === "127.0.0.1" || value === "::1";
}

function constantStringEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""), "utf8");
  const rightBuffer = Buffer.from(String(right || ""), "utf8");
  if (leftBuffer.length !== rightBuffer.length) return false;
  return require("node:crypto").timingSafeEqual(leftBuffer, rightBuffer);
}

function randomToken(randomBytesFn, size) {
  return randomBytesFn(size).toString("base64url");
}

function nowMs(clock) {
  const value = clock && typeof clock.now === "function" ? clock.now() : clock();
  const milliseconds = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(milliseconds)) {
    throw new RegistryError("INTERNAL_ERROR", "Auth clock returned an invalid time.");
  }
  return milliseconds;
}

module.exports = {
  MAX_EXCHANGE_FAILURES,
  MAX_PAIRING_CREATIONS,
  MAX_PAIRING_CODES,
  MAX_RATE_KEYS,
  MAX_SESSIONS,
  PAIRING_TTL_MS,
  RATE_WINDOW_MS,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  createAuthManager,
  headerValue,
  isLoopbackAddress,
  parseCookies,
  validateLoopbackRequest,
  validateWebRequestMetadata
};
