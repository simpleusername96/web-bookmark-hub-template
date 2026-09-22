# Setup reference

Use this reference when preparing a user's copy in Codex. Read `docs/PROJECT.md` for data and behavior boundaries. Ask about the intended use, then adapt the template to that use.

## Runtime

- Node.js **24.19.0 or later**, Chrome, and Git. No app npm dependencies or build step.
- Windows is the primary verified environment. macOS/Linux have not received equivalent end-to-end verification.
- Start from the repository root:

```sh
node registry-server.js --host 127.0.0.1 --port 3042 --db ./data/registry.sqlite3
```

Keep the process running. Open `http://127.0.0.1:3042/`; the extension expects this exact origin. A new DB starts empty. Inspect the user's local server/port rules before starting a process; never replace an unrelated listener.

## Codex CLI

Automatic summaries require a separately installed, signed-in CLI. See the [official CLI guide](https://learn.chatgpt.com/docs/codex/cli).

```sh
npm install -g @openai/codex
codex
```

On Windows, `codexInvocation` in `server/ai-url-summary.js` expects `node_modules/@openai/codex/bin/codex.js` beside the Node executable. Check that path; custom npm prefixes or standalone installations may require adapting this launcher. macOS/Linux resolve `codex` from PATH.

The runner uses the model/effort in `registry/constants.js`: currently `gpt-5.6-luna` / `max`. Verify account access instead of silently substituting a model. `enrichment/ai-summary-prompt.md` controls the summary language and format; it defaults to Korean independently of the UI language. Do not launch model calls during setup without the user's authorization.

## Chrome and AI defaults

1. Guide the user to load the repository folder through `chrome://extensions` → Developer mode → Load unpacked.
2. In the extension, click **Web UI에서 연결**; in the web app, click **Approve connection**.
3. Check `chrome://extensions/shortcuts` for a conflicting shortcut.
4. New databases default to **Private**. For new AI-eligible saves, select **Rules → Defaults → Normal (local)** and save. Normal means local AI eligibility, not public sharing. Matching site/path rules can override the default.

`Ctrl+Shift+E` saves first and queues a summary for an eligible Normal entry without one. The popup save and Web Add URL save links without automatically summarizing. Existing entries require their own visibility change and explicit **AI summary** action; changing Defaults is not retroactive. Existing authored titles and notes are preserved. Folder/tag classification is a separate user or requested Codex operation.

Check **Settings → AI** for progress. If an entry appears missing, clear the initial Normal filter. For a retry or refresh, select the entry and use **AI summary**.

## Data and customization

Data stays under Git-ignored `data/`. Back up the SQLite file and its adjacent `.data` directory together. Never commit user links, exports, previews or credentials. The app keeps pointers and bounded previews, not whole-page archives. AI processing sends relevant evidence through Codex; Private is an application policy rather than filesystem isolation.

Use `web/` for the interface, `registry/` for fields and organization, `extension/` for capture, and `enrichment/` for summary behavior. Run `node scripts/verify.js` after code changes.

For an optional separate library, `node scripts/seed-demo.js` creates 20 synthetic records in `data/demo.sqlite3` and refuses to overwrite an existing DB. Point the startup command at that file to browse it without model calls.
