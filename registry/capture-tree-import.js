"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");

const { importCaptureManifest, validateCaptureManifest } = require("./capture-import.js");
const { assertPathOutsideRepository } = require("./database.js");
const { RegistryError } = require("./errors.js");

const MAX_DIRECTORY_DEPTH = 32;
const MAX_VISITED_ENTRIES = 50_000;
const MAX_MANIFESTS = 5_000;

async function importCaptureTree(registry, rootPath, { reportPath, clock = Date } = {}) {
  const root = await resolveDirectory(rootPath);
  const manifests = await discoverManifests(root);
  const validation = [];
  for (const manifestPath of manifests) {
    try {
      await validateCaptureManifest(manifestPath);
      validation.push({ manifestPath });
    } catch (error) {
      validation.push({ error });
    }
  }
  const report = {
    format: "web-bookmark-hub/capture-tree-import/v1",
    completed_at: new clock().toISOString(),
    manifests: { found: manifests.length, attempted: 0, imported: 0, failed: 0 },
    counts: {
      entries_created: 0,
      entries_already_saved: 0,
      local_images_added: 0,
      local_images_repaired: 0,
      remote_references_added: 0,
      items_skipped: 0,
      assets_skipped: 0
    },
    skip_codes: {},
    manifest_failure_codes: {}
  };

  for (const candidate of validation) {
    report.manifests.attempted += 1;
    if (candidate.error) {
      report.manifests.failed += 1;
      increment(report.manifest_failure_codes, safeCode(candidate.error));
      continue;
    }
    try {
      const result = await importCaptureManifest(registry, candidate.manifestPath, { clock, attachAssetsToExisting: true });
      report.manifests.imported += 1;
      mergeCounts(report.counts, result.counts);
      for (const skip of result.skips) increment(report.skip_codes, skip.code || "CAPTURE_SKIP_UNKNOWN");
    } catch (error) {
      report.manifests.failed += 1;
      increment(report.manifest_failure_codes, safeCode(error));
    }
  }

  if (reportPath) await writeSummary(reportPath, report);
  return report;
}

async function discoverManifests(root, {
  maxDirectoryDepth = MAX_DIRECTORY_DEPTH,
  maxVisitedEntries = MAX_VISITED_ENTRIES,
  maxManifests = MAX_MANIFESTS
} = {}) {
  const found = [];
  let visitedEntries = 0;
  async function visit(directory, depth) {
    if (depth > maxDirectoryDepth) {
      throw new RegistryError("CAPTURE_TREE_DEPTH_LIMIT", "Capture tree exceeds the directory depth limit.");
    }
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      visitedEntries += 1;
      if (visitedEntries > maxVisitedEntries) {
        throw new RegistryError("CAPTURE_TREE_ENTRY_LIMIT", "Capture tree exceeds the visited entry limit.");
      }
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(candidate, depth + 1);
      else if (entry.isFile() && entry.name.toLowerCase() === "manifest.json") {
        found.push(candidate);
        if (found.length > maxManifests) {
          throw new RegistryError("CAPTURE_TREE_MANIFEST_LIMIT", "Capture tree exceeds the manifest limit.");
        }
      }
    }
  }
  await visit(root, 0);
  return found;
}

async function resolveDirectory(value) {
  try {
    const resolved = await fsp.realpath(String(value));
    const stat = await fsp.stat(resolved);
    if (!stat.isDirectory()) throw new Error("not directory");
    return resolved;
  } catch {
    throw new RegistryError("CAPTURE_TREE_NOT_FOUND", "Capture tree could not be read.");
  }
}

async function writeSummary(reportPath, report) {
  const resolved = path.resolve(String(reportPath));
  assertPathOutsideRepository(resolved);
  await fsp.mkdir(path.dirname(resolved), { recursive: true });
  try {
    await fsp.writeFile(resolved, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error?.code === "EEXIST") throw new RegistryError("MIGRATION_REPORT_EXISTS", "Migration report already exists.");
    throw error;
  }
}

function mergeCounts(target, source) {
  for (const key of Object.keys(target)) target[key] += Number(source?.[key] || 0);
}

function increment(target, key) {
  target[key] = (target[key] || 0) + 1;
}

function safeCode(error) {
  return error instanceof RegistryError && error.code ? error.code : "CAPTURE_MANIFEST_IMPORT_FAILED";
}

module.exports = {
  MAX_DIRECTORY_DEPTH,
  MAX_MANIFESTS,
  MAX_VISITED_ENTRIES,
  discoverManifests,
  importCaptureTree
};
