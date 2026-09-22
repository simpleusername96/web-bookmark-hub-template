"use strict";

const { createHash, createHmac, randomBytes, timingSafeEqual } = require("node:crypto");
const { RegistryError } = require("../registry/errors.js");
const { addAgentNote, agentList, agentProjection, applyExtraction, createFromUrl, enrichEntry, inspectEntry, readEligible } = require("./service.js");
const { missingFields, normalizeFields } = require("./extract.js");

// Independent from owner sessions/API clients. No owner routes or raw DB/file
// access are exposed here. Deployment isolation is an additional requirement.
function createAgentHandler(registry, { token, scope = "metadata", allowNew = false, ...deps } = {}) {
  if (typeof token !== "string" || token.length < 32 || !["metadata", "enrich"].includes(scope)) throw new Error("Configure a strong agent-only token and metadata/enrich scope.");
  const tokenHash = createHash("sha256").update(token).digest();
  const references = new Map(), tickets = new Map();
  let active = 0;
  const unavailable = () => new RegistryError("ENRICH_NOT_AVAILABLE", "Entry is unavailable for this operation.");
  const reference = (id) => {
    const ref = createHmac("sha256", token).update(`entry:${id}`).digest("hex").slice(0, 32);
    references.set(ref, id);
    return ref;
  };
  function idFor(ref) { const id = references.get(ref); if (!id) throw unavailable(); return id; }
  function project(entry) {
    const data = agentProjection(scope === "metadata" ? { ...entry, agent_access: "metadata_only" } : entry);
    const { id, ...safe } = data;
    return { ref: reference(id), ...safe };
  }
  function assertWrite() { if (scope !== "enrich") throw unavailable(); }
  function strictKeys(body, keys) {
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((k) => !keys.includes(k))) throw new RegistryError("ENRICH_INVALID_REQUEST", "Unsupported request fields.");
  }
  return async function agentHandler(req, res) {
    const reply = (status, value) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      res.end(JSON.stringify(value));
    };
    let admitted = false;
    try {
      const supplied = String(req.headers.authorization || "").replace(/^Bearer /, "");
      if (req.headers.origin || !String(req.headers.authorization || "").startsWith("Bearer ") || !timingSafeEqual(createHash("sha256").update(supplied).digest(), tokenHash)) {
        reply(401, { ok: false, error: { code: "UNAUTHORIZED" } }); return;
      }
      if (active >= 2) { reply(429, { ok: false, error: { code: "ENRICH_BUSY" } }); return; }
      active++; admitted = true;
      if (!/^127\.0\.0\.2:\d+$/.test(String(req.headers.host || ""))) throw unavailable();
      const url = new URL(req.url, "http://127.0.0.2");
      let body = {};
      if (req.method === "POST") {
        let size = 0, chunks = [];
        for await (const raw of req) {
          size += raw.length;
          if (size > 32768) { reply(413, { ok: false, error: { code: "ENRICH_TOO_LARGE" } }); return; }
          chunks.push(raw);
        }
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { throw new RegistryError("ENRICH_INVALID_REQUEST", "Invalid JSON."); }
      }
      let data;
      if (req.method === "GET" && url.pathname === "/v1/entries") {
        const after = url.searchParams.has("after") ? idFor(url.searchParams.get("after")) : 0;
        const page = agentList(registry, {
          after,
          limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 50,
          savedFrom: url.searchParams.has("saved_from") ? url.searchParams.get("saved_from") : undefined,
          note: url.searchParams.has("note") ? url.searchParams.get("note") : undefined,
          enrichable: queryBoolean(url.searchParams, "enrichable")
        });
        data = { items: page.items.map((item) => project(readEligible(registry, item.id))), next_after: page.next_after ? reference(page.next_after) : null };
      } else if (req.method === "POST" && url.pathname === "/v1/entries") {
        assertWrite(); strictKeys(body, ["url"]);
        if (!allowNew) throw unavailable();
        data = project(createFromUrl(registry, body.url, { allowNew: true }));
      } else {
        const m = /^\/v1\/entries\/([a-f0-9]{32})(?:\/(inspect|run|apply|comments))?$/.exec(url.pathname);
        if (!m) throw unavailable();
        const id = idFor(m[1]);
        const entry = readEligible(registry, id, m[2] ? "enrich" : "read");
        if (req.method === "GET" && !m[2]) data = project(entry);
        else if (req.method === "POST" && m[2]) {
          assertWrite();
          if (m[2] === "run") {
            strictKeys(body, []);
            const { id: _id, ...outcome } = await enrichEntry(registry, id, deps);
            data = { ref: m[1], ...outcome };
          } else if (m[2] === "inspect") {
            strictKeys(body, []);
            for (const [key, value] of tickets) if (value.expires < Date.now()) tickets.delete(key);
            if (tickets.size >= 20) throw new RegistryError("ENRICH_TICKET_LIMIT", "Apply or allow pending inspections to expire first.");
            const page = await inspectEntry(registry, id, deps);
            const ticket = randomBytes(24).toString("hex");
            tickets.set(ticket, { id, expected: page.expected, observed_at: page.observed_at, expires: Date.now() + 5 * 60000 });
            data = { ref: m[1], ticket, observed_at: page.observed_at, url: page.url, html: page.html, content_role: "untrusted_source_data" };
          } else if (m[2] === "apply") {
            strictKeys(body, ["ticket", "fields"]);
            const ticket = tickets.get(body.ticket);
            if (!ticket || ticket.id !== id || ticket.expires < Date.now()) throw new RegistryError("ENRICH_TICKET_EXPIRED", "Inspect the entry again.");
            const fields = normalizeFields(body.fields, entry.url_original);
            if (!fields.title || Object.keys(fields).length !== Object.keys(body.fields).length) throw new RegistryError("ENRICH_INVALID_FIELDS", "Every submitted field must be valid; title is required.");
            const { id: _id, ...outcome } = applyExtraction(registry, id, ticket.expected, { fields, observed_at: ticket.observed_at, sources: Object.fromEntries(Object.keys(fields).map((k) => [k, "agent:inspected-page"])), missing: missingFields(fields, entry.url_original) });
            tickets.delete(body.ticket);
            data = { ref: m[1], ...outcome };
          } else {
            strictKeys(body, ["ticket", "text"]);
            const ticket = tickets.get(body.ticket);
            if (!ticket || ticket.id !== id || ticket.expires < Date.now()) throw new RegistryError("ENRICH_TICKET_EXPIRED", "Inspect the entry again.");
            const comment = addAgentNote(registry, id, ticket.expected, body.text);
            tickets.delete(body.ticket);
            data = { ref: m[1], comment: { body: comment.body, created_at: comment.created_at } };
          }
        } else throw unavailable();
      }
      reply(200, { ok: true, data });
    } catch (error) {
      // Never send raw DB/network exceptions, URLs, IDs or owner paths to an agent.
      const known = error instanceof RegistryError && error.code.startsWith("ENRICH_");
      const code = known ? error.code : "ENRICH_INTERNAL";
      reply(code === "ENRICH_NOT_AVAILABLE" ? 404 : 400, { ok: false, error: { code } });
    } finally { if (admitted) active--; }
  };
}

function queryBoolean(searchParams, name) {
  if (!searchParams.has(name)) return undefined;
  const value = searchParams.get(name);
  if (["1", "true"].includes(value)) return true;
  if (["0", "false"].includes(value)) return false;
  throw new RegistryError("ENRICH_INVALID_FILTER", `${name} must be true or false.`);
}

module.exports = { createAgentHandler };
