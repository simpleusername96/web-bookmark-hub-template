'use strict';

class RegistryError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'RegistryError';
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

function registryError(code, message, details) {
  return new RegistryError(code, message, details);
}

function assertRegistry(condition, code, message, details) {
  if (!condition) {
    throw registryError(code, message, details);
  }
}

function errorPayload(error) {
  if (error instanceof RegistryError) {
    const payload = { code: error.code, message: error.message };
    if (error.details !== undefined) {
      payload.details = error.details;
    }
    return { error: payload };
  }
  return { error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' } };
}

module.exports = { RegistryError, registryError, assertRegistry, errorPayload };
