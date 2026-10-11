# Session redesign candidates

Eight interactive redesign mocks, each in the idiom of one reference app (Ulysses, macOS
system apps, Apple Notes, Obsidian, Notion, Front, Tana, Linear), in two rounds. Each mock
has five variants. Round 2 is each candidate's revision after a self-review against a
first-use task script and the issues in `issues.json`.

- `index.html`: the compilation (candidate tabs, round and variant switches, notes, issues).
  It reads `manifest.json` and `issues.json` with `fetch`, so serve the directory over HTTP:
  `npx http-server docs/mockups/redesign` and open `/index.html`. It has no doctype of its own
  because the published artifact wraps it in one.
- `r1/<slug>.html`, `r2/<slug>.html`: the candidates. Each opens on its own as well, with a
  variant switcher in the corner.
- `build-manifest.mjs`: regenerates `manifest.json` and `thumbs/` from each file's `MOCK`
  object. Pass `r<round>/<slug>` arguments to include only those files.
- `issues.json`: the review of the current app; the readable version is
  `docs/reviews/app-review-2026-10.md`.
