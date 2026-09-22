"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  MAX_EXCHANGE_FAILURES,
  MAX_PAIRING_CODES,
  MAX_PAIRING_CREATIONS,
  MAX_RATE_KEYS,
  MAX_SESSIONS,
  PAIRING_TTL_MS,
  createAuthManager,
  validateLoopbackRequest,
  validateWebRequestMetadata
} = require("../server/auth.js");
const { openRegistry } = require("../registry/database.js");
const { CLIENT_TOUCH_INTERVAL_MS } = require("../registry/api-clients.js");

const BASE_URL = "http://127.0.0.1:43127";
const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wbh-server-auth-"));
  const registry = openRegistry({ dbPath: path.join(directory, "registry.sqlite3") });
  let milliseconds = Date.parse("2026-08-31T00:00:00.000Z");
  const clock = { now: () => milliseconds };
  return {
    directory,
    registry,
    clock,
    advance: (amount) => { milliseconds += amount; },
    auth: createAuthManager({ registry, clock })
  };
}

function dispose(subject) {
  subject.registry.close();
  fs.rmSync(subject.directory, { recursive: true, force: true, maxRetries: 3 });
}

function request(headers = {}, remoteAddress = "127.0.0.1") {
  return {
    headers: { host: "127.0.0.1:43127", ...headers },
    remoteAddress
  };
}

function cookieFrom(setCookie) {
  return setCookie.split(";", 1)[0];
}

test("loopback, Host, Origin, and Fetch Metadata checks fail closed", () => {
  validateLoopbackRequest(request(), BASE_URL);
  validateLoopbackRequest(request({}, "::ffff:127.0.0.1"), BASE_URL);
  validateWebRequestMetadata(request({ origin: BASE_URL, "sec-fetch-site": "same-origin" }), BASE_URL);
  validateWebRequestMetadata(request({
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "no-cors"
  }), BASE_URL, { allowSameOriginNoCors: true });
  validateWebRequestMetadata(request({
    "sec-fetch-site": "cross-site",
    "sec-fetch-mode": "navigate",
    "sec-fetch-dest": "document",
    "sec-fetch-user": "?1"
  }), BASE_URL, { allowCrossSiteNavigation: true });
  assert.throws(() => validateLoopbackRequest(request({}, "192.0.2.1"), BASE_URL), (error) => error.code === "LOOPBACK_REQUIRED");
  assert.throws(() => validateLoopbackRequest(request({ host: "evil.test" }), BASE_URL), (error) => error.code === "HOST_INVALID");
  assert.throws(() => validateWebRequestMetadata(request({ origin: "https://evil.test" }), BASE_URL), (error) => error.code === "ORIGIN_INVALID");
  assert.throws(() => validateWebRequestMetadata(request({ "sec-fetch-site": "cross-site" }), BASE_URL), (error) => error.code === "FETCH_METADATA_REJECTED");
  assert.throws(() => validateWebRequestMetadata(request({
    "sec-fetch-site": "cross-site",
    "sec-fetch-mode": "navigate",
    "sec-fetch-dest": "document"
  }), BASE_URL, { allowCrossSiteNavigation: true }), (error) => error.code === "FETCH_METADATA_REJECTED");
  assert.throws(() => validateWebRequestMetadata(request({ "sec-fetch-mode": "no-cors" }), BASE_URL), (error) => error.code === "FETCH_METADATA_REJECTED");
  assert.throws(() => validateWebRequestMetadata(request({
    "sec-fetch-site": "same-site",
    "sec-fetch-mode": "no-cors"
  }), BASE_URL, { allowSameOriginNoCors: true }), (error) => error.code === "FETCH_METADATA_REJECTED");
});

