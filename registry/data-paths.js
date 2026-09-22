"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { RegistryError } = require("./errors");

const ENV_DATABASE_PATH = "WEB_BOOKMARK_HUB_DB";
const REPOSITORY_ROOT = path.resolve(__dirname, "..");

function pathFor(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function resolvedPath(value, pathApi) {
  return pathApi.resolve(String(value));
}

function resolvePathThroughExistingAncestors(candidatePath) {
  let existingPath = path.resolve(String(candidatePath));
  const missingSegments = [];
  while (!fs.existsSync(existingPath)) {
    const parent = path.dirname(existingPath);
    if (parent === existingPath) {
      return path.resolve(String(candidatePath));
    }
    missingSegments.unshift(path.basename(existingPath));
    existingPath = parent;
  }
  const realAncestor = fs.realpathSync.native(existingPath);
  return path.resolve(realAncestor, ...missingSegments);
}

function isPathWithin(rootPath, candidatePath) {
  const root = process.platform === "win32"
    ? path.resolve(rootPath).toLocaleLowerCase("en-US")
    : path.resolve(rootPath);
  const candidate = process.platform === "win32"
    ? path.resolve(candidatePath).toLocaleLowerCase("en-US")
    : path.resolve(candidatePath);
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertPathOutsideRepository(candidatePath) {
  if (candidatePath === ":memory:") return candidatePath;

  const pathApi = /^[A-Za-z]:[\\/]/.test(candidatePath)
    ? path.win32
    : (String(candidatePath).startsWith("/") ? path.posix : path);
  const candidate = resolvedPath(candidatePath, pathApi);
  const repository = resolvedPath(REPOSITORY_ROOT, pathApi);
  const nativePathStyle = process.platform === "win32"
    ? /^[A-Za-z]:[\\/]/.test(candidate)
    : candidate.startsWith("/");
  const boundaryCandidate = nativePathStyle
    ? resolvePathThroughExistingAncestors(candidate)
    : candidate;
  const boundaryRepository = nativePathStyle
    ? resolvePathThroughExistingAncestors(repository)
    : repository;
  const comparisonCandidate = process.platform === "win32"
    ? boundaryCandidate.toLocaleLowerCase("en-US")
    : boundaryCandidate;
  const comparisonRepository = process.platform === "win32"
    ? boundaryRepository.toLocaleLowerCase("en-US")
    : boundaryRepository;
  const relative = pathApi.relative(comparisonRepository, comparisonCandidate);
  const insideRepository = relative === "" || (!relative.startsWith("..") && !pathApi.isAbsolute(relative));

  if (insideRepository) {
    throw new RegistryError(
      "DATA_PATH_IN_REPOSITORY",
      "Registry data must be stored outside the repository.",
      { path: candidate },
    );
  }
  return candidate;
}

function isWithinPath(rootPath, candidatePath, pathApi) {
  const comparisonRoot = pathApi === path.win32
    ? rootPath.toLocaleLowerCase("en-US")
    : rootPath;
  const comparisonCandidate = pathApi === path.win32
    ? candidatePath.toLocaleLowerCase("en-US")
    : candidatePath;
  const relative = pathApi.relative(comparisonRoot, comparisonCandidate);
  return relative === "" || (!relative.startsWith("..") && !pathApi.isAbsolute(relative));
}

function assertRegistryDataPath(candidatePath, options = {}) {
  if (candidatePath === ":memory:") return candidatePath;

  const pathApi = /^[A-Za-z]:[\\/]/.test(candidatePath)
    ? path.win32
    : (String(candidatePath).startsWith("/") ? path.posix : path);
  const repositoryRoot = options.repositoryRoot || REPOSITORY_ROOT;
  const candidate = resolvedPath(candidatePath, pathApi);
  const repository = resolvedPath(repositoryRoot, pathApi);
  const dataDirectory = resolvedPath(pathApi.join(repositoryRoot, "data"), pathApi);
  const nativePathStyle = process.platform === "win32"
    ? /^[A-Za-z]:[\\/]/.test(candidate)
    : candidate.startsWith("/");
  const boundaryCandidate = nativePathStyle
    ? resolvePathThroughExistingAncestors(candidate)
    : candidate;
  const boundaryRepository = nativePathStyle
    ? resolvePathThroughExistingAncestors(repository)
    : repository;
  const boundaryDataDirectory = nativePathStyle
    ? resolvePathThroughExistingAncestors(dataDirectory)
    : dataDirectory;
  const lexicalInsideRepository = isWithinPath(repository, candidate, pathApi);
  const lexicalInsideDataDirectory = isWithinPath(dataDirectory, candidate, pathApi);
  const physicalDataDirectoryIsLocal = isWithinPath(boundaryRepository, boundaryDataDirectory, pathApi);
  const physicalInsideRepository = isWithinPath(boundaryRepository, boundaryCandidate, pathApi);
  const physicalInsideDataDirectory = isWithinPath(boundaryDataDirectory, boundaryCandidate, pathApi);
  const invalidRepositoryLocation =
    (lexicalInsideRepository && !lexicalInsideDataDirectory)
    || (physicalInsideRepository && !physicalInsideDataDirectory)
    || (lexicalInsideDataDirectory && (!physicalDataDirectoryIsLocal || !physicalInsideDataDirectory));

  if (invalidRepositoryLocation) {
    throw new RegistryError(
      "REGISTRY_DATA_PATH_INVALID",
      "Registry data inside the repository must stay under its ignored data directory.",
      { path: candidate, data_directory: dataDirectory },
    );
  }
  return candidate;
}

function resolveDatabasePath(explicitPath, options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const pathApi = pathFor(platform);
  const repositoryRoot = options.repositoryRoot || REPOSITORY_ROOT;
  let databasePath = explicitPath || env[ENV_DATABASE_PATH];

  if (databasePath === ":memory:") {
    return databasePath;
  }

  if (!databasePath) {
    databasePath = pathApi.join(repositoryRoot, "data", "registry.sqlite3");
  }

  const candidate = resolvedPath(databasePath, pathApi);
  return assertRegistryDataPath(candidate, { repositoryRoot });
}

function getApplicationDataDir(dbPath) {
  return `${dbPath}.data`;
}

module.exports = {
  ENV_DATABASE_PATH,
  REPOSITORY_ROOT,
  assertPathOutsideRepository,
  assertRegistryDataPath,
  getApplicationDataDir,
  isPathWithin,
  resolveDatabasePath,
  resolvePathThroughExistingAncestors,
};
