"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { RegistryError } = require("../registry/errors.js");
const { isPathWithin } = require("../registry/database.js");

const CONTENT_TYPES = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
});

function serveStaticFile(webRoot, pathname, { head = false } = {}) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new RegistryError("ROUTE_NOT_FOUND", "Resource not found.");
  }
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  if (!relative || relative.split(/[\\/]+/).every(Boolean) === false || relative.split(/[\\/]+/).includes("..")) {
    throw new RegistryError("ROUTE_NOT_FOUND", "Resource not found.");
  }
  const root = path.resolve(webRoot);
  const filePath = path.resolve(root, ...relative.split("/"));
  if (!isPathWithin(root, filePath)) {
    throw new RegistryError("ROUTE_NOT_FOUND", "Resource not found.");
  }
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new RegistryError("ROUTE_NOT_FOUND", "Resource not found.");
  }
  const extension = path.extname(filePath).toLowerCase();
  if (!stat.isFile() || !CONTENT_TYPES[extension]) {
    throw new RegistryError("ROUTE_NOT_FOUND", "Resource not found.");
  }
  const body = fs.readFileSync(filePath);
  return {
    status: 200,
    headers: {
      "content-type": CONTENT_TYPES[extension],
      "content-length": String(body.length),
      "cache-control": "no-store",
      "content-security-policy": "default-src 'self'; img-src 'self' https:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff"
    },
    body: head ? Buffer.alloc(0) : body
  };
}

module.exports = { CONTENT_TYPES, serveStaticFile };
