# Web Bookmark Hub

English · [한국어](README.ko.md)

Save what you read on the web, let Codex summarize it, and find it again when you need it.

Web Bookmark Hub is a local app for collecting articles, papers, posts, code and visual references in one library. With the Chrome extension connected and AI processing enabled, **Ctrl+Shift+E** saves the page you are reading and starts a Codex summary.

This repository is a **template to use and develop with Codex**. Start with the existing app, then change the interface, metadata and workflows to fit how you work.

![A library combining articles, papers, posts and code](docs/images/library-en.png)

*All screenshots use an isolated fictional library. The articles, `.example.test` addresses, illustrations and summaries are authored examples; no personal collection or live AI run is shown. Folders and tags were also prepared for the demo.*

## From reading to a saved reference

**1. Read a page.** The example below is a fictional blog with a cover image and article text.

![A fictional blog article with a representative image and text](docs/images/reading-en.png)

**2. Save with Ctrl+Shift+E.** After setup, the shortcut saves the URL first. For a Normal entry without a summary, the extension supplies a bounded excerpt of the open page and a viewport image to the local summary runner. Codex works in the background.

**3. Return to the source and summary.** The app can fill a missing title, add a short summary and retain an available representative preview. Existing authored titles and notes are preserved. A summary is also added to Notes when there is no existing note.

![Saved article detail with its preview, source link and authored example summary](docs/images/summary-en.png)

Search the library, group links into folders and add tags for later work. Folder assignment and tagging are manual or explicitly requested from Codex; the shortcut does not automatically classify everything.

## What you can collect

| Source | Example use |
| --- | --- |
| arXiv | Keep paper links and short notes on their claims and limitations. |
| X / Twitter | Save individual posts with ideas or methods to revisit. |
| LinkedIn | Keep useful professional posts and articles alongside other research. |
| Blogs and documentation | Collect explanations, guides and references for a project. |
| GitHub and visual references | Keep relevant tools and selected preview images in the same library. |

The current-page shortcut is a general browser-assisted workflow. These are use cases, not a promise of complete extraction from every site. Results depend on the content available in the open page; login requirements, collapsed threads and unsupported layouts can limit a summary. The screenshots illustrate these source types with fictional records, rather than testing the named services.

## Set up your first save

You need **Node.js 24.19.0 or later**, Git, Chrome and a signed-in Codex CLI for automatic summaries. The app itself has no npm dependencies or build step. Windows is the primary development and verification environment; macOS and Linux have not received the same end-to-end verification.

### 1. Start the local app

Use GitHub's **Use this template** to create your own repository, or clone this one:

```sh
git clone https://github.com/simpleusername96/web-bookmark-hub-template.git
cd web-bookmark-hub-template
node registry-server.js --host 127.0.0.1 --port 3042 --db ./data/registry.sqlite3
```

