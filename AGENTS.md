# Agent instructions

- Read `docs/PROJECT.md` before changing files.
- For setup and first use, read `docs/SETUP.md`, prepare the environment and guide Chrome installation. Ask what the user wants to build from the template; keep that purpose ahead of preserving the sample workflow.
- Keep user URLs, database rows, downloaded content, tokens and browser state out of Git. Local runtime data belongs only under ignored `data/`.
- Use `.agents/skills/enrich-links/SKILL.md` for user-authorized link enrichment or organization. Private entries must not be read or enriched by supported AI workflows.
- Keep original URLs and authored notes. Do not archive remote page bodies or unselected media.
- Preserve the user's input focus. Prefer headless or target-scoped browser work.
- Run `node scripts/verify.js` and `git diff --check` after code changes. Never stage unrelated changes.
- Do not enable delegation or make live AI calls just to run tests.

This is an independently editable template. Its maintainers decide how to adapt it for their own use.