test("web sessions stay memory-only and mutations require the matching CSRF token", () => {
  const subject = fixture();
  try {
    const issued = subject.auth.issueSession();
    const cookie = cookieFrom(issued.set_cookie);
    const session = subject.auth.authenticateWeb(request({ cookie }));
    assert.ok(session);
    assert.ok(issued.set_cookie.includes("HttpOnly"));
    assert.ok(issued.set_cookie.includes("SameSite=Strict"));
    assert.throws(
      () => subject.auth.authenticateWeb(request({ cookie }), { csrf: true }),
      (error) => error.code === "CSRF_INVALID"
    );
    assert.throws(
      () => subject.auth.authenticateWeb(request({ cookie, "x-csrf-token": "wrong" }), { csrf: true }),
      (error) => error.code === "CSRF_INVALID"
    );
    assert.equal(
      subject.auth.authenticateWeb(request({ cookie, "x-csrf-token": issued.csrf_token }), { csrf: true }),
      session
    );
    assert.equal(subject.registry.db.prepare("SELECT COUNT(*) AS count FROM api_clients").get().count, 0);
    assert.equal(subject.registry.db.prepare("SELECT name FROM sqlite_schema WHERE name LIKE '%session%'").all().length, 0);
  } finally {
    dispose(subject);
  }
});

test("pairing is expiring, single-use, extension-bound, and persists only a token hash", () => {
  const subject = fixture();
  try {
    const issued = subject.auth.issueSession();
    const session = subject.auth.authenticateWeb(request({ cookie: cookieFrom(issued.set_cookie) }));
    const pairing = subject.auth.createPairingCodeForSession(session);
    assert.throws(
      () => subject.auth.exchangePairingCode({
        code: pairing.code,
        extensionId: EXTENSION_ID,
        origin: `chrome-extension://${"b".repeat(32)}`,
        remoteAddress: "127.0.0.1"
      }),
      (error) => error.code === "EXTENSION_ORIGIN_MISMATCH"
    );
    const exchanged = subject.auth.exchangePairingCode({
      code: pairing.code,
      extensionId: EXTENSION_ID,
      label: "Synthetic Chrome",
      origin: `chrome-extension://${EXTENSION_ID}`,
      remoteAddress: "127.0.0.1"
    });
    assert.equal(exchanged.client.extension_id, EXTENSION_ID);
    assert.equal(exchanged.client.label, "Synthetic Chrome");
    const stored = subject.registry.db.prepare("SELECT * FROM api_clients WHERE id = ?").get(exchanged.client.id);
    assert.notEqual(stored.token_sha256, exchanged.token);
    assert.equal(JSON.stringify(stored).includes(exchanged.token), false);
    assert.throws(
      () => subject.auth.exchangePairingCode({
        code: pairing.code,
        extensionId: EXTENSION_ID,
        remoteAddress: "127.0.0.1"
      }),
      (error) => error.code === "PAIRING_CODE_INVALID"
    );

    const authenticated = subject.auth.authenticateBearer(request({
      authorization: `Bearer ${exchanged.token}`,
      origin: `chrome-extension://${EXTENSION_ID}`
    }));
    assert.equal(authenticated.id, exchanged.client.id);
    const firstUsedAt = authenticated.last_used_at;
    subject.advance(CLIENT_TOUCH_INTERVAL_MS - 1);
    assert.equal(subject.auth.authenticateBearer(request({ authorization: `Bearer ${exchanged.token}` })).last_used_at, firstUsedAt);
    subject.advance(2);
    assert.notEqual(subject.auth.authenticateBearer(request({ authorization: `Bearer ${exchanged.token}` })).last_used_at, firstUsedAt);
    assert.throws(
      () => subject.auth.authenticateBearer(request({
        authorization: `Bearer ${exchanged.token}`,
        origin: `chrome-extension://${"c".repeat(32)}`
      })),
      (error) => error.code === "EXTENSION_ORIGIN_MISMATCH"
    );
    subject.auth.revokeClient(exchanged.client.id);
    assert.throws(
      () => subject.auth.authenticateBearer(request({ authorization: `Bearer ${exchanged.token}` })),
      (error) => error.code === "API_CLIENT_UNAUTHORIZED"
    );

    const expiring = subject.auth.createPairingCodeForSession(session);
    subject.advance(PAIRING_TTL_MS + 1);
    assert.throws(
      () => subject.auth.exchangePairingCode({ code: expiring.code, extensionId: EXTENSION_ID, remoteAddress: "127.0.0.1" }),
      (error) => error.code === "PAIRING_CODE_INVALID"
    );
  } finally {
    dispose(subject);
  }
});

