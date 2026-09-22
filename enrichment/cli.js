"use strict";

const { assertAllowedOptions, optionValue, requirePositionals } = require("../registry/cli-args.js");
const { RegistryError } = require("../registry/errors.js");
const { TEMPLATES, requireTemplate } = require("./templates.js");
const { createFromUrl, planEntries, runEntries, validatePlanOptions } = require("./service.js");

async function handleEnrichment(registry, parsed) {
  const command = parsed.positionals[1];
  assertAllowedOptions(parsed.options, ["entry", "url", "site", "limit", "mode", "allow-new"]);
  requirePositionals(parsed.positionals, 2, "registry-cli.js enrich <plan|run|templates> [--entry ID | --url URL] [--site SITE] [--mode pending|retry|refresh] [--limit 20] [--allow-new] --json");
  if (!["plan", "run", "templates"].includes(command)) throw new RegistryError("CLI_ARGUMENT_ERROR", "Unknown enrichment operation.");
  const get = (key) => optionValue(parsed.options, key);
  if (get("entry") !== undefined && get("url") !== undefined) throw new RegistryError("CLI_ARGUMENT_ERROR", "Choose --entry or --url, not both.");
  const options = { entryId: get("entry") === undefined ? undefined : Number(get("entry")), site: get("site"), limit: get("limit") === undefined ? 20 : Number(get("limit")), mode: get("mode") || "pending" };
  if (options.entryId !== undefined && (!Number.isSafeInteger(options.entryId) || options.entryId < 1)) throw new RegistryError("CLI_ARGUMENT_ERROR", "Invalid Entry ID.");
  validatePlanOptions(options);
  if (get("url") && options.site && requireTemplate(get("url")).id !== options.site) throw new RegistryError("CLI_ARGUMENT_ERROR", "URL does not match --site.");
  let data;
  if (command === "templates") data = { templates: TEMPLATES.map(({ id, version, category, kind }) => ({ id, version, category, kind })) };
  else {
    if (get("url")) {
      if (command === "plan") {
        // Even a dry-run must not expose an existing private/blocked URL.
        const { analyzeUrl } = require("../registry/url-policy.js");
        const canonical = analyzeUrl(get("url")).url_canonical;
        const existing = registry.db.prepare("SELECT id FROM entries WHERE url_canonical=? ORDER BY id LIMIT 1").get(canonical);
        if (existing) options.entryId = Number(existing.id);
        else {
          const t = requireTemplate(get("url"));
          return { command: "enrich plan", data: { new_url: true, site: t.id, requires_allow_new: true, items: [] } };
        }
      } else options.entryId = createFromUrl(registry, get("url"), { allowNew: get("allow-new") === true }).id;
    }
    data = command === "plan" ? planEntries(registry, options) : await runEntries(registry, options);
  }
  return { command: `enrich ${command}`, data, exitCode: command === "run" && data.partial ? 2 : 0 };
}

module.exports = { handleEnrichment };
