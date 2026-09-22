"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { PassThrough, Writable } = require("node:stream");
const test = require("node:test");

const {
  HEADERS_TIMEOUT_MS,
  KEEP_ALIVE_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  createNodeServer,
  requestBodyLimit,
  writeNodeResponse
} = require("../server/node-http.js");
const { MAX_JSON_BODY_BYTES, MAX_SHORTCUT_EVIDENCE_BODY_BYTES } = require("../server/http-app.js");

test("Node HTTP grants the larger body limit only to shortcut evidence", () => {
  assert.equal(requestBodyLimit("/api/v1/captures/7/shortcut-evidence"), MAX_SHORTCUT_EVIDENCE_BODY_BYTES);
  assert.equal(requestBodyLimit("/api/v1/captures"), MAX_JSON_BODY_BYTES);
  assert.equal(requestBodyLimit("/api/v1/captures/7/shortcut-evidence/extra"), MAX_JSON_BODY_BYTES);
});

test("Node HTTP streams file descriptors and preserves GET, HEAD, and missing-file behavior", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wbh-node-http-"));
  const filePath = path.join(directory, "image.png");
  const bytes = Buffer.from([137, 80, 78, 71]);
  fs.writeFileSync(filePath, bytes);
  const server = createNodeServer({
    dispatch: async (request) => ({
      status: 200,
      headers: { "content-type": "image/png", "content-length": String(bytes.length) },
      file: { path: request.url === "/missing" ? path.join(directory, "missing.png") : filePath }
    })
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const get = await request(port, "GET", "/image");
    assert.equal(get.status, 200);
    assert.deepEqual(get.body, bytes);
    const head = await request(port, "HEAD", "/image");
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);
    assert.equal(head.headers["content-length"], String(bytes.length));
    const missing = await request(port, "GET", "/missing");
    assert.notEqual(missing.status, 200);
    assert.equal(JSON.parse(missing.body).error.code, "VISUAL_ASSET_CONTENT_UNAVAILABLE");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Node HTTP applies bounded incoming request timeouts", () => {
  const server = createNodeServer({ dispatch: async () => ({ status: 204, headers: {}, body: "" }) });
  assert.equal(server.headersTimeout, HEADERS_TIMEOUT_MS);
  assert.equal(server.requestTimeout, REQUEST_TIMEOUT_MS);
  assert.equal(server.keepAliveTimeout, KEEP_ALIVE_TIMEOUT_MS);
});

test("Node HTTP terminates slow headers and request bodies", async () => {
  const server = createNodeServer({ dispatch: async () => ({ status: 204, headers: {}, body: "" }) }, {
    headersTimeout: 100,
    requestTimeout: 120,
    keepAliveTimeout: 80,
    connectionsCheckingInterval: 25
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const slowHeader = await rawSocketUntilClose(port, "GET / HTTP/1.1\r\nHost: 127.0.0.1");
    assert.match(slowHeader, /408 Request Timeout/);
    const slowBody = await rawSocketUntilClose(
      port,
      "POST / HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 10\r\n\r\nX"
    );
    assert.match(slowBody, /408 Request Timeout/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Node HTTP logs only redacted fields for unexpected failures and keeps 4xx quiet", async () => {
  const lines = [];
  const secret = "token-and-cookie-secret";
  const server = createNodeServer({
    dispatch: async (input) => {
      if (input.url.startsWith("/expected")) {
        return { status: 400, headers: {}, body: JSON.stringify({ error: { code: "VALIDATION_ERROR" } }) };
      }
      throw Object.assign(new Error(`failure ${secret} C:\\private\\registry.sqlite3`), {
        stack: `stack ${secret}`
      });
    }
  }, {
    clock: { now: () => Date.parse("2026-09-03T00:00:00.000Z") },
    logger: { error: (line) => lines.push(line) }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    await request(port, "GET", `/expected?token=${secret}`, { cookie: secret });
    assert.equal(lines.length, 0);
    const failure = await request(port, "POST", `/explode?token=${secret}`, {
      cookie: secret,
      authorization: `Bearer ${secret}`,
      "content-type": "application/json"
    }, JSON.stringify({ secret }));
    assert.equal(failure.status, 500);
    assert.deepEqual(JSON.parse(lines[0]), {
      timestamp: "2026-09-03T00:00:00.000Z",
      method: "POST",
      pathname: "/explode",
      status: 500,
      errorCode: "INTERNAL_ERROR"
    });
    assert.equal(lines[0].includes(secret), false);
    assert.equal(lines[0].includes("private"), false);
    assert.equal(lines[0].includes("stack"), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Node HTTP destroys a response when a file stream fails after headers", async () => {
  const response = new FakeResponse();
  response.on("error", () => {});
  const stream = new PassThrough();
  writeNodeResponse(response, {
    status: 200,
    headers: { "content-type": "image/png" },
    file: { path: "synthetic" }
  }, false, { createReadStream: () => stream });
  stream.emit("open");
  stream.write(Buffer.from([1]));
  stream.destroy(new Error("synthetic stream failure"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(response.headersSent, true);
  assert.equal(response.destroyed, true);
});

class FakeResponse extends Writable {
  constructor() {
    super();
    this.headersSent = false;
    this.statusCode = null;
  }
  writeHead(status) {
    this.statusCode = status;
    this.headersSent = true;
  }
  _write(_chunk, _encoding, callback) { callback(); }
}

function request(port, method, pathname, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request({ host: "127.0.0.1", port, method, path: pathname, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

function rawSocketUntilClose(port, initialBytes) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let received = "";
    const guard = setTimeout(() => {
      socket.destroy();
      reject(new Error("slow request socket was not terminated"));
    }, 2_000);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(initialBytes));
    socket.on("data", (chunk) => { received += chunk; });
    socket.on("end", () => {
      clearTimeout(guard);
      resolve(received);
    });
    socket.on("close", () => {
      if (!received) return;
      clearTimeout(guard);
      resolve(received);
    });
    socket.on("error", (error) => {
      clearTimeout(guard);
      reject(error);
    });
  });
}
