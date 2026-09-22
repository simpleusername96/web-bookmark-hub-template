"use strict";

const { RegistryError } = require("../registry/errors.js");

function ok(data, { status = 200, headers = {} } = {}) {
  return json(status, { ok: true, data }, headers);
}

function fail(error) {
  const registryError = error instanceof RegistryError
    ? error
    : new RegistryError("INTERNAL_ERROR", "An unexpected error occurred.");
  const payload = {
    ok: false,
    error: {
      code: registryError.code,
      message: registryError.message
    }
  };
  if (registryError.details !== undefined && registryError.code !== "INTERNAL_ERROR") {
    payload.error.details = registryError.details;
  }
  return json(statusForError(registryError.code), payload);
}

function json(status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  return {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-length": String(Buffer.byteLength(body)),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...headers
    },
    body
  };
}

function statusForError(code) {
  if (["WEB_SESSION_UNAUTHORIZED", "API_CLIENT_UNAUTHORIZED", "PAIRING_CODE_INVALID"].includes(code)) return 401;
  if ([
    "CSRF_INVALID", "LOOPBACK_REQUIRED", "HOST_INVALID", "ORIGIN_INVALID",
    "FETCH_METADATA_REJECTED", "EXTENSION_ORIGIN_MISMATCH"
  ].includes(code)) return 403;
  if (code.endsWith("_NOT_FOUND") || ["ROUTE_NOT_FOUND", "VISUAL_ASSET_CONTENT_UNAVAILABLE"].includes(code)) return 404;
  if (code === "METHOD_NOT_ALLOWED") return 405;
  if ([
    "CAPTURE_REQUEST_CONFLICT", "API_CLIENT_TOKEN_CONFLICT", "ENTRY_URL_CONFLICT",
    "ENTRY_STATE_CONFLICT", "CAPTURE_POLICY_RULE_CONFLICT", "BATCH_QUERY_CHANGED",
    "GIT_PUBLICATION_BRANCH_INVALID", "GIT_PUBLICATION_BUSY", "GIT_PUBLICATION_DIVERGED"
  ].includes(code)) return 409;
  if (["PAIRING_RATE_LIMITED", "PAIRING_ATTEMPTS_EXCEEDED"].includes(code)) return 429;
  if ([
    "INTERNAL_ERROR", "GIT_PUBLICATION_FAILED", "GIT_PUBLICATION_REPOSITORY_INVALID",
    "GIT_PUBLICATION_VERIFY_FAILED"
  ].includes(code)) return 500;
  if (code === "IDEMPOTENCY_CAPACITY_EXCEEDED") return 503;
  return 400;
}

module.exports = { fail, json, ok, statusForError };
