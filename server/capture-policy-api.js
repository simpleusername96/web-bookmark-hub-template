"use strict";

const {
  applyCapturePolicyRule,
  createCapturePolicyRule,
  deleteCapturePolicyRule,
  getCapturePolicy,
  listCapturePolicyRules,
  previewCapturePolicyRule,
  updateCapturePolicy,
  updateCapturePolicyRule
} = require("../registry/capture-policy.js");
const { assertAllowedFields, assertPlainObject } = require("./entries-api.js");

const POLICY_FIELDS = new Set(["visibility", "selected_image_storage"]);
const RULE_FIELDS = new Set([
  "url_prefix", "hostname", "path_prefix", "visibility",
  "enabled", "position", "kind", "tags", "capture_mode"
]);

function updateDefaults(registry, body, options = {}) {
  assertPlainObject(body, "Capture policy body must be an object.");
  assertAllowedFields(body, POLICY_FIELDS);
  return updateCapturePolicy(registry, policyInput(body), options);
}

function createRule(registry, body, options = {}) {
  assertPlainObject(body, "Capture policy rule body must be an object.");
  assertAllowedFields(body, RULE_FIELDS);
  return createCapturePolicyRule(registry, ruleInput(body), options);
}

function updateRule(registry, id, body, options = {}) {
  assertPlainObject(body, "Capture policy rule body must be an object.");
  assertAllowedFields(body, RULE_FIELDS);
  return updateCapturePolicyRule(registry, id, ruleInput(body), options);
}

function deleteRule(registry, id, body) {
  assertEmptyBody(body);
  return deleteCapturePolicyRule(registry, id);
}

function previewRule(registry, id) {
  return previewCapturePolicyRule(registry, id);
}

function applyRule(registry, id, body, options = {}) {
  assertPlainObject(body, "Capture policy apply body must be an object.");
  assertAllowedFields(body, new Set(["reason"]));
  return applyCapturePolicyRule(registry, id, {
    actor: { type: "user", id: options.requesterScope },
    reason: body.reason,
    clock: options.clock || Date
  });
}

function policyInput(body) {
  const result = {};
  if (own(body, "visibility")) result.visibility = body.visibility;
  if (own(body, "selected_image_storage")) result.selectedImageStorage = body.selected_image_storage;
  return result;
}

function ruleInput(body) {
  return {
    ...policyInput(body),
    ...(own(body, "url_prefix") ? { urlPrefix: body.url_prefix } : {}),
    ...(own(body, "hostname") ? { hostname: body.hostname } : {}),
    ...(own(body, "path_prefix") ? { pathPrefix: body.path_prefix } : {}),
    ...(own(body, "enabled") ? { enabled: body.enabled } : {}),
    ...(own(body, "position") ? { position: body.position } : {}),
    ...(own(body, "kind") ? { kind: body.kind } : {}),
    ...(own(body, "capture_mode") ? { captureMode: body.capture_mode } : {}),
    ...(own(body, "tags") ? { tags: body.tags } : {})
  };
}

function assertEmptyBody(body) {
  assertPlainObject(body, "Request body must be an object.");
  assertAllowedFields(body, new Set());
}

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

module.exports = {
  applyRule,
  createRule,
  deleteRule,
  getCapturePolicy,
  listCapturePolicyRules,
  previewRule,
  updateDefaults,
  updateRule
};
