"use strict";

const dns = require("node:dns/promises");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");

const { RegistryError } = require("../registry/errors.js");

const blockedAddresses = new net.BlockList();
[
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]
].forEach(([address, prefix]) => blockedAddresses.addSubnet(address, prefix, "ipv4"));
[
  ["::", 96], ["::1", 128], ["64:ff9b::", 96], ["64:ff9b:1::", 48],
  ["100::", 64], ["2001::", 23], ["2001:db8::", 32], ["2002::", 16],
  ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8]
].forEach(([address, prefix]) => blockedAddresses.addSubnet(address, prefix, "ipv6"));

async function resolvePublicAddresses(hostname, lookup = defaultLookup) {
  const normalizedHostname = normalizeHostname(hostname);
  const literalFamily = net.isIP(normalizedHostname);
  const records = literalFamily
    ? [{ address: normalizedHostname, family: literalFamily }]
    : await lookup(normalizedHostname, { all: true, verbatim: true });
  if (!Array.isArray(records) || records.length === 0) {
    throw new RegistryError("CAPTURE_IMAGE_ADDRESS_UNAVAILABLE", "Selected image host could not be resolved.");
  }
  const normalized = records.map((record) => ({
    address: String(record?.address || ""),
    family: Number(record?.family) || net.isIP(String(record?.address || ""))
  }));
  if (normalized.some((record) => !record.family || !isPublicAddress(record.address))) {
    throw new RegistryError("CAPTURE_IMAGE_ADDRESS_BLOCKED", "Selected image host resolves to a non-public address.");
  }
  return normalized;
}

function isPublicAddress(value) {
  let address = String(value || "").trim().toLowerCase();
  if (address.startsWith("::ffff:")) {
    const mapped = mappedIpv4Address(address.slice(7));
    return Boolean(mapped) && !blockedAddresses.check(mapped, "ipv4");
  }
  const family = net.isIP(address);
  if (family === 4) return !blockedAddresses.check(address, "ipv4");
  if (family === 6) return !blockedAddresses.check(address, "ipv6");
  return false;
}

function requestPinned({ url, address, timeoutMs, headers, method = "GET" }) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const request = client.request(url, {
      method,
      headers,
      lookup(_hostname, options, callback) {
        const family = net.isIP(address);
        if (options?.all) callback(null, [{ address, family }]);
        else callback(null, address, family);
      }
    });
    const timer = setTimeout(() => {
      request.destroy(new RegistryError("CAPTURE_IMAGE_TIMEOUT", "Selected image download timed out."));
    }, timeoutMs);
    request.once("response", (response) => {
      response.once("end", () => clearTimeout(timer));
      response.once("close", () => clearTimeout(timer));
      resolve(response);
    });
    request.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    request.end();
  });
}

function isConnectionFailure(error) {
  return error instanceof RegistryError && error.code === "CAPTURE_IMAGE_TIMEOUT"
    || ["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "EPIPE"]
      .includes(String(error?.code || ""));
}

function normalizeHostname(value) {
  const hostname = String(value || "").trim();
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function mappedIpv4Address(value) {
  if (net.isIP(value) === 4) return value;
  const parts = String(value || "").split(":");
  if (parts.length !== 2 || parts.some((part) => !/^[0-9a-f]{1,4}$/i.test(part))) return null;
  const high = Number.parseInt(parts[0], 16);
  const low = Number.parseInt(parts[1], 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

async function defaultLookup(hostname, options) {
  return dns.lookup(hostname, options);
}

module.exports = { isConnectionFailure, isPublicAddress, requestPinned, resolvePublicAddresses };