test("pairing creation and failed exchange attempts are rate-limited", () => {
  const subject = fixture();
  try {
    const session = subject.auth.authenticateWeb(request({
      cookie: cookieFrom(subject.auth.issueSession().set_cookie)
    }));
    for (let index = 0; index < MAX_PAIRING_CREATIONS; index += 1) {
      assert.ok(subject.auth.createPairingCodeForSession(session).code);
    }
    assert.throws(
      () => subject.auth.createPairingCodeForSession(session),
      (error) => error.code === "PAIRING_RATE_LIMITED"
    );

    for (let index = 0; index < MAX_EXCHANGE_FAILURES; index += 1) {
      assert.throws(
        () => subject.auth.exchangePairingCode({ code: "BAD-CODE", extensionId: EXTENSION_ID, remoteAddress: "127.0.0.1" }),
        (error) => error.code === "PAIRING_CODE_INVALID"
      );
    }
    assert.throws(
      () => subject.auth.exchangePairingCode({ code: "BAD-CODE", extensionId: EXTENSION_ID, remoteAddress: "127.0.0.1" }),
      (error) => error.code === "PAIRING_ATTEMPTS_EXCEEDED"
    );
  } finally {
    dispose(subject);
  }
});

test("auth stores evict expired state and cap sessions, pairing codes, and attempt keys", () => {
  const subject = fixture();
  try {
    const issued = [];
    for (let index = 0; index < MAX_SESSIONS + 1; index += 1) issued.push(subject.auth.issueSession());
    assert.throws(() => subject.auth.authenticateWeb(request({ cookie: cookieFrom(issued[0].set_cookie) })), {
      code: "WEB_SESSION_UNAUTHORIZED"
    });
    const newest = subject.auth.authenticateWeb(request({ cookie: cookieFrom(issued.at(-1).set_cookie) }));
    assert.ok(newest);

    const codes = [];
    for (let index = 0; index < MAX_PAIRING_CODES + 1; index += 1) {
      const session = subject.auth.authenticateWeb(request({ cookie: cookieFrom(subject.auth.issueSession().set_cookie) }));
      codes.push(subject.auth.createPairingCodeForSession(session));
    }
    assert.throws(() => subject.auth.exchangePairingCode({
      code: codes[0].code, extensionId: EXTENSION_ID, remoteAddress: "cap-first"
    }), { code: "PAIRING_CODE_INVALID" });
    assert.ok(subject.auth.exchangePairingCode({
      code: codes.at(-1).code, extensionId: EXTENSION_ID, remoteAddress: "cap-last"
    }).token);

    const firstKey = "attempt-first";
    for (let index = 0; index < MAX_EXCHANGE_FAILURES; index += 1) {
      assert.throws(() => subject.auth.exchangePairingCode({
        code: "BAD", extensionId: EXTENSION_ID, remoteAddress: firstKey
      }), { code: "PAIRING_CODE_INVALID" });
    }
    for (let index = 0; index < MAX_RATE_KEYS; index += 1) {
      assert.throws(() => subject.auth.exchangePairingCode({
        code: "BAD", extensionId: EXTENSION_ID, remoteAddress: `attempt-${index}`
      }), { code: "PAIRING_CODE_INVALID" });
    }
    assert.throws(() => subject.auth.exchangePairingCode({
      code: "BAD", extensionId: EXTENSION_ID, remoteAddress: firstKey
    }), { code: "PAIRING_CODE_INVALID" });

    const creationSession = subject.auth.authenticateWeb(request({ cookie: cookieFrom(subject.auth.issueSession().set_cookie) }));
    for (let index = 0; index < MAX_PAIRING_CREATIONS; index += 1) {
      subject.auth.createPairingCodeForSession(creationSession);
    }
    assert.throws(() => subject.auth.createPairingCodeForSession(creationSession), { code: "PAIRING_RATE_LIMITED" });
    for (let index = 0; index < MAX_RATE_KEYS; index += 1) {
      const distinct = subject.auth.authenticateWeb(request({ cookie: cookieFrom(subject.auth.issueSession().set_cookie) }));
      subject.auth.createPairingCodeForSession(distinct);
    }
    assert.ok(subject.auth.createPairingCodeForSession(creationSession).code);
  } finally {
    dispose(subject);
  }
});
