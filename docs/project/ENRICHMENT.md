# Link enrichment

Use the repository-local enrich-links skill for requested exploration, metadata refresh and organization. Supported local interfaces are Registry modules, `registry-cli.js`, and `agent-cli.js`. Check each command's `--help` or source before inventing arguments.

Read only authorized Normal entries. Private entries are excluded, including their URLs. Preserve original URLs, authored titles, notes, selected covers, tags and folders unless the user explicitly authorizes changing them.

A quick pass should produce a useful concise title when missing, a short summary, and an obvious representative preview when available. Inspect the exact source item; do not invent facts from an inaccessible page. Record compact errors and stop repeating an unchanged failed access method. Respect site access boundaries.

Use bounded source evidence transiently. Do not save remote page bodies, PDFs, video/audio, credentials or browsing state. Metadata and selected previews belong under `data/`, never in Git.

The default `agent-cli.js` preset works locally. Its optional `--broker` mode requires a separately configured broker and is not a claim of installed host isolation. Never bypass an entry's visibility policy through direct SQL or owner APIs.

For organization, present proposed folder/tag changes when the user has not already authorized their application. Before writing, recheck the entry's URL, visibility and relevant authored fields. Reuse canonical URLs without overwriting existing metadata.
