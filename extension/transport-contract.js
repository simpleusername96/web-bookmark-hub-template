(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.WBHTransportContract = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const MAX_JSON_BODY_BYTES = 1024 * 1024;
  const MAX_SHORTCUT_EVIDENCE_BODY_BYTES = 6 * 1024 * 1024;

  function serializeJsonBody(value, maxBytes = MAX_JSON_BODY_BYTES) {
    const body = JSON.stringify(value);
    if (new TextEncoder().encode(body).byteLength > maxBytes) {
      const error = new Error("Request body is too large.");
      error.code = "REQUEST_BODY_TOO_LARGE";
      error.details = { maxBytes };
      throw error;
    }
    return body;
  }

  return { MAX_JSON_BODY_BYTES, MAX_SHORTCUT_EVIDENCE_BODY_BYTES, serializeJsonBody };
}));
