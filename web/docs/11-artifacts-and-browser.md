# Artifacts and source viewing

The desktop's browser overlay (`BrowserOverlay.tsx`, `human_browser.rs`,
`browser_engine.rs`, `browser_backend.rs`, `file_server.rs`) has three modes:
a sandboxed iframe over a token-bearing loopback file server, a native
WKWebView child for arbitrary web pages, and a CDP screencast mirror of a
headless Chromium driven by Codex's browser plugin. Only the first has a web
equivalent; the other two are dropped (`01-architecture-decisions.md`,
survey conclusion). This document specifies Phase 7.

## 1. What the panel shows

- Attached documents (`04-agent-runtime.md` §8): the primary artifact on the
  web. Document chips under a prompt open the file in the preview panel;
  PDFs and images render natively in the iframe, Markdown and text are
  rendered server-side to a styled page.
- `http(s)` sources from answers and the Sources footer: open in a new tab
  (`window.open(url, "_blank", "noopener,noreferrer")`) via `safeHref`; a
  `LinkContextMenu` offers Open and Copy link. There is no in-app browser.
- `session-file:` links: agents have no filesystem on the web, so these are
  not produced; the renderer keeps `safeHref`'s rejection of unknown schemes.

## 2. Artifact server (server, separate origin)

Port of the token and CSP semantics of `file_server.rs` onto Hono, reduced
to documents:

- Served on `https://artifacts.session.dev` (`SESSION_ARTIFACT_ORIGIN`), a
  second hostname on the app. The app CSP lists it in `frame-src`; the
  artifact origin never receives the session cookie (different host, cookie
  `Domain` unset).
- `artifacts.mintToken({ documentId })` (tRPC, authenticated) inserts an
  `artifact_tokens` row bound to one document; tokens expire after 1 hour;
  the client re-mints on 404/410.
- `GET https://artifacts.session.dev/a/:token`: look up the token, stream
  the file from `/data/documents/<userId>/<sha256>` with the stored MIME
  type, `Range` support, `Content-Length`, `Cache-Control: private,
  no-store`. Markdown and text documents render server-side to a styled HTML
  page with `MARKDOWN_PAGE_CSS` and the `?session-body-font=` selection
  ported from the desktop (`file_server.rs:528-549`, `:873-927`), fonts
  served from `/__session/fonts/*.woff2` on the artifact origin — a literal
  allowlist of the six faces in `packages/server/assets/fonts`, with the
  colors taken from the app's tokens rather than the desktop's grays. Text is
  shown as source in the same shell; `?raw=1` opts out of rendering and is the
  path that keeps `Range` meaningful. The Markdown is sanitized
  (`remark` → `rehype-sanitize`) rather than passed through as the desktop
  did: the preview iframe carries `allow-same-origin` against the artifact
  host, so raw HTML from an uploaded document must not survive the render even
  before the CSP has to stop it.
- Per-response CSP: `default-src 'none'; img-src 'self' data:; style-src
  'unsafe-inline'`; for Markdown pages only the inline scroll script hash is
  allowed (`HTML_PREVIEW_SCROLL_SCRIPT`, `file_server.rs:40`;
  `markdown_page_csp`, `:680-694`) so the panel can restore scroll via
  `postMessage("session-preview-scroll")`. HTML documents are served as
  `text/plain` (no script execution).
- `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `Content-Disposition: inline` for previewable types, `attachment`
  otherwise.

## 3. Preview panel (client)

`features/artifacts/ArtifactPanel.tsx` keeps the overlay UX that is pure
DOM (`browserOverlay.ts` semantics, tested): a floating panel over the right
part of the stage, address row showing the file path, Reload, Open in new
tab, Close (Shift-Cmd-E toggles), resize edge and corner, full-width toggle,
one panel at a time (`closeAllBrowserOverlays`, `browserOverlayShowsLink`).
Body: `<iframe sandbox="allow-scripts allow-same-origin"
referrerpolicy="no-referrer" src=<artifact url>>` — `allow-same-origin`
refers to the artifact origin, not the app's, which is why the separate
origin is mandatory (`allow-scripts` exists only for the scroll bridge on
Markdown pages). Listens for the `session-preview-scroll` message to
restore scroll on reload. The desktop's `mode` switch, screencast, input
injection, geometry publishing, occlusion, and lifecycle queue are removed.

Opening: clicking a document chip calls `artifacts.mintToken` then opens the
panel; the same document within the token's lifetime reuses the URL.

## 4. Optional reader view (feature flag `SESSION_READER_VIEW=1`)

For `http(s)` sources, "Read here" reuses the `web_fetch` tool's cached
readable text for that URL (or fetches it with the same SSRF guard) and
renders it in the app's own `.research-prose` surface inside the panel.
Cheap because the fetcher already exists for the agent; not part of the
parity checklist.

## 5. Not ported

- Native WKWebView browsing of arbitrary sites (framing is blocked by
  `X-Frame-Options`/`frame-ancestors`; a general proxy is out of scope).
- The Codex browser plugin bridge and CDP mirror (local Unix-socket discovery,
  headless Chromium in the image). If a visual snapshot of a source is wanted
  later, a server-side screenshot service is the path.
- The artifact tray (`artifact_*` commands), `browser.open` over the control
  socket, `image_files.rs`, `session-file:` link resolution, and the
  loopback file server's directory browsing (there are no directories).
