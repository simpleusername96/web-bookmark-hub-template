#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const http = require("node:http");
const { openRegistry } = require("./registry/database.js");
const { parseArguments, assertAllowedOptions, optionValue, requireOption } = require("./registry/cli-args.js");
const { createAgentHandler } = require("./enrichment/agent-api.js");

function start(argv = process.argv.slice(2)) {
  const { options, positionals } = parseArguments(argv);
  assertAllowedOptions(options, ["token-file", "port", "scope", "allow-new"]);
  if (positionals.length) throw new Error("Unexpected positional argument.");
  const token = fs.readFileSync(requireOption(options, "token-file"), "utf8").trim();
  const port = Number(optionValue(options, "port") || 3043);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535 || port === 3042) throw new Error("Use a dedicated loopback port, not the owner Web port.");
  const registry = openRegistry({ dbPath: requireOption(options, "db") });
  let server;
  try {
    server = http.createServer({ requestTimeout: 20000, headersTimeout: 10000 }, createAgentHandler(registry, {
      token, scope: optionValue(options, "scope") || "metadata", allowNew: optionValue(options, "allow-new") === true
    }));
  } catch (error) { registry.close(); throw error; }
  server.on("error", () => { registry.close(); process.stderr.write("Broker could not bind its configured port.\n"); process.exitCode = 1; });
  server.listen(port, "127.0.0.2", () => process.stdout.write(`Agent broker listening on 127.0.0.2:${port}; OS isolation is required.\n`));
  const close = () => server.close(() => { registry.close(); });
  process.once("SIGINT", close); process.once("SIGTERM", close);
  return server;
}
if (require.main === module) { try { start(); } catch { process.stderr.write("Broker configuration failed. Check the owner runbook.\n"); process.exitCode = 1; } }
module.exports = { start };
