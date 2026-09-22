"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { closeServer, logStartupFailure, main, parseArgs } = require("../registry-server.js");

function stream() {
  let value = "";
  return { write: (chunk) => { value += chunk; }, read: () => value };
}

test("server help and argument parsing never invent a fallback port or public bind", async () => {
  const stdout = stream();
  const stderr = stream();
  const help = await main(["--help"], { stdout, stderr, env: {} });
  assert.equal(help.exitCode, 0);
  assert.match(stdout.read(), /always binds to 127\.0\.0\.1/);
  assert.equal(stderr.read(), "");
  assert.deepEqual(parseArgs(["--host", "127.0.0.1", "--port", "43127", "--db", "D:\\Synthetic\\registry.sqlite3"], {}), {
    help: false,
    host: "127.0.0.1",
    port: 43127,
    dbPath: "D:\\Synthetic\\registry.sqlite3",
    selectedImageStorageDefault: "reference_only"
  });
  assert.equal(parseArgs([
    "--host", "127.0.0.1", "--port", "43127", "--selected-image-storage-default", "local_copy"
  ], {}).selectedImageStorageDefault, "local_copy");
  assert.throws(() => parseArgs([
    "--host", "127.0.0.1", "--port", "43127", "--selected-image-storage-default", "all"
  ], {}), /must be reference_only or local_copy/);
  assert.throws(() => parseArgs([], {}), /--host is required/);
  assert.throws(() => parseArgs(["--host", "127.0.0.1"], {}), /fastrun lane is required/);
  assert.throws(() => parseArgs(["--port", "43127"], {}), /--host is required/);
  assert.throws(() => parseArgs(["--host", "0.0.0.0", "--port", "43127"], {}), /must be 127\.0\.0\.1/);
});

test("graceful close owns only its injected server and Registry", async () => {
  let serverClosed = 0;
  let registryClosed = 0;
  const server = { close: (callback) => { serverClosed += 1; callback(); } };
  const registry = { close: () => { registryClosed += 1; } };
  await closeServer(server, registry);
  assert.equal(serverClosed, 1);
  assert.equal(registryClosed, 1);
});

test("startup failure logs contain only stable redacted fields", () => {
  const lines = [];
  const error = Object.assign(new Error("secret C:\\private\\registry.sqlite3"), {
    code: "EADDRINUSE",
    stack: "secret stack"
  });
  logStartupFailure({ error: (line) => lines.push(line) }, error, {
    now: () => Date.parse("2026-09-03T00:00:00.000Z")
  });
  assert.deepEqual(JSON.parse(lines[0]), {
    timestamp: "2026-09-03T00:00:00.000Z",
    method: "STARTUP",
    pathname: "/",
    status: 500,
    errorCode: "EADDRINUSE"
  });
  assert.equal(lines[0].includes("secret"), false);
  assert.equal(lines[0].includes("private"), false);
  assert.equal(lines[0].includes("stack"), false);
});
