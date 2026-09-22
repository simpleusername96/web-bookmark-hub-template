(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.WBHPairingBridge = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function createExternalPairingBridge({ client, canonicalBaseUrl }) {
    const allowedOrigin = new URL(canonicalBaseUrl).origin;

    async function handle(message, sender) {
      if (originOf(sender?.url) !== allowedOrigin) {
        throw bridgeError("PAIRING_SENDER_INVALID", "Pairing approval must come from the local Web Bookmark Hub page.");
      }
      if (message?.type !== "WBH_PAIR_WITH_CODE") {
        throw bridgeError("MESSAGE_UNSUPPORTED", "Unknown external extension message.");
      }
      return client.pair({ baseUrl: canonicalBaseUrl, code: message.code, label: message.label || "Chrome" });
    }

    return { handle };
  }

  function originOf(value) {
    try { return new URL(String(value || "")).origin; }
    catch (_error) { return ""; }
  }

  function bridgeError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  return { createExternalPairingBridge };
}));
