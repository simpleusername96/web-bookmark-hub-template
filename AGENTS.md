# Agent instructions

- Read `docs/PROJECT.md` before changing files.
- For setup, use or customization, read `docs/CODEX_GUIDE.md` for the feature inventory, rationale, rule layers, code owners and existing CLI commands; use `docs/SETUP.md` for environment preparation and Chrome installation. Follow the purpose already supplied by the user and ask only for material missing requirements.
- Keep user URLs, database rows, downloaded content, tokens and browser state out of Git. Local runtime data belongs only under ignored `data/`.
- Use `.agents/skills/enrich-links/SKILL.md` for user-authorized link enrichment or organization. Private entries must not be read or enriched by supported AI workflows.
- Keep original URLs and authored notes. Do not archive remote page bodies or unselected media.
- Preserve the user's input focus. Prefer headless or target-scoped browser work.
- Run `node scripts/verify.js` and `git diff --check` after code changes. Never stage unrelated changes.
- Do not enable delegation or make live AI calls just to run tests.

This is an independently editable template. Its maintainers decide how to adapt it for their own use.
