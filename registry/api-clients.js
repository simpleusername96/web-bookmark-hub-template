"use strict";

const { createHash } = require("node:crypto");

const { RegistryError } = require("./errors.js");
const { nowIso, optionalText, positiveInteger, requireText } = require("./values.js");

const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;
const CLIENT_TOUCH_INTERVAL_MS = 5 * 60 * 1000;

function createApiClient(registry, input, { clock = Date } = {}) {
  const tokenSha256 = tokenDigest(input?.token);
  const extensionId = normalizeExtensionId(input?.extensionId);
  const label = requireText(input?.label ?? "Chrome", "label", { maxLength: 120 });
  const createdAt = nowIso(clock);
  let result;
  try {
    result = registry.db.prepare(`
      INSERT INTO api_clients (
        token_sha256, extension_id, label, created_at, last_used_at, revoked_at
      ) VALUES (?, ?, ?, ?, NULL, NULL)
    `).run(tokenSha256, extensionId, label, createdAt);
  } catch (error) {
    if (String(error?.message || "").includes("api_clients.token_sha256")) {
      throw new RegistryError("API_CLIENT_TOKEN_CONFLICT", "API client token already exists.");
    }
    throw error;
  }
  return getApiClient(registry, Number(result.lastInsertRowid));
}

function getApiClient(registry, clientIdValue) {
  const clientId = positiveInteger(clientIdValue, "client_id");
  const row = registry.db.prepare("SELECT * FROM api_clients WHERE id = ?").get(clientId);
  if (!row) {
    throw new RegistryError("API_CLIENT_NOT_FOUND", "API client not found.", { clientId });
  }
  return mapApiClient(row);
}

function listApiClients(registry) {
  return registry.db.prepare(`
    SELECT * FROM api_clients
    ORDER BY revoked_at IS NOT NULL ASC, created_at DESC, id DESC
  `).all().map(mapApiClient);
}

function authenticateApiClient(registry, token, { clock = Date, touch = true } = {}) {
  const digest = tokenDigest(token);
  let matched = registry.db.prepare(`
    SELECT * FROM api_clients
    WHERE token_sha256 = ? AND revoked_at IS NULL
  `).get(digest);
  if (!matched) {
    throw new RegistryError("API_CLIENT_UNAUTHORIZED", "API client token is invalid or revoked.");
  }
  if (touch) {
    const timestamp = nowIso(clock);
    const cutoff = new Date(new Date(timestamp).getTime() - CLIENT_TOUCH_INTERVAL_MS).toISOString();
    const result = registry.db.prepare(`
      UPDATE api_clients SET last_used_at = ?
      WHERE id = ? AND (last_used_at IS NULL OR last_used_at <= ?)
    `).run(timestamp, matched.id, cutoff);
    if (Number(result.changes) > 0) matched = { ...matched, last_used_at: timestamp };
  }
  return mapApiClient(matched);
}

function revokeApiClient(registry, clientIdValue, { clock = Date } = {}) {
  const current = getApiClient(registry, clientIdValue);
  if (current.revoked_at !== null) return current;
  registry.db.prepare("UPDATE api_clients SET revoked_at = ? WHERE id = ?")
    .run(nowIso(clock), current.id);
  return getApiClient(registry, current.id);
}

function tokenDigest(value) {
  const token = optionalText(value, "token", { maxLength: 512 });
  if (!token || token.length < 32) {
    throw new RegistryError("API_CLIENT_TOKEN_INVALID", "API client token is invalid.");
  }
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function normalizeExtensionId(value) {
  const extensionId = String(value || "").trim().toLocaleLowerCase("en-US");
  if (!EXTENSION_ID_PATTERN.test(extensionId)) {
    throw new RegistryError("EXTENSION_ID_INVALID", "Chrome extension ID is invalid.");
  }
  return extensionId;
}

function mapApiClient(row) {
  return {
    id: Number(row.id),
    extension_id: row.extension_id,
    label: row.label,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    revoked_at: row.revoked_at
  };
}

module.exports = {
  EXTENSION_ID_PATTERN,
  CLIENT_TOUCH_INTERVAL_MS,
  authenticateApiClient,
  createApiClient,
  getApiClient,
  listApiClients,
  normalizeExtensionId,
  revokeApiClient,
  tokenDigest
};
