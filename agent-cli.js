#!/usr/bin/env node
"use strict";

const { errorPayload, RegistryError } = require("./registry/errors.js");
const { openRegistry } = require("./registry/database.js");
const {
  addAgentNote,
  agentList,
  agentProjection,
  applyExtraction,
  createFromUrl,
  enrichEntry,
  inspectEntry,
  readEligible
} = require("./enrichment/service.js");
const { missingFields, normalizeFields } = require("./enrichment/extract.js");

const COMMANDS = new Set(["list", "get", "add", "inspect", "run", "apply", "note"]);
const OPAQUE_REF = /^[a-f0-9]{32}$/;
const REVISION = /^[a-f0-9]{64}$/;

async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const selected = selectMode(argv);
  if (selected.broker) return runBroker(selected.args, env, deps);
  return runLocal(selected.args, env, deps);
}

function selectMode(argv) {
  let broker = false;
  let endOptions = false;
  const args = [];
  for (const argument of argv) {
    if (!endOptions && argument === "--broker") {
      if (broker) throw new RegistryError("CLI_ARGUMENT_ERROR", "--broker may be supplied only once.");
      broker = true;
      continue;
    }
    args.push(argument);
    if (argument === "--") endOptions = true;
  }
  return { broker, args };
}

async function runLocal(argv, env, deps) {
  const parsed = parseLocalInvocation(argv);
  const open = deps.openRegistry || openRegistry;
  const registry = open({ dbPath: parsed.dbPath, env });
  try {
    const data = await dispatchLocal(registry, parsed, deps);
    writeJson({ ok: true, data }, deps.stdout);
    return exitCodeFor(data);
  } finally {
    if (registry && typeof registry.close === "function") registry.close();
  }
}

function parseLocalInvocation(argv) {
  const extracted = extractLocalOptions(argv);
  const [command, ...rest] = extracted.args;
  if (!COMMANDS.has(command)) {
    throw new RegistryError(
      "CLI_ARGUMENT_ERROR",
      "Use list [cursor] [filters], get ID, add URL, inspect ID, run ID, apply ID JSON, or note ID JSON."
    );
  }
  if (command === "list") {
    if (extracted.allowNew) {
      throw new RegistryError("CLI_ARGUMENT_ERROR", "--allow-new is only valid with add.");
    }
    return { command, list: parseListArgs(rest, "local"), ...extracted };
  }
  if (command === "add") {
    if (rest.length !== 1 || !rest[0]) throw new RegistryError("CLI_ARGUMENT_ERROR", "URL is required.");
    if (extracted.allowNew !== true) {
      throw new RegistryError(
        "ENRICH_NEW_URL_REQUIRES_CONSENT",
        "Use --allow-new to create a new Normal/full-AI Entry."
      );
    }
    return { command, url: rest[0], ...extracted };
  }
  if (extracted.allowNew) {
    throw new RegistryError("CLI_ARGUMENT_ERROR", "--allow-new is only valid with add.");
  }
  const expectedArgs = ["apply", "note"].includes(command) ? 2 : 1;
  if (rest.length !== expectedArgs) {
    throw new RegistryError(
      "CLI_ARGUMENT_ERROR",
      rest.length > expectedArgs ? "Too many arguments." : "A reference is required."
    );
  }
  const id = parseLocalId(rest[0]);
  const result = { command, id, ...extracted };
  if (expectedArgs === 2) result.body = parseJsonObject(rest[1]);
  return result;
}

function extractLocalOptions(argv) {
  let dbPath;
  let allowNew = false;
  let endOptions = false;
  const args = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!endOptions && argument === "--") {
      args.push(...argv.slice(index));
      break;
    }
    if (!endOptions && argument === "--allow-new") {
      allowNew = true;
      continue;
    }
    if (!endOptions && argument === "--db") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) {
        throw new RegistryError("CLI_OPTION_VALUE_REQUIRED", "--db requires a value.", { option: "db" });
      }
      dbPath = value;
      continue;
    }
    if (!endOptions && argument.startsWith("--db=")) {
      const value = argument.slice("--db=".length);
      if (!value) throw new RegistryError("CLI_OPTION_REQUIRED", "--db requires a value.", { option: "db" });
      dbPath = value;
      continue;
    }
    args.push(argument);
  }
  return { args, dbPath, allowNew };
}

