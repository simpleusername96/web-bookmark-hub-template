const { RegistryError } = require("./errors.js");

const BOOLEAN_OPTIONS = new Set([
  "json",
  "help",
  "clear-title",
  "clear-published-at",
  "clear-updated-at",
  "reset-kind",
  "include-descendants",
  "unfiled",
  "root",
  "allow-new",
  "cover"
]);
const GLOBAL_OPTIONS = new Set(["db", "json", "help"]);

function parseArguments(argv) {
  const positionals = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (argument === "-j") {
      addOption(options, "json", true);
      continue;
    }
    if (argument === "-h") {
      addOption(options, "help", true);
      continue;
    }
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }

    const separator = argument.indexOf("=");
    const key = argument.slice(2, separator === -1 ? undefined : separator);
    if (!key) {
      throw new RegistryError("CLI_ARGUMENT_ERROR", "Invalid empty option name.");
    }
    if (separator !== -1) {
      const inlineValue = argument.slice(separator + 1);
      addOption(options, key, BOOLEAN_OPTIONS.has(key) ? parseBoolean(inlineValue, key) : inlineValue);
      continue;
    }
    if (BOOLEAN_OPTIONS.has(key)) {
      addOption(options, key, true);
      continue;
    }
    if (index + 1 >= argv.length || argv[index + 1].startsWith("--")) {
      throw new RegistryError("CLI_OPTION_VALUE_REQUIRED", `--${key} requires a value.`, {
        option: key
      });
    }
    addOption(options, key, argv[index + 1]);
    index += 1;
  }
  return { positionals, options };
}

function assertAllowedOptions(options, allowed = []) {
  const accepted = new Set([...GLOBAL_OPTIONS, ...allowed]);
  const unknown = Object.keys(options).filter((key) => !accepted.has(key));
  if (unknown.length) {
    throw new RegistryError("CLI_UNKNOWN_OPTION", `Unknown option: --${unknown[0]}.`, {
      option: unknown[0]
    });
  }
}

function optionValue(options, key) {
  const value = options[key];
  return Array.isArray(value) ? value[value.length - 1] : value;
}

function optionValues(options, key) {
  const value = options[key];
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function requireOption(options, key) {
  const value = optionValue(options, key);
  if (value === undefined || value === true || String(value).trim() === "") {
    throw new RegistryError("CLI_OPTION_REQUIRED", `--${key} is required.`, { option: key });
  }
  return value;
}

function requirePositionals(positionals, expected, usage) {
  if (positionals.length !== expected) {
    throw new RegistryError("CLI_ARGUMENT_ERROR", `Usage: ${usage}`, {
      expectedPositionals: expected,
      actualPositionals: positionals.length
    });
  }
}

function addOption(options, key, value) {
  if (options[key] === undefined) {
    options[key] = value;
  } else if (Array.isArray(options[key])) {
    options[key].push(value);
  } else {
    options[key] = [options[key], value];
  }
}

function parseBoolean(value, key) {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new RegistryError("CLI_ARGUMENT_ERROR", `--${key} must be true or false when assigned.`, {
    option: key
  });
}

module.exports = {
  assertAllowedOptions,
  optionValue,
  optionValues,
  parseArguments,
  requireOption,
  requirePositionals
};