Keep the terminal running and open [the local app](http://127.0.0.1:3042/). A new database starts empty. Use **127.0.0.1:3042** for the extension; its connection is configured for that exact origin.

### 2. Install and sign in to Codex CLI

```sh
npm install -g @openai/codex
codex
```

Complete sign-in before requesting a summary. Installing the Codex desktop app alone does not install the CLI used by this app. See the [official Codex CLI guide](https://learn.chatgpt.com/docs/codex/cli) for installation and authentication.

On **Windows**, the current summary runner expects the npm-installed CLI at `node_modules/@openai/codex/bin/codex.js` beside the Node executable. Use the same Node installation for the server and the CLI. A custom npm prefix or standalone CLI installation may need a change to `codexInvocation` in [`server/ai-url-summary.js`](server/ai-url-summary.js). On macOS/Linux, the runner resolves `codex` from PATH.

The shipped runner requests `gpt-5.6-luna` with `max` reasoning effort; your account must have access to that model. Its default summary language is **Korean**, independently of the UI language. Change [`enrichment/ai-summary-prompt.md`](enrichment/ai-summary-prompt.md) for English or another style. Model and effort are defined in [`registry/constants.js`](registry/constants.js).

### 3. Connect the Chrome extension

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Choose **Load unpacked** and select the repository root, which contains `manifest.json`.
3. Open the extension popup and choose **Web UI에서 연결** (“Connect in Web UI”).
4. In the app's **Settings → Chrome** panel, choose **Approve connection**.
5. Check `chrome://extensions/shortcuts`. The default is **Ctrl+Shift+E**, or **Command+Shift+E** on macOS.

### 4. Enable summaries for new saves

New databases default to **Private**, which does not allow AI processing.

Open the gear icon → **Rules → Defaults**, set **Visibility** to **Normal (local)** and save. Normal allows the app's AI workflows; it does **not** publish the entry. A matching site/path rule may override this default.

This setting applies to **future saves**. To summarize an existing Private entry, change that entry to Normal and explicitly run **AI summary**. Changing the default does not alter existing entries.

### 5. Save a real page

Open an article in Chrome and press **Ctrl+Shift+E**. The URL is saved immediately, and an eligible entry without a summary is queued for Codex. Check **Settings → AI** for progress. In the library, double-click the card to open its detail, or select it and press Enter.

The extension popup's **current-page save** and the app's **Add URL** save a link without starting this automatic summary flow. To retry or refresh a summary, select the entry and use **AI summary**.

## Try it with sample data

To explore the app before connecting Codex, stop the server above and run:

```sh
node scripts/seed-demo.js
node registry-server.js --host 127.0.0.1 --port 3042 --db ./data/demo.sqlite3
```

Open [the local app](http://127.0.0.1:3042/). This separate sample library has 20 invented records, four folders and generated previews. It differs from the smaller screenshot library above. Sample summaries are authored fixtures, and the `.example.test` links are deliberately not live websites. Seeding refuses to overwrite an existing database. No model call is needed to browse it.

Stop the demo server and repeat the first startup command with `registry.sqlite3` to return to your own library.

## Develop it with Codex

Open your copy of the project in Codex. For example:

> Review the Normal links I saved this week. Summarize those missing notes and suggest folders for my research project. Preserve my existing notes.

> Adapt this template for my design reference library. Add the fields I need while preserving the original links.

The app includes a local Registry CLI, HTTP API, agent instructions and a link-enrichment skill. Codex can use them for work you request and help modify the app itself. A standalone MCP server, watched-source feeds and scheduled discovery are not implemented.

| What to change | Start here |
| --- | --- |
| Interface, search and browsing | [`web/`](web/) |
| Entries, folders, tags and data rules | [`registry/`](registry/) |
| Local API and authentication | [`server/`](server/) |
| Browser capture | [`extension/`](extension/), [`profiles.js`](profiles.js), [`popup.js`](popup.js) |
| Summary language and instructions | [`enrichment/ai-summary-prompt.md`](enrichment/ai-summary-prompt.md) |
| Invented sample data | [`examples/`](examples/), [`scripts/seed-demo.js`](scripts/seed-demo.js) |

Read [the project contract](docs/PROJECT.md) before changing behavior. Run `node scripts/verify.js` to validate changes.

## Data and storage

Your library lives in local SQLite under Git-ignored `data/`. Keep each database and its adjacent `.data` directory together when backing up or moving it. Do not commit your saved links, exports, credentials or previews.

The app stores links, editable metadata and bounded previews. It does not keep offline copies of entire pages, PDFs, audio or video. Selected-image capture defaults to references; local preview copies are optional. When you request AI processing, the relevant page evidence is sent through Codex. Local storage does not make AI processing offline.

**Private** excludes an entry from the supported AI workflows. It is an application policy, not filesystem isolation from an unrestricted local agent.

## If something does not work

| Symptom | Check |
| --- | --- |
| Extension cannot connect | Keep the server running at `http://127.0.0.1:3042`, then approve the connection in Settings → Chrome. |
| Shortcut does nothing | Check `chrome://extensions/shortcuts` for conflicts and use a normal HTTP(S) page. |
| Link saved, no summary | Check Visibility, matching Rules, Codex sign-in and Settings → AI. Popup saves do not start a summary; entries that already have one are not automatically rerun. |
| Saved entry is missing | The initial view filters to Normal. Clear the filter or choose Private to see private saves. |
| Codex CLI cannot start on Windows | Check the npm installation layout described above and use the same Node executable for both installations. |
| Summary is in Korean | Edit the summary prompt; changing the UI language does not change the prompt. |

[MIT licensed](LICENSE). A personal-tool template, not a hosted service or an official OpenAI product.
