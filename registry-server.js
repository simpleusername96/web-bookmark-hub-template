#!/usr/bin/env node
"use strict";

const path = require("node:path");

const { openRegistry } = require("./registry/database.js");
const { initializeSelectedImageStorage } = require("./registry/capture-policy.js");
const { RegistryError } = require("./registry/errors.js");
const { createHttpApp } = require("./server/http-app.js");
const { createNodeServer } = require("./server/node-http.js");

const HELP = `Web Bookmark Hub local server

Usage:
  node registry-server.js --host 127.0.0.1 --port <fastrun-port> [--db <path>] [--selected-image-storage-default <mode>]
  node registry-server.js --help

Options:
  --host <ip>  Required and must be exactly 127.0.0.1.
  --port <n>   Required loopback port (or WEB_BOOKMARK_HUB_PORT).
  --db <path>  Registry SQLite path (or WEB_BOOKMARK_HUB_DB).
  --selected-image-storage-default <mode>
               Initial mode only while unset: reference_only (default) or local_copy.
  --help       Show this help.

The server always binds to 127.0.0.1. It cannot be configured for a public interface.`;

async function main(argv = process.argv.slice(2), streams = {}) {
  const stdout = streams.stdout || process.stdout;
  const stderr = streams.stderr || process.stderr;
  const env = streams.env || process.env;
  const logger = streams.logger || {
    error: (line) => stderr.write(`${line}\n`)
  };
  let options;
  try {
    options = parseArgs(argv, env);
    if (options.help) {
      stdout.write(`${HELP}\n`);
      return { exitCode: 0, server: null };
    }
  } catch (error) {
    stderr.write(`Error [${error.code || "VALIDATION_ERROR"}]: ${error.message}\n`);
    return { exitCode: 1, server: null };
  }

  let registry;
  try {
    registry = openRegistry({ dbPath: options.dbPath, env });
    initializeSelectedImageStorage(registry, options.selectedImageStorageDefault);
    const baseUrl = `http://${options.host}:${options.port}`;
    const app = createHttpApp({
      registry,
      baseUrl,
      webRoot: path.resolve(__dirname, "web")
    });
    const server = createNodeServer(app, { logger });
    await listen(server, options.host, options.port);
    stdout.write(`Web Bookmark Hub ready at ${baseUrl}\n`);
    installShutdown(server, registry);
    return { exitCode: 0, server, registry, baseUrl };
  } catch (error) {
    if (registry) registry.close();
    logStartupFailure(logger, error);
    stderr.write(`Error [${error.code || "SERVER_START_FAILED"}]: ${safeStartMessage(error)}\n`);
    return { exitCode: 1, server: null };
  }
}

function parseArgs(argv, env = process.env) {
  const options = {
    help: false,
    host: undefined,
    port: undefined,
    dbPath: undefined,
    selectedImageStorageDefault: undefined
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (["--help", "-h"].includes(argument)) {
      options.help = true;
      continue;
    }
    if (["--host", "--port", "--db", "--selected-image-storage-default"].includes(argument)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new RegistryError("VALIDATION_ERROR", `${argument} requires a value.`);
      }
      if (argument === "--host") options.host = value;
      else if (argument === "--port") options.port = value;
      else if (argument === "--db") options.dbPath = value;
      else options.selectedImageStorageDefault = value;
      index += 1;
      continue;
    }
    throw new RegistryError("VALIDATION_ERROR", `Unknown option: ${argument}`);
  }
  if (options.help) return options;
  const host = options.host ?? env.WEB_BOOKMARK_HUB_HOST;
  if (host !== "127.0.0.1") {
    throw new RegistryError("VALIDATION_ERROR", "--host is required and must be 127.0.0.1.");
  }
  const port = Number(options.port ?? env.WEB_BOOKMARK_HUB_PORT);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    throw new RegistryError("VALIDATION_ERROR", "A valid --port from the fastrun lane is required.");
  }
  const selectedImageStorageDefault = options.selectedImageStorageDefault
    ?? env.WEB_BOOKMARK_HUB_SELECTED_IMAGE_STORAGE_DEFAULT
    ?? "reference_only";
  if (!["reference_only", "local_copy"].includes(selectedImageStorageDefault)) {
    throw new RegistryError(
      "VALIDATION_ERROR",
      "--selected-image-storage-default must be reference_only or local_copy."
    );
  }
  return {
    ...options,
    host,
    port,
    dbPath: options.dbPath ?? env.WEB_BOOKMARK_HUB_DB,
    selectedImageStorageDefault
  };
}

function logStartupFailure(logger, error, clock = Date) {
  if (!logger || typeof logger.error !== "function") return;
  logger.error(JSON.stringify({
    timestamp: new Date(clock.now()).toISOString(),
    method: "STARTUP",
    pathname: "/",
    status: 500,
    errorCode: safeStartCode(error)
  }));
}

function safeStartCode(error) {
  if (error instanceof RegistryError) return error.code;
  if (error?.code === "EADDRINUSE") return "EADDRINUSE";
  return "SERVER_START_FAILED";
}

function listen(server, host, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function installShutdown(server, registry) {
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    closeServer(server, registry).then(() => { process.exitCode = 0; });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

function closeServer(server, registry) {
  return new Promise((resolve) => {
    server.close(() => {
      registry.close();
      resolve();
    });
  });
}

function safeStartMessage(error) {
  if (error instanceof RegistryError) return error.message;
  if (error?.code === "EADDRINUSE") return "The assigned loopback port is already in use.";
  return "The local server could not start.";
}

if (require.main === module) {
  main().then((result) => {
    process.exitCode = result.exitCode;
  });
}

module.exports = { HELP, closeServer, logStartupFailure, main, parseArgs };
