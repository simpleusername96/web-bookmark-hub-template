const { RegistryError } = require("./errors.js");
const { DEFAULT_PAGE, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } = require("./constants.js");

const MAX_TITLE_LENGTH = 1000;
const MAX_COMMENT_LENGTH = 20000;
const MAX_TAG_LENGTH = 80;
const MAX_METADATA_BYTES = 65536;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/i;

function requireText(value, field, { maxLength = 20000 } = {}) {
  const text = String(value ?? "").trim();
  if (!text) {
    throw new RegistryError("VALIDATION_ERROR", `${field} is required.`, { field });
  }
  if (text.length > maxLength) {
    throw new RegistryError("VALIDATION_ERROR", `${field} is too long.`, {
      field,
      maxLength
    });
  }
  return text;
}

function optionalText(value, field, { maxLength = MAX_TITLE_LENGTH } = {}) {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  const text = String(value).trim();
  if (!text) {
    return null;
  }
  if (text.length > maxLength) {
    throw new RegistryError("VALIDATION_ERROR", `${field} is too long.`, {
      field,
      maxLength
    });
  }
  return text;
}

function normalizeTimestamp(value, field, { optional = false, endOfDay = false } = {}) {
  if (value === undefined || value === null || String(value).trim() === "") {
    if (optional) {
      return null;
    }
    throw new RegistryError("VALIDATION_ERROR", `${field} is required.`, { field });
  }

  const text = String(value).trim();
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(text);
  if ((!dateOnly && !ISO_TIMESTAMP.test(text)) || !hasValidCalendarDate(text)) {
    throw new RegistryError("VALIDATION_ERROR", `${field} must be an ISO date or timestamp.`, {
      field
    });
  }
  const parsed = new Date(dateOnly
    ? `${text}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`
    : text);
  if (!Number.isFinite(parsed.getTime())) {
    throw new RegistryError("VALIDATION_ERROR", `${field} must be an ISO date or timestamp.`, {
      field,
      value: "invalid"
    });
  }
  return parsed.toISOString();
}

function hasValidCalendarDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const normalized = new Date(Date.UTC(year, month - 1, day));
  return normalized.getUTCFullYear() === year &&
    normalized.getUTCMonth() === month - 1 &&
    normalized.getUTCDate() === day;
}

function nowIso(clock = Date) {
  const value = typeof clock === "function" ? clock() : clock.now();
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new RegistryError("INTERNAL_ERROR", "The configured clock returned an invalid timestamp.");
  }
  return parsed.toISOString();
}

function normalizeMetadata(value) {
  if (value === undefined) {
    return undefined;
  }

  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      throw new RegistryError("VALIDATION_ERROR", "typed_metadata must be valid JSON.", {
        field: "typed_metadata"
      });
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RegistryError("VALIDATION_ERROR", "typed_metadata must be a JSON object.", {
      field: "typed_metadata"
    });
  }

  const json = JSON.stringify(parsed);
  if (Buffer.byteLength(json, "utf8") > MAX_METADATA_BYTES) {
    throw new RegistryError("VALIDATION_ERROR", "typed_metadata is too large.", {
      field: "typed_metadata",
      maxBytes: MAX_METADATA_BYTES
    });
  }
  return parsed;
}

function parseStoredJson(value, fallback) {
  try {
    return JSON.parse(String(value ?? ""));
  } catch (error) {
    return fallback;
  }
}

function normalizePagination(input = {}) {
  const page = positiveInteger(input.page ?? DEFAULT_PAGE, "page");
  const pageSize = positiveInteger(input.pageSize ?? DEFAULT_PAGE_SIZE, "page_size");
  if (pageSize > MAX_PAGE_SIZE) {
    throw new RegistryError("VALIDATION_ERROR", `page_size must be at most ${MAX_PAGE_SIZE}.`, {
      field: "page_size",
      max: MAX_PAGE_SIZE
    });
  }
  return {
    page,
    pageSize,
    offset: (page - 1) * pageSize
  };
}

function positiveInteger(value, field) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new RegistryError("VALIDATION_ERROR", `${field} must be a positive integer.`, {
      field,
      value
    });
  }
  return parsed;
}

function entryId(value, field = "entry_id") {
  return positiveInteger(value, field);
}

function normalizeTagName(value) {
  const name = requireText(value, "tag", { maxLength: MAX_TAG_LENGTH }).replace(/\s+/g, " ");
  return {
    name,
    normalizedName: name.toLocaleLowerCase("en-US")
  };
}

module.exports = {
  MAX_COMMENT_LENGTH,
  MAX_METADATA_BYTES,
  MAX_TAG_LENGTH,
  MAX_TITLE_LENGTH,
  entryId,
  normalizeMetadata,
  normalizePagination,
  normalizeTagName,
  normalizeTimestamp,
  nowIso,
  optionalText,
  parseStoredJson,
  positiveInteger,
  requireText
};
