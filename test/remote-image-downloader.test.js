"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const test = require("node:test");

const {
  downloadImageToStaging,
  isPublicAddress,
  resolvePublicAddresses
} = require("../server/remote-image-downloader.js");

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const PUBLIC = "93.184.216.34";

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wbh-remote-image-"));
  return {
    directory,
    registry: { dbPath: path.join(directory, "registry.sqlite3"), dataDir: path.join(directory, "registry.sqlite3.data") }
  };
}

function response(statusCode, headers, chunks) {
  const stream = Readable.from(chunks || []);
  stream.statusCode = statusCode;
  stream.headers = headers || {};
  return stream;
}

function options(routes, overrides = {}) {
  return {
    lookup: async () => [{ address: PUBLIC, family: 4 }],
    request: async ({ url, address, headers }) => {
      assert.equal(address, PUBLIC);
      assert.equal(headers["accept-encoding"], "identity");
      const route = routes[url.href];
      if (!route) throw new Error("Unexpected URL");
      return route();
    },
    ...overrides
  };
}

test("guarded downloader preserves exact image bytes and revalidates a public redirect", async () => {
  const subject = fixture();
  try {
    const result = await downloadImageToStaging(subject.registry, "https://images.example.test/start", options({
      "https://images.example.test/start": () => response(302, { location: "https://cdn.example.test/final.png" }),
      "https://cdn.example.test/final.png": () => response(200, { "content-type": "image/png", "content-length": String(PNG.length) }, [PNG])
    }));
    assert.deepEqual(await fsp.readFile(result.filePath), PNG);
    assert.equal(result.byteSize, PNG.length);
    assert.equal(result.finalUrl, "https://cdn.example.test/final.png");
    await fsp.rm(result.filePath, { force: true });
  } finally {
    fs.rmSync(subject.directory, { recursive: true, force: true });
  }
});

