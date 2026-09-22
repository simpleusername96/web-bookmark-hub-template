"use strict";

// Operational observations, not permanent site capabilities or access grants.
// No saved URLs, credentials, browser profiles, or live collection reads here.
const PROFILES = []; // Keep only observations verified in your own environment.

function siteAccessProfile(value) {
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Use an HTTP(S) URL without credentials.");
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const profile = PROFILES.find(item => item.hosts.some(base => host === base || host.endsWith("." + base)));
  return profile ? structuredClone(profile) : {
    id: "unknown", hosts: [host], preferred_method: "inspect_available_context", checked_on: null,
    methods: { direct_http_script: "unverified", existing_browser_tab: "unverified" },
    next_action: "Use an available authorized page or one permitted public metadata/API probe; record the outcome. Template support does not prove network access.",
    retry_when: "New evidence or a changed access context.",
    limitation: "No maintained site-specific access observation."
  };
}

if (require.main === module) {
  try {
    if (process.argv.length !== 3) throw new Error("Usage: node enrichment/site-access.js <url>");
    process.stdout.write(JSON.stringify(siteAccessProfile(process.argv[2]), null, 2) + "\n");
  } catch (error) {
    process.stderr.write(error.message + "\n");
    process.exitCode = 1;
  }
}

module.exports = { siteAccessProfile };
