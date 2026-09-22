# Codex guide

This template helps a person collect web sources and retrieve them later. Start from the user's purpose: a paper reading list, a reference library, a collection of posts, or another explicitly described workflow. Keep and change only the features that serve that purpose. The current app is a starting point, not a requirement to reproduce every feature.

Read [PROJECT.md](PROJECT.md) for product and data boundaries, then [SETUP.md](SETUP.md) for startup and extension pairing. The Korean [README](../README.md) is the default introduction; [README.en.md](../README.en.md) is its English counterpart.

## Features and why they exist

| Feature | What it does | Why it exists |
| --- | --- | --- |
| Current-page capture | Saves a URL from the popup, web form or Chrome shortcut; reuses an existing canonical entry | Collect material while reading without creating duplicate cards |
| Selected-image capture | On supported capture templates, retains only the images the user selected | Preserve useful visual references without collecting an entire page |
| AI title and summary | Uses the configured Codex CLI to summarize evidence from the exact saved item | Recognize a source without reopening every URL |
| Covers and snapshots | Shows a selected image, representative thumbnail or shortcut page snapshot above the title | Make sources recognizable when scanning cards |
| Capture Rules | Sets visibility, content type and additive default tags by hostname, path and save method | Avoid choosing the same defaults for each source |
| Folders and tags | Gives an entry one folder and multiple tags; supports batch edits | Separate a stable filing structure from overlapping topics |
| Search and views | Combines text search and filters; Grid is general, Feed requires covers, List excludes covers | Retrieve saved metadata and browse by the kind of preview available |
| Notes and revisions | Keeps notes separate from summaries and records material edits while an entry exists | Preserve the user's own context and the history of a change |
| AI visibility | Normal allows supported AI workflows; Private excludes the entry and its URL | Let the user choose which material AI can process |
| Local storage and backup | Stores SQLite and bounded previews under ignored `data/` | Keep ownership of the collection and move it with its local assets |

Original pages stay at their source. This is not a full-page archive. MCP, watched feeds, scheduled collection, semantic search and automatic AI folder/tag classification are not shipped features.

## First interaction with the user

1. Use the purpose and required features already supplied. Ask only about material gaps, such as which sites and output fields matter.
2. Work in the user's own clone/template copy. Inspect its instructions, current changes, Node version and local port policy before setup.
3. Follow SETUP for the server, Codex CLI and Chrome connection. Explain the first useful workflow rather than asking the user to run a long list of setup commands.
4. Configure Normal only for sources the user wants AI to process; do not make an entire existing library AI-readable implicitly.
5. Verify saving and retrieval with isolated synthetic data. Use authored summary fixtures for tests. Do not start a live model run unless the user authorized that run.
6. Explain the features kept or changed, where their rules live, and how the user can request the next adaptation.

## What automatic organization actually does

The current runner pins `gpt-5.6-luna` and reasoning effort `max` in `registry/constants.js`. Verify that the installed CLI/account can use that configuration; never silently switch models.

- **Trigger:** `Ctrl+Shift+E` saves first, then queues the exact Normal entry if it has no summary. Popup/web saves do not automatically run AI. An explicit selection plus **AI summary** can retry or refresh. Settings handles eligible first attempts.
- **Evidence:** Project code acquires bounded evidence from the exact URL or shortcut page context. The model receives that evidence; its prompt forbids browsing, tool use and invented details. A PDF supplies only its first page transiently.
- **Title:** The prompt requests a concrete Korean title of 3–120 characters when missing. Existing substantive titles are preserved. Research titles use the visible paper title and retain its meaning and distinctive terms.
- **Summary:** The prompt requests one Korean sentence of 20–240 characters about the exact saved item. Relevant names and technical terms remain; site navigation, profile biographies and recommendations do not become the item's content.
- **Thumbnail:** Image selection and downloading belong to project code, not the model. Preserve existing local assets; use an explicitly selected remote cover or the exact item's extracted representative image/poster when appropriate. The shortcut uses its viewport snapshot when there is no local image or image URL candidate. A failed image download does not automatically guarantee a snapshot fallback. Manual URL summary runs do not acquire a browser snapshot.
- **Write:** Recheck entry eligibility and unchanged input before persisting. Store a summary, fill an eligible missing title, and append a summary note only if the entry has no notes. Preserve authored metadata. Folder/tag classification is separate; Capture Rules can add default tags at save time.

Read [ai-summary-prompt.md](../enrichment/ai-summary-prompt.md), [the output schema](../enrichment/ai-summary-output.schema.json) and [the runner](../server/ai-url-summary.js) together before changing the output contract. UI language does not select the summary language.

## Three kinds of rules

### 1. Capture defaults: how a URL is saved

Use the app's **Rules** screen for hostname/path rules with:

- `visibility`: `normal` or `private`;
- `kind`: an optional content type;
- `tags`: additive default tags;
- `capture_mode`: `all`, `page` or `selected_images`.

Example configurations a user can create:

| Scope | Save method | Content type | Tags |
| --- | --- | --- | --- |
| `arxiv.org/abs/` | Page | `research` | `paper` |
| `x.com/` | Page | `post` | `ideas` |
| `linkedin.com/posts/` | Page | `post` | `work` |