test("address guard rejects private, reserved, mixed, mapped, and credential-bearing targets", async () => {
  assert.equal(isPublicAddress(PUBLIC), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
  ["127.0.0.1", "10.0.0.2", "169.254.169.254", "192.168.1.2", "198.51.100.4", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "2002:7f00:1::"]
    .forEach((address) => assert.equal(isPublicAddress(address), false, address));
  assert.deepEqual(await resolvePublicAddresses("[2606:4700:4700::1111]", async () => {
    throw new Error("IPv6 literals must not use DNS");
  }), [{ address: "2606:4700:4700::1111", family: 6 }]);
  await assert.rejects(
    () => resolvePublicAddresses("[::1]", async () => []),
    { code: "CAPTURE_IMAGE_ADDRESS_BLOCKED" }
  );
  await assert.rejects(
    () => resolvePublicAddresses("mixed.test", async () => [{ address: PUBLIC, family: 4 }, { address: "127.0.0.1", family: 4 }]),
    { code: "CAPTURE_IMAGE_ADDRESS_BLOCKED" }
  );
  const subject = fixture();
  try {
    await assert.rejects(
      () => downloadImageToStaging(subject.registry, "https://user:secret@example.test/a.png", options({})),
      { code: "CAPTURE_IMAGE_URL_INVALID" }
    );
  } finally {
    fs.rmSync(subject.directory, { recursive: true, force: true });
  }
});

test("invalid responses, overflow, redirect loops, and transport failures leave no staged file", async () => {
  const cases = [
    {
      url: "https://images.example.test/html",
      routes: { "https://images.example.test/html": () => response(200, { "content-type": "text/html" }, [Buffer.from("no")]) },
      code: "CAPTURE_IMAGE_RESPONSE_INVALID"
    },
    {
      url: "https://images.example.test/large",
      routes: { "https://images.example.test/large": () => response(200, { "content-type": "image/png" }, [PNG, PNG]) },
      settings: { maxBytes: PNG.length },
      code: "CAPTURE_IMAGE_TOO_LARGE"
    },
    {
      url: "https://images.example.test/loop",
      routes: { "https://images.example.test/loop": () => response(302, { location: "/loop" }) },
      settings: { maxRedirects: 1 },
      code: "CAPTURE_IMAGE_REDIRECT_LIMIT"
    },
    {
      url: "https://images.example.test/fail",
      routes: { "https://images.example.test/fail": () => { throw new Error("socket detail must be redacted"); } },
      code: "CAPTURE_IMAGE_DOWNLOAD_FAILED"
    }
  ];
  for (const item of cases) {
    const subject = fixture();
    try {
      await assert.rejects(
        () => downloadImageToStaging(subject.registry, item.url, options(item.routes, item.settings)),
        { code: item.code }
      );
      const staging = path.join(subject.registry.dataDir, "capture-staging");
      assert.deepEqual(fs.existsSync(staging) ? fs.readdirSync(staging) : [], []);
    } finally {
      fs.rmSync(subject.directory, { recursive: true, force: true });
    }
  }
});

test("connection failures try public addresses in resolver order within one deadline", async () => {
  const subject = fixture();
  let now = 0;
  const attempts = [];
  try {
    const result = await downloadImageToStaging(subject.registry, "https://images.example.test/failover.png", {
      now: () => now,
      lookup: async () => [
        { address: PUBLIC, family: 4 },
        { address: "93.184.216.35", family: 4 }
      ],
      request: async ({ address, timeoutMs }) => {
        attempts.push({ address, timeoutMs });
        if (address === PUBLIC) {
          now = 15_000;
          const error = new Error("first address unavailable");
          error.code = "ECONNREFUSED";
          throw error;
        }
        return response(200, { "content-type": "image/png" }, [PNG]);
      }
    });
    assert.deepEqual(attempts.map((item) => item.address), [PUBLIC, "93.184.216.35"]);
    assert.equal(attempts[0].timeoutMs, 20_000);
    assert.equal(attempts[1].timeoutMs, 5_000);
    assert.deepEqual(await fsp.readFile(result.filePath), PNG);
  } finally {
    fs.rmSync(subject.directory, { recursive: true, force: true });
  }
});

test("all-address failure is bounded and redirects cannot multiply the total deadline", async () => {
  const subject = fixture();
  let now = 0;
  const timeouts = [];
  try {
    await assert.rejects(downloadImageToStaging(subject.registry, "https://images.example.test/start", {
      now: () => now,
      lookup: async () => [
        { address: PUBLIC, family: 4 },
        { address: "93.184.216.35", family: 4 }
      ],
      request: async ({ url, address, timeoutMs }) => {
        timeouts.push(timeoutMs);
        if (url.pathname === "/start") {
          now = 19_500;
          return response(302, { location: "/redirected" });
        }
        now = 20_001;
        const error = new Error(`unavailable ${address}`);
        error.code = "ECONNREFUSED";
        throw error;
      }
    }), { code: "CAPTURE_IMAGE_TIMEOUT" });
    assert.equal(timeouts[0], 20_000);
    assert.ok(timeouts.slice(1).every((value) => value <= 500));
    const staging = path.join(subject.registry.dataDir, "capture-staging");
    assert.deepEqual(fs.existsSync(staging) ? fs.readdirSync(staging) : [], []);
  } finally {
    fs.rmSync(subject.directory, { recursive: true, force: true });
  }
});


test("pinned requests support Node lookup single and all-address callback contracts", async (t) => {
  const http = require("node:http");
  const { EventEmitter } = require("node:events");
  const { requestPinned } = require("../server/public-network.js");
  for (const all of [false, true]) {
    t.mock.method(http, "request", (url, options) => {
      const request = new EventEmitter();
      request.end = () => {
        options.lookup(url.hostname, { all }, (error, result, family) => {
          assert.equal(error, null);
          if (all) assert.deepEqual(result, [{ address: PUBLIC, family: 4 }]);
          else { assert.equal(result, PUBLIC); assert.equal(family, 4); }
        });
        const response = new EventEmitter();
        request.emit("response", response);
        response.emit("end");
      };
      return request;
    });
    await requestPinned({ url: new URL("http://image.example.test/a.png"), address: PUBLIC, timeoutMs: 1000, headers: {} });
    t.mock.restoreAll();
  }
});
