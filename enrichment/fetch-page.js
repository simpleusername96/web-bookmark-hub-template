"use strict";

const { RegistryError } = require("../registry/errors.js");
const { requestPinned, resolvePublicAddresses } = require("../server/public-network.js");
const { requireTemplate } = require("./templates.js");
const { MAX_HTML_BYTES } = require("./extract.js");

async function fetchPage(value, options = {}) {
  const initial = requireTemplate(value);
  const deadline = Date.now() + (options.timeoutMs || 12000);
  let response;
  const remaining = () => {
    const ms = deadline - Date.now();
    if (ms <= 0) throw new RegistryError("ENRICH_TIMEOUT", "Page request timed out.");
    return ms;
  };
  const timed = (promise) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { response?.destroy?.(); reject(new RegistryError("ENRICH_TIMEOUT", "Page request timed out.")); }, remaining());
    Promise.resolve(promise).then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
  try {
    let url = new URL(initial.url);
    for (let hop = 0; hop <= 3; hop++) {
      options.beforeRequest?.();
      const current = requireTemplate(url.href);
      if (current.objectKey !== initial.objectKey) throw new RegistryError("ENRICH_REDIRECT_MISMATCH", "Redirect changed the saved object or price context.");
      const addresses = await timed(resolvePublicAddresses(url.hostname, options.lookup));
      options.beforeRequest?.();
      response = await timed((options.request || requestPinned)({ url, address: addresses[0].address, timeoutMs: remaining(), headers: {
        accept: "text/html,application/xhtml+xml", "accept-encoding": "identity", "user-agent": "WebBookmarkHub/0.3 (explicit metadata retrieval)"
      } }));
      const status = Number(response.statusCode);
      const header = (key) => String([response.headers?.[key]].flat()[0] || "");
      if ([301, 302, 303, 307, 308].includes(status)) {
        const location = header("location");
        response.destroy?.();
        if (!location || hop === 3) throw new RegistryError("ENRICH_REDIRECT_LIMIT", "Missing redirect target or redirect limit reached.");
        const next = new URL(location, url);
        if (url.protocol === "https:" && next.protocol !== "https:") throw new RegistryError("ENRICH_REDIRECT_MISMATCH", "HTTPS downgrade refused.");
        url = next;
        continue;
      }
      if (status !== 200) {
        response.destroy?.();
        const code = status === 429 ? "RATE_LIMITED" : [401, 403].includes(status) ? "ACCESS_REQUIRED" : [404, 410].includes(status) ? "NOT_FOUND" : "HTTP_ERROR";
        throw new RegistryError(`ENRICH_${code}`, "Page retrieval failed.", { http_status: status });
      }
      if (!/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(header("content-type"))) throw new RegistryError("ENRICH_NOT_HTML", "Response is not HTML.");
      if (header("content-encoding") && header("content-encoding") !== "identity") throw new RegistryError("ENRICH_ENCODING", "Unexpected compressed response.");
      if (Number(header("content-length")) > MAX_HTML_BYTES) throw new RegistryError("ENRICH_TOO_LARGE", "HTML response is too large.");
      const chunks = [];
      let bytes = 0;
      await timed((async () => {
        for await (const raw of response) {
          remaining();
          const chunk = Buffer.from(raw);
          bytes += chunk.length;
          if (bytes > MAX_HTML_BYTES) throw new RegistryError("ENRICH_TOO_LARGE", "HTML response is too large.");
          chunks.push(chunk);
        }
      })());
      const buffer = Buffer.concat(chunks);
      const charset = header("content-type").match(/charset=["']?([\w-]+)/i)?.[1]
        || buffer.subarray(0, 4096).toString("ascii").match(/charset\s*=\s*["']?([\w-]+)/i)?.[1] || "utf-8";
      let html;
      try { html = new TextDecoder(charset, { fatal: true }).decode(buffer); } catch { throw new RegistryError("ENRICH_ENCODING", "Unsupported or invalid page encoding."); }
      options.beforeRequest?.();
      return { html, url: url.href, http_status: status };
    }
  } catch (error) {
    response?.destroy?.();
    if (error instanceof RegistryError && error.code.startsWith("ENRICH_")) throw error;
    if (error?.code === "CAPTURE_IMAGE_ADDRESS_BLOCKED") throw new RegistryError("ENRICH_ADDRESS_BLOCKED", "Non-public network destination refused.");
    throw new RegistryError("ENRICH_NETWORK", "Page network request failed.");
  }
}

module.exports = { fetchPage };