async function dispatchLocal(registry, parsed, deps) {
  if (parsed.command === "list") {
    const list = parsed.list;
    return agentList(registry, {
      after: list.cursor === undefined ? 0 : parseLocalCursor(list.cursor),
      limit: parseLocalLimit(list.limit),
      savedFrom: list.savedFrom,
      note: list.note,
      enrichable: list.enrichable
    });
  }
  if (parsed.command === "get") {
    return agentProjection(readEligible(registry, parsed.id, "read"));
  }
  if (parsed.command === "add") {
    return agentProjection(createFromUrl(registry, parsed.url, { allowNew: true }));
  }
  if (parsed.command === "run") return enrichEntry(registry, parsed.id, serviceOptions(deps));
  if (parsed.command === "inspect") return inspectEntry(registry, parsed.id, serviceOptions(deps));
  if (parsed.command === "apply") return applyLocal(registry, parsed.id, parsed.body, deps);
  if (parsed.command === "note") return noteLocal(registry, parsed.id, parsed.body);
  throw new RegistryError("CLI_ARGUMENT_ERROR", "Unknown agent operation.");
}

function applyLocal(registry, id, body, deps) {
  assertBodyKeys(body, ["expected", "observed_at", "fields"]);
  assertExpected(body.expected);
  if (typeof body.observed_at !== "string" || !Number.isFinite(Date.parse(body.observed_at))) {
    throw new RegistryError("ENRICH_INVALID_FIELDS", "observed_at must be a valid timestamp.");
  }
  const entry = readEligible(registry, id, "enrich", body.expected);
  const fields = normalizeFields(body.fields, entry.url_original);
  if (!fields.title || Object.keys(fields).length !== Object.keys(body.fields).length) {
    throw new RegistryError("ENRICH_INVALID_FIELDS", "Every submitted field must be valid; title is required.");
  }
  return applyExtraction(
    registry,
    id,
    body.expected,
    {
      fields,
      observed_at: body.observed_at,
      sources: Object.fromEntries(Object.keys(fields).map((key) => [key, "agent:inspected-page"])),
      missing: missingFields(fields, entry.url_original)
    },
    serviceOptions(deps)
  );
}

function noteLocal(registry, id, body) {
  assertBodyKeys(body, ["expected", "text"]);
  assertExpected(body.expected);
  const comment = addAgentNote(registry, id, body.expected, body.text);
  return {
    id,
    comment: { body: comment.body, created_at: comment.created_at }
  };
}

function parseJsonObject(value) {
  let body;
  try {
    body = JSON.parse(value);
  } catch {
    throw new RegistryError("ENRICH_INVALID_REQUEST", "JSON body is invalid.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new RegistryError("ENRICH_INVALID_REQUEST", "JSON body must be an object.");
  }
  return body;
}

function assertBodyKeys(body, keys) {
  if (Object.keys(body).some((key) => !keys.includes(key))) {
    throw new RegistryError("ENRICH_INVALID_REQUEST", "Unsupported request fields.");
  }
}

function assertExpected(value) {
  if (typeof value !== "string" || !REVISION.test(value)) {
    throw new RegistryError(
      "ENRICH_INVALID_REQUEST",
      "expected must be a non-empty 64-character hexadecimal revision."
    );
  }
}

function serviceOptions(deps) {
  const options = {};
  if (typeof deps.fetchPage === "function") options.fetchPage = deps.fetchPage;
  if (deps.now !== undefined) options.now = deps.now;
  return options;
}

function parseLocalId(value) {
  if (!/^[1-9]\d*$/.test(value || "")) {
    throw new RegistryError("CLI_ARGUMENT_ERROR", "Use a numeric Entry ID.");
  }
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new RegistryError("CLI_ARGUMENT_ERROR", "Entry ID is outside the safe numeric range.");
  }
  return id;
}

function parseLocalCursor(value) {
  if (!/^(?:0|[1-9]\d*)$/.test(value || "")) {
    throw new RegistryError("CLI_ARGUMENT_ERROR", "Use a numeric cursor returned by list.");
  }
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new RegistryError("CLI_ARGUMENT_ERROR", "Cursor is outside the safe numeric range.");
  }
  return cursor;
}

function parseLocalLimit(value) {
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new RegistryError("ENRICH_INVALID_LIMIT", "Invalid page limits.");
  }
  return limit;
}

