"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const { RegistryError } = require("../registry/errors.js");
const { MAX_LOCAL_IMAGE_BYTES } = require("../registry/visual-asset-contract.js");
const {
  isConnectionFailure,
  isPublicAddress,
  requestPinned,
  resolvePublicAddresses
} = require("./public-network.js");

const MAX_IMAGE_BYTES = MAX_LOCAL_IMAGE_BYTES;
const MAX_REDIRECTS = 4;
const REQUEST_TIMEOUT_MS = 20_000;

async function downloadImageToStaging(registry, sourceUrl, options = {}) {
  if (!registry || registry.dbPath === ":memory:" || !registry.dataDir) {
    throw new RegistryError("VISUAL_ASSET_STORAGE_UNAVAILABLE", "Downloaded images require a file-backed Registry database.");
  }
  const initialUrl = imageUrl(sourceUrl);
  const stagingDirectory = path.join(path.resolve(registry.dataDir), "capture-staging");
  const filePath = path.join(stagingDirectory, `${randomUUID()}.download`);
  await fsp.mkdir(stagingDirectory, { recursive: true });
  try {
    const now = typeof options.now === "function" ? options.now : Date.now;
    const context = {
      deadline: now() + positiveLimit(options.timeoutMs, REQUEST_TIMEOUT_MS),
      lookup: options.lookup,
      maxRedirects: positiveLimit(options.maxRedirects, MAX_REDIRECTS),
      now,
      options,
      request: options.request || requestPinned
    };
    const result = await downloadHop(initialUrl, filePath, 0, context);
    return { filePath, byteSize: result.byteSize, finalUrl: result.finalUrl };
  } catch (error) {
    await fsp.rm(filePath, { force: true }).catch(() => {});
    throw normalizeDownloadError(error);
  }
}

async function downloadHop(url, filePath, redirects, context) {
  const addresses = await withinDeadline(
    resolvePublicAddresses(url.hostname, context.lookup), context
  );
  let response;
  let lastError;
  for (let index = 0; index < addresses.length; index += 1) {
    try {
      const timeoutMs = remainingMs(context);
      response = await withinDeadline(context.request({
        url,
        address: addresses[index].address,
        timeoutMs,
        headers: {
          accept: "image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8",
          "accept-encoding": "identity",
          "user-agent": "WebBookmarkHub/0.2"
        }
      }), context, timeoutMs);
      break;
    } catch (error) {
      lastError = error;
      if (!isConnectionFailure(error) || index === addresses.length - 1) throw error;
    }
  }
  if (!response) throw lastError;
  const statusCode = Number(response.statusCode || 0);
  if ([301, 302, 303, 307, 308].includes(statusCode)) {
    response.resume?.();
    if (redirects >= context.maxRedirects) {
      throw new RegistryError("CAPTURE_IMAGE_REDIRECT_LIMIT", "Selected image exceeded the redirect limit.");
    }
    const location = firstHeader(response.headers?.location);
    if (!location) throw new RegistryError("CAPTURE_IMAGE_RESPONSE_INVALID", "Selected image redirect is missing its destination.");
    return downloadHop(imageUrl(new URL(location, url).href), filePath, redirects + 1, context);
  }
  if (statusCode !== 200) {
    response.resume?.();
    throw new RegistryError("CAPTURE_IMAGE_RESPONSE_INVALID", "Selected image server returned an unusable response.");
  }
  const mediaType = firstHeader(response.headers?.["content-type"]).split(";", 1)[0].trim().toLowerCase();
  if (!mediaType.startsWith("image/")) {
    response.resume?.();
    throw new RegistryError("CAPTURE_IMAGE_RESPONSE_INVALID", "Selected image response is not an image.");
  }
  const maxBytes = positiveLimit(context.options.maxBytes, MAX_IMAGE_BYTES);
  const declaredLength = Number(firstHeader(response.headers?.["content-length"]));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    response.destroy?.();
    throw sizeLimitError(context.options);
  }
  const handle = await fsp.open(filePath, "wx");
  let byteSize = 0;
  const transferTimer = setTimeout(() => {
    response.destroy?.(new RegistryError("CAPTURE_IMAGE_TIMEOUT", "Selected image download timed out."));
  }, remainingMs(context));
  try {
    for await (const rawChunk of response) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      byteSize += chunk.length;
      if (byteSize > maxBytes) {
        response.destroy?.();
        throw sizeLimitError(context.options);
      }
      await handle.write(chunk);
    }
    if (byteSize < 1) throw new RegistryError("CAPTURE_IMAGE_RESPONSE_INVALID", "Selected image response is empty.");
  } finally {
    clearTimeout(transferTimer);
    await handle.close();
  }
  return { byteSize, finalUrl: url.href };
}

function sizeLimitError(options) {
  const code = options.sizeErrorCode === "CAPTURE_IMAGE_BATCH_TOO_LARGE"
    ? options.sizeErrorCode
    : "CAPTURE_IMAGE_TOO_LARGE";
  return new RegistryError(code, code === "CAPTURE_IMAGE_BATCH_TOO_LARGE"
    ? "Selected images exceed the local capture limit."
    : "Selected image exceeds the local file limit.");
}

function remainingMs(context) {
  const remaining = Math.ceil(context.deadline - context.now());
  if (remaining < 1) throw new RegistryError("CAPTURE_IMAGE_TIMEOUT", "Selected image download timed out.");
  return remaining;
}

function withinDeadline(promise, context, timeoutMs = remainingMs(context)) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(
      new RegistryError("CAPTURE_IMAGE_TIMEOUT", "Selected image download timed out.")
    ), timeoutMs);
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

function imageUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || "").trim()); } catch { parsed = null; }
  if (!parsed || !["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new RegistryError("CAPTURE_IMAGE_URL_INVALID", "Selected image must use a credential-free HTTP(S) URL.");
  }
  parsed.hash = "";
  return parsed;
}

function firstHeader(value) {
  if (Array.isArray(value)) return String(value[0] || "");
  return String(value || "");
}

function positiveLimit(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeDownloadError(error) {
  if (error instanceof RegistryError) return error;
  return new RegistryError("CAPTURE_IMAGE_DOWNLOAD_FAILED", "Selected image could not be downloaded.");
}

module.exports = {
  MAX_IMAGE_BYTES,
  MAX_REDIRECTS,
  REQUEST_TIMEOUT_MS,
  downloadImageToStaging,
  isPublicAddress,
  resolvePublicAddresses
};
