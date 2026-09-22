# Project contract

Web Bookmark Hub is a local, private index of web pointers shared by a person and their explicitly authorized AI workflows. It stores canonical URLs, editable titles, short summaries, append-only notes, tags, hierarchical folders and bounded selected preview images.

## Implemented boundaries

- `registry/` owns SQLite persistence, canonical URL reuse, folders, tags, rules, visual assets, revisions and AI eligibility. One canonical URL identifies one entry; repeated capture preserves authored metadata.
- `web/` owns the human UI and retrieval state. Grid is general; every Grid card reads metadata, a 4:3 image or summary stage, then the title and available tags, including missing-content and failed-image states. Feed selects entries with covers; List selects entries without covers. Shared search, filters and sort apply to all views. Details are read-first dialogs with explicit autosaving editing.
- `server/` owns the authenticated loopback HTTP API. Web writes require sessions and CSRF; extension clients use paired credentials. Do not expose the server to the public internet.
- `extension/`, `profiles.js`, `content-script.js`, `popup.*` and `service-worker.js` own explicit current-page and selected-image capture. Site templates discover candidates; they do not author privacy or storage policy.
- `enrichment/` owns bounded link extraction and the Codex summary prompt. Local agent CRUD is a convenience path; it is not host isolation. See `docs/project/ENRICHMENT.md`.
- `examples/` and `scripts/seed-demo.js` own invented sample records and generated covers. Sample URLs use reserved test domains, and sample summaries are fixtures. No owner collection is included.
- `docs/images/{reading,summary,library}-{ko,en}.png` and `docs/images/extension-{connect,save,saved}.png` show the unchanged production app and native extension with isolated dummy data. The extension pairing and URL save are real; summaries and folder/tag assignments are authored fixtures, and the blog's cover is generated artwork. Cards use representative images or browser screenshots of invented source pages, stored through the real Registry as page-snapshot covers; the summaries remain stored alongside them. No live model call or named-platform compatibility test is represented. This does not authorize publishing user collections or runtime captures.

## Invariants

Original content stays with its source. Do not persist remote HTML, PDFs, audio, video or unselected image collections. The bounded preview exception permits user uploads, selected image references and one representative image for authorized enrichment.

`visibility=normal` permits AI processing. `visibility=private` excludes the entry, including its URL, from supported AI workflows. Derived compatibility fields are not separate human settings. An unrestricted local agent can still read files; isolation must be configured separately if needed.

All runtime databases, previews, reports and exports live under Git-ignored `data/`. Keep the database and adjacent `.data` directory together. Do not infer that a saved URL is authorization to publish it.

The seven content types are `page`, `article`, `post`, `research`, `code`, `image`, `video`. Source domain, tags and folder placement are separate dimensions. URL groups are derived and read-only.

The summary action invokes the locally installed Codex CLI with the model and effort defined in `registry/constants.js`. It must preserve existing authored titles and notes, and respect the entry's current visibility before applying results. Do not silently substitute models.

MCP, watched sources, scheduled feed discovery and hosted multi-user service are not implemented.

## Development

Node.js 24.19.0 or later; no app npm dependencies. Use CommonJS on Node and the existing browser module pattern. `node scripts/verify.js` checks the manifest, maintained JavaScript and tests. Use synthetic test fixtures. Chrome extension behavior still requires manual browser verification.

README files own the concise template introduction and user controls. `docs/SETUP.md` owns the setup reference for Codex-assisted onboarding. This document owns the product and responsibility boundaries; update it when an accepted change changes those boundaries.
