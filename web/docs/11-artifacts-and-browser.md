# Artifacts and source viewing

The desktop's browser overlay (`BrowserOverlay.tsx`, `human_browser.rs`,
`browser_engine.rs`, `browser_backend.rs`, `file_server.rs`) has three modes:
a sandboxed iframe over a token-bearing loopback file server, a native
WKWebView child for arbitrary web pages, and a CDP screencast mirror of a
headless Chromium driven by Codex's browser plugin. Only the first has a web
equivalent; the other two are dropped (ADR-10 in
`01-architecture-decisions.md`). This document specifies Phase 7.

## 1. What is shown

- Uploaded documents and the document preview panel were removed in phase
  2.0 of the desktop parity plan, together with `artifacts.mintToken`, the
  `artifact_tokens` table, `GET /a/:token`, the rendered Markdown and text
  pages, and the `/__session/fonts/*` route. The widget preview route
  (`GET /w/:token`, `artifacts.prepareWidget`) is what the artifact origin
  serves now.
- `http(s)` sources from answers and the Sources footer: open in a new tab
  (`window.open(url, "_blank", "noopener,noreferrer")`) via `safeHref`; a
  `LinkContextMenu` offers Open and Copy link. There is no in-app browser.
- `session-file:` links: agents have no filesystem on the web, so these are
  not produced; the renderer keeps `safeHref`'s rejection of unknown schemes.

## 2. Artifact origin (server)

- Served on `https://artifacts.session.dev` (`SESSION_ARTIFACT_ORIGIN`), a
  second hostname on the app. The app CSP lists it in `frame-src`; the
  artifact origin never receives the session cookie (different host, cookie
  `Domain` unset).
- `middleware/artifactHost.ts` answers 404 for every route except the widget
  preview on this host.

## 3. Preview panel (removed)

The client preview panel (`features/artifacts/ArtifactPanel.tsx`, its store,
and the Shift-Cmd-E toggle) existed only to show uploaded documents and was
removed with them.

## 4. Optional reader view (not built; would be feature flag `SESSION_READER_VIEW=1`)

For `http(s)` sources, "Read here" reuses the `web_fetch` tool's cached
readable text for that URL (or fetches it with the same SSRF guard) and
renders it in the app's own `.research-prose` surface inside the panel.
Cheap because the fetcher already exists for the agent; not part of the
parity checklist.

## 5. Not ported

- Native WKWebView browsing of arbitrary sites (framing is blocked by
  `X-Frame-Options`/`frame-ancestors`; a general proxy is out of scope).
- The Codex browser plugin bridge and CDP mirror (local Unix-socket discovery,
  headless Chromium in the image). If visual snapshots of web sources are required in the future, a dedicated server-side screenshot service should be implemented.
- The artifact tray (`artifact_*` commands), `browser.open` over the control
  socket, `image_files.rs`, `session-file:` link resolution, and the
  loopback file server's directory browsing (there are no directories).
