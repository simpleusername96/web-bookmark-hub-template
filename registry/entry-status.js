"use strict";

function activeEntryPredicate(alias = "entries") {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
    throw new TypeError("Entry table alias must be a SQL identifier.");
  }
  return `${alias}.deleted_at IS NULL`;
}

module.exports = { activeEntryPredicate };