These are configuration examples, not installed presets or claims that every site's content can be extracted.

An explicit capture override wins over the deepest enabled matching rule, then global defaults, then the built-in fallback. At the same hostname/path depth, the matching save-method-specific rule wins over `all`. The winner contributes its tags; parent-rule tags are not automatically merged. New captures receive the rule. Applying it to old entries requires a preview and explicit user authority for the resulting changes.

Rules do not contain custom AI prompts, assign folders, or store a per-site image-download setting. Selected-image storage is a global default. Do not describe those as existing rule fields.

### 2. Extraction: what to read from a website

- [profiles.js](../profiles.js) and [candidate-extractor.js](../extension/candidate-extractor.js) discover selectable browser images and their logical entry URLs.
- [public-evidence.js](../enrichment/public-evidence.js) extracts the title, relevant content and image candidate used by automatic summaries.
- [templates.js](../enrichment/templates.js) and [extract.js](../enrichment/extract.js) own the separate reusable metadata-enrichment templates.

A URL can be saved without a site-specific extraction template. Selected-image support and rich evidence extraction depend on the page and the implemented adapter. Add a small adapter with synthetic fixtures for a requested site; do not fabricate successful extraction or repurpose unrelated navigation/profile content.

### 3. AI criteria: how evidence is summarized

Edit [ai-summary-prompt.md](../enrichment/ai-summary-prompt.md) for the summary language, emphasis and title criteria. Keep the schema and validation consistent if fields or length limits change. Site-specific AI criteria require an explicit prompt/code adaptation; they are not a hidden feature of the Rules screen.

For example, a paper library might ask for the research question and main contribution when supported by the supplied abstract. A product reference library might emphasize the exact item's purpose and verified specifications. Do not require conclusions that are absent from the evidence.

## Where to change a feature

| Desired change | Maintained owner |
| --- | --- |
| Saving, shortcut behavior, extension UI | `service-worker.js`, `popup.*`, `extension/` |
| Rule matching and defaults | `registry/capture-policy.js`, `server/capture-policy-api.js`, Rules UI in `web/` |
| Automatic evidence, preview and summary flow | `enrichment/public-evidence.js`, `server/ai-url-summary.js` |
| Summary language and output | `enrichment/ai-summary-prompt.md`, `enrichment/ai-summary-output.schema.json` |
| Model/effort | `registry/constants.js`; also inspect `registry/schema.js` constraints and affected tests before changing the pin |
| Fields, canonical URLs, folders, tags and history | `registry/`; keep API, CLI and UI projections aligned |
| Card layout, detail, filters and translations | `web/` |
| Agent metadata operations | `agent-cli.js`, `enrichment/service.js`, [ENRICHMENT.md](project/ENRICHMENT.md) |
| Local server and authentication | `registry-server.js`, `server/` |
| Synthetic examples | `examples/`, `scripts/seed-demo.js` |

Prefer existing owners over a parallel store, duplicate rule engine or catch-all module. Templates discover capture facts; Registry code decides persistence and AI policy.

## Existing commands for Codex

Run from the repository root. Replace placeholders; keep an explicit task-approved DB path when working with a separate library.

```sh
# Owner CLI command reference; this does not start a model run.
node registry-cli.js help

# Agent reads: only entries allowed by the supported AI policy.
node agent-cli.js list --limit 20 --db ./data/registry.sqlite3
node agent-cli.js get <entry-id> --db ./data/registry.sqlite3

# Create 20 synthetic entries in a NEW isolated DB; refuses an existing file.
node scripts/seed-demo.js

# Verify maintained JavaScript, manifest and tests without live AI calls.
node scripts/verify.js
```

`agent-cli.js` provides `list`, `get`, `add`, `inspect`, `run`, `apply` and `note`; it does not implement a `--help` command. Read its parser before constructing write arguments. Its `run` command performs supported metadata extraction; it is not the Luna summary runner. Follow [ENRICHMENT.md](project/ENRICHMENT.md) and the local enrich-links skill for user-authorized link work.

For a user-authorized live summary of one entry, the owner runner is:

```sh
node scripts/run-ai-url-summary.js --entry <entry-id> --db ./data/registry.sqlite3
```

This command invokes the configured model and can incur usage. Do not execute it as a setup check or test. Omitting `--entry` can select multiple pending entries. Do not confuse the owner CLI's `summaries create-job` with a model invocation: that command only creates a Registry job.

Use Registry modules or the owner CLI only within the user's authorized operation; never bypass Private policy with direct SQL. Keep original URLs, notes, previews, exports, credentials and browser state out of Git. Back up the DB and its adjacent `.data` tree together.

## Verification and handoff

For documentation-only work, verify local links, command syntax against source, and the diff. For code changes, run `node scripts/verify.js` and `git diff --check`; exercise changed browser interactions with synthetic data because the inherited extension still needs browser verification. Preserve the user's desktop focus.

Update the README for changed user behavior, this guide for changed feature ownership or adaptation points, and PROJECT for changed product boundaries. Report what was changed and verified without presenting planned features as implemented.
