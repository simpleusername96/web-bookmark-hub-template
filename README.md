# Web Bookmark Hub

[한국어](README.ko.md) · English

A local bookmark workspace for people who read and organize material from across the web. Save articles, research, code, visual references and videos in one place, then find them through search, folders and tags.

This is a starting point for your own tool. Use it with Codex to organize saved links and adapt the application to your workflow.

## What it does

- Save the current browser page or explicitly selected images with the Chrome extension.
- Find links through search, folders, tags, content types and URL groups.
- Browse a mixed grid, an image feed or a text-focused list. Open a detail view to read summaries, add notes and edit metadata.
- Use Codex for requested link research and organization. The app also has a local Codex CLI summary action.
- Keep your library in local SQLite. Store original links, metadata and selected previews; the application does not mirror entire websites.

## Start with example data

Requires Node.js **24.19.0 or later**. The application has no npm dependencies or build step. Windows is the primary development environment.

```sh
git clone https://github.com/simpleusername96/web-bookmark-hub-template.git
cd web-bookmark-hub-template
node scripts/seed-demo.js
node registry-server.js --host 127.0.0.1 --port 3042 --db ./data/demo.sqlite3
```

Open [the local app](http://127.0.0.1:3042/). The sample library has 20 invented records, four folders and generated preview images. All sample addresses use `example.test`; they are deliberately not real websites. Sample summaries are authored fixtures, not live AI results. Seeding refuses to overwrite an existing database.

For your own empty library, stop the server and run:

```sh
node registry-server.js --host 127.0.0.1 --port 3042 --db ./data/registry.sqlite3
```

Keep each SQLite file and its adjacent `.data` directory together. Everything under `data/` is ignored by Git. Do not add your saved links, exports, credentials or previews to version control.

## Use it with Codex

Open this project in Codex and describe what you want to organize or change. For example:

> Review the Normal links I saved this week. Summarize the ones missing notes and suggest folders for my research project. Preserve my existing notes.

> Adapt this template for my design reference library. Add the fields I need without changing the original links.

Codex can work through the local Registry modules and CLI. The repository includes agent instructions and a link-enrichment skill. A standalone MCP server and watched-source subscriptions are not implemented.

The app's **AI summary** action additionally requires an installed, signed-in [Codex CLI](https://learn.chatgpt.com/docs/codex/cli) available as `codex` on PATH. The shipped summary runner requests `gpt-5.6-luna` with `max` effort; your account must have access. The current summary prompt produces Korean text and can be adapted in `enrichment/ai-summary-prompt.md`. Browsing and organizing the library do not require a running AI session.

**Normal** allows AI processing; **Private** excludes an entry from the supported AI workflows. These are application rules, not filesystem isolation from an unrestricted local agent.

## Chrome extension

1. Open `chrome://extensions`, enable Developer mode and choose **Load unpacked** with this repository folder.
2. Open the extension and choose **Web UI에서 연결**. Approve it in the app's Chrome settings.
3. Save the current page, or select the images you want to keep.

`Ctrl+Shift+E` (`Command+Shift+E` on macOS) saves the current page and can request a summary for an eligible Normal entry. The popup's save action stores the URL without starting that summary flow. Check Chrome shortcut settings for conflicts.

## Make it your own

| Area | Start here |
| --- | --- |
| Interface and retrieval | `web/` |
| Entries, folders, tags and data rules | `registry/` |
| Local HTTP API and authentication | `server/` |
| Browser capture | `extension/`, `profiles.js`, `popup.js` |
| Link enrichment | `enrichment/`, `agent-cli.js` |
| Safe sample content | `examples/`, `scripts/seed-demo.js` |

Read [the project contract](docs/PROJECT.md) before changing behavior. Run `node scripts/verify.js` to validate the application.

MIT licensed. This is a personal-tool template, not a hosted service or an official OpenAI product.