function parseListArgs(args, mode) {
  let cursor;
  let savedFrom;
  let note;
  let limit = mode === "local" ? "50" : undefined;
  let enrichable = false;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--enrichable") {
      enrichable = true;
      continue;
    }
    const queryName = { "--saved-from": "savedFrom", "--note": "note", "--limit": "limit" }[value];
    if (queryName) {
      const next = args[++index];
      if (!next || next.startsWith("--")) {
        throw new RegistryError("CLI_OPTION_VALUE_REQUIRED", value + " requires a value.", { option: queryName });
      }
      if (queryName === "savedFrom") savedFrom = next;
      if (queryName === "note") note = next;
      if (queryName === "limit") limit = next;
      continue;
    }
    if (value.startsWith("--")) {
      throw new RegistryError("CLI_UNKNOWN_OPTION", "Unsupported list option: " + value + ".", { option: value.slice(2) });
    }
    if (cursor !== undefined) throw new RegistryError("CLI_ARGUMENT_ERROR", "Too many arguments.");
    cursor = value;
  }
  if (mode === "broker" && cursor !== undefined && !OPAQUE_REF.test(cursor)) {
    throw new Error("Use an opaque ref returned by list or add.");
  }
  if (mode === "local" && cursor !== undefined) parseLocalCursor(cursor);
  return { cursor, savedFrom, note, limit, enrichable };
}

function writeJson(value, stream = process.stdout) {
  stream.write(JSON.stringify(value, null, 2) + "\n");
}

function exitCodeFor(data) {
  if (data?.partial === true) return 2;
  if (data?.status && data.status !== "complete") return 2;
  return 0;
}

async function runBroker(argv, env, deps) {
  if (argv.some((value) => value === "--allow-new" || value === "--db" || value.startsWith("--db="))) {
    throw new Error("Broker mode does not accept local options.");
  }
  const [command, ...args] = argv;
  if (!COMMANDS.has(command)) throw new Error("Use list [cursor] [filters], get REF, add URL, inspect REF, run REF, apply REF JSON, or note REF JSON.");
  let ref;
  let arg;
  let suffix;
  if (command === "list") {
    suffix = listSuffix(args);
  } else if (command === "add") {
    if (args.length !== 1 || !args[0]) throw new Error("URL is required.");
    ref = args[0];
    suffix = "/v1/entries";
  } else {
    const expectedArgs = ["apply", "note"].includes(command) ? 2 : 1;
    if (args.length !== expectedArgs) throw new Error(args.length > expectedArgs ? "Too many arguments." : "A reference is required.");
    [ref, arg] = args;
    if (!OPAQUE_REF.test(ref || "")) throw new Error("Use an opaque ref returned by list or add.");
    const operation = command === "note" ? "comments" : command;
    suffix = "/v1/entries/" + encodeURIComponent(ref) + (command === "get" ? "" : "/" + operation);
  }
  const base = new URL(env.WBH_AGENT_URL || "http://127.0.0.2:3043");
  if (base.protocol !== "http:" || base.hostname !== "127.0.0.2" || base.username || base.password || !base.port || base.port === "3042" || base.pathname !== "/" || base.search || base.hash) {
    throw new Error("Use the dedicated loopback agent broker.");
  }
  const token = env.WBH_AGENT_TOKEN;
  if (!token || token.length < 32) throw new Error("Set WBH_AGENT_TOKEN (agent credential only).");
  let body;
  if (command === "add") body = { url: ref };
  if (["run", "inspect"].includes(command)) body = {};
  if (["apply", "note"].includes(command)) {
    try {
      body = JSON.parse(arg);
    } catch {
      throw new Error("JSON body is invalid.");
    }
  }
  const fetchImpl = deps.fetch || fetch;
  const response = await fetchImpl(new URL(suffix, base), {
    method: body === undefined ? "GET" : "POST",
    redirect: "error",
    signal: AbortSignal.timeout(20000),
    headers: { authorization: "Bearer " + token, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const result = await response.json();
  writeJson(result, deps.stdout);
  return result.ok ? result.data?.status && result.data.status !== "complete" ? 2 : 0 : 1;
}

function listSuffix(args) {
  const parsed = parseListArgs(args, "broker");
  const query = new URLSearchParams();
  if (parsed.cursor !== undefined) query.set("after", parsed.cursor);
  if (parsed.savedFrom !== undefined) query.set("saved_from", parsed.savedFrom);
  if (parsed.note !== undefined) query.set("note", parsed.note);
  if (parsed.limit !== undefined) query.set("limit", parsed.limit);
  if (parsed.enrichable) query.set("enrichable", "true");
  const encoded = query.toString();
  return "/v1/entries" + (encoded ? "?" + encoded : "");
}

if (require.main === module) {
  const cliArgs = process.argv.slice(2);
  main(cliArgs).then(
    (code) => { process.exitCode = code; },
    (error) => {
      if (cliArgs.includes("--broker")) {
        process.stderr.write("Agent request failed. Check arguments, broker access and the runbook.\n");
      } else {
        writeJson({ ok: false, ...errorPayload(error) });
      }
      process.exitCode = 1;
    }
  );
}

module.exports = { main, parseListArgs };
