#!/usr/bin/env node

const { executeCli } = require("./registry/cli.js");
const { errorPayload } = require("./registry/errors.js");
const { optionValue, parseArguments } = require("./registry/cli-args.js");

async function main(argv = process.argv.slice(2), streams = {}) {
  const stdout = streams.stdout || process.stdout;
  const stderr = streams.stderr || process.stderr;
  const env = streams.env || process.env;
  // Retain structured error output if malformed arguments cannot be parsed.
  let jsonMode = argv.includes("--json") || argv.includes("-j") ||
    argv.some((value) => value.startsWith("--json="));
  try {
    jsonMode = optionValue(parseArguments(argv).options, "json") === true;
    const result = await executeCli(argv, { env });
    if (result.command === "help" && !jsonMode) {
      stdout.write(`${result.data.help}\n`);
    } else if (jsonMode) {
      stdout.write(`${JSON.stringify({ ok: true, data: result.data }, null, 2)}\n`);
    } else {
      stdout.write(`${formatHuman(result.command, result.data)}\n`);
    }
    return result.exitCode || 0;
  } catch (error) {
    const failure = { ok: false, ...errorPayload(error) };
    if (jsonMode) {
      stdout.write(`${JSON.stringify(failure, null, 2)}\n`);
    } else {
      stderr.write(`Error [${failure.error.code}]: ${failure.error.message}\n`);
    }
    return 1;
  }
}

function formatHuman(command, data) {
  if (command === "init") {
    return `Registry ready (schema ${data.schema_version})\nDatabase: ${data.db_path}\nFiles: ${data.data_dir}`;
  }
  if (command === "add") {
    const action = data.outcome_code === "already_saved" ? "Already saved as" : "Added";
    return `${action} Entry ${data.entry.id} · ${data.entry.kind} · ${data.entry.provider}`;
  }
  if (command === "list") {
    const lines = data.items.map((entry) => (
      `[${entry.id}] ${entry.saved_at} · ${entry.kind} · ${entry.provider} · ${entry.title || entry.url_original}`
    ));
    return [...lines, `Page ${data.page}/${data.total_pages || 0} · ${data.total} entries`].join("\n");
  }
  if (command === "snapshots remove") {
    return `Removed snapshot ${data.id}${data.file_removed ? " and its file" : " (file was already missing)"}.`;
  }
  return JSON.stringify(data, null, 2);
}

if (require.main === module) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}

module.exports = {
  formatHuman,
  main
};
