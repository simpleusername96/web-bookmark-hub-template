"use strict";

const http = require("node:http");
const fs = require("node:fs");

const { RegistryError } = require("../registry/errors.js");
const { fail } = require("./responses.js");
const { MAX_JSON_BODY_BYTES, MAX_SHORTCUT_EVIDENCE_BODY_BYTES } = require("./http-app.js");

const HEADERS_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 15_000;
const KEEP_ALIVE_TIMEOUT_MS = 5_000;

function createNodeServer(app, {
  logger = console,
  clock = Date,
  headersTimeout = HEADERS_TIMEOUT_MS,
  requestTimeout = REQUEST_TIMEOUT_MS,
  keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS,
  connectionsCheckingInterval = Math.min(1_000, headersTimeout, requestTimeout)
} = {}) {
  const server = http.createServer({
    headersTimeout,
    requestTimeout,
    keepAliveTimeout,
    connectionsCheckingInterval
  }, async (request, response) => {
    try {
      const body = await readRequestBody(request, requestBodyLimit(request.url));
      const result = await app.dispatch({
        method: request.method,
        url: request.url,
        headers: request.headers,
        remoteAddress: request.socket.remoteAddress,
        body
      });
      if (result.status >= 500) {
        logFailure(logger, {
          timestamp: new Date(clock.now()).toISOString(),
          method: request.method || "GET",
          pathname: safePathname(request.url),
          status: result.status,
          errorCode: responseErrorCode(result)
        });
      }
      writeNodeResponse(response, result, request.method === "HEAD");
    } catch (error) {
      if (request.aborted || error?.code === "ECONNRESET") {
        if (!response.destroyed) response.destroy();
        return;
      }
      const result = fail(error);
      if (result.status >= 500) {
        logFailure(logger, {
          timestamp: new Date(clock.now()).toISOString(),
          method: request.method || "GET",
          pathname: safePathname(request.url),
          status: result.status,
          errorCode: error?.code || "INTERNAL_ERROR"
        });
      }
      writeNodeResponse(response, result, request.method === "HEAD");
    }
  });
  return server;
}

function safePathname(requestUrl) {
  try {
    return new URL(requestUrl || "/", "http://127.0.0.1").pathname;
  } catch {
    return "/";
  }
}

function responseErrorCode(result) {
  try {
    const payload = JSON.parse(result.body);
    return typeof payload?.error?.code === "string" ? payload.error.code : "INTERNAL_ERROR";
  } catch {
    return "INTERNAL_ERROR";
  }
}

function logFailure(logger, fields) {
  if (!logger || typeof logger.error !== "function") return;
  logger.error(JSON.stringify(fields));
}

function readRequestBody(request, maxBytes = MAX_JSON_BODY_BYTES) {
  if (["GET", "HEAD"].includes(request.method || "GET")) {
    return Promise.resolve(undefined);
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let exceeded = false;
    request.on("data", (chunk) => {
      if (exceeded) return;
      size += chunk.length;
      if (size > maxBytes) {
        exceeded = true;
        reject(new RegistryError("REQUEST_BODY_TOO_LARGE", "Request body is too large.", {
          maxBytes
        }));
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (!exceeded) resolve(Buffer.concat(chunks));
    });
    request.on("error", reject);
  });
}

function requestBodyLimit(requestUrl) {
  return /^\/api\/v1\/captures\/\d+\/shortcut-evidence$/.test(safePathname(requestUrl))
    ? MAX_SHORTCUT_EVIDENCE_BODY_BYTES
    : MAX_JSON_BODY_BYTES;
}

function writeNodeResponse(response, result, head = false, options = {}) {
  if (response.headersSent || response.destroyed) return;
  if (result.file) {
    if (head) {
      response.writeHead(result.status, result.headers);
      response.end();
      return;
    }
    const stream = (options.createReadStream || fs.createReadStream)(result.file.path);
    stream.once("open", () => {
      if (response.headersSent || response.destroyed) {
        stream.destroy();
        return;
      }
      response.writeHead(result.status, result.headers);
      stream.pipe(response);
    });
    stream.once("error", (error) => {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      const failure = fail(new RegistryError("VISUAL_ASSET_CONTENT_UNAVAILABLE", "Visual Asset content is unavailable."));
      response.writeHead(failure.status, failure.headers);
      response.end(head ? undefined : failure.body);
    });
    return stream;
  }
  response.writeHead(result.status, result.headers);
  response.end(head ? undefined : result.body);
}

module.exports = {
  HEADERS_TIMEOUT_MS,
  KEEP_ALIVE_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  createNodeServer,
  logFailure,
  readRequestBody,
  requestBodyLimit,
  safePathname,
  writeNodeResponse
};
