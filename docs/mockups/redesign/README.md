# Session redesign candidates

Restyles of the current Session app that keep its layout, navigation, controls, keys and
vocabulary and adopt one reference app's visual style: Front (light nav and cards, no avatars) and Linear
(bordered cards). Earlier rounds of full
redesigns in eight reference idioms, and the other variants, were dropped; they are in the git
history.

- `index.html`: the compilation (candidate tabs, round and variant switches, notes, issues).
  It reads `manifest.json` and `issues.json` with `fetch`, so serve the directory over HTTP:
  `npx http-server docs/mockups/redesign` and open `/index.html`. It has no doctype of its own
  because the published artifact wraps it in one.
- `r3/<slug>.html`: the restyles. Each also opens on its own.
- `build-manifest.mjs`: regenerates `manifest.json` and `thumbs/` from each file's `MOCK`
  object. Pass `r<round>/<slug>` arguments to include only those files.
- `issues.json`: the review of the current app; the readable version is
  `docs/reviews/app-review-2026-10.md`.
