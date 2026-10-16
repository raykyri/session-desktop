# Artifacts, widgets and source viewing

The desktop's browser overlay (`BrowserOverlay.tsx`, `human_browser.rs`,
`browser_engine.rs`, `browser_backend.rs`, `file_server.rs`) has three modes:
a sandboxed iframe over a token-bearing loopback file server, a native
WKWebView child for arbitrary web pages, and a CDP screencast mirror of a
headless Chromium driven by Codex's browser plugin. Only the first has a web
equivalent, and on the web it serves answer widgets only; the other two are
dropped (ADR-10 in `01-architecture-decisions.md`).

## 1. What is shown

- Answer widgets: `session-html` blocks in answers (§3–§6).
- `http(s)` sources from answers and the Sources footer: open in a new tab
  (`window.open(url, "_blank", "noopener,noreferrer")`) via `safeHref`; a
  `LinkContextMenu` offers Open and Copy link. There is no in-app browser.
- `session-file:` links: agents have no filesystem on the web, so these are
  not produced; the renderer keeps `safeHref`'s rejection of unknown schemes.
- Uploaded documents and the document preview panel were removed in phase
  2.0 of the desktop parity plan, together with `artifacts.mintToken`, the
  `artifact_tokens` table, `GET /a/:token`, the rendered Markdown and text
  pages, and the `/__session/fonts/*` route.

## 2. Artifact origin (server)

Widget pages are served on a second origin, `SESSION_ARTIFACT_ORIGIN`, by the
same process.

- `middleware/artifactHost.ts` is mounted before every route. On the artifact
  host only `GET`/`HEAD /w/:token` reaches the widget routes; every other
  method and path is 404, so no app route (auth, tRPC, images, the SPA)
  responds there. A `Set-Cookie` header is removed from every artifact-host
  response, and the session loader runs after the widget routes, so the
  artifact host never reads or sets a cookie.
- `/w/:token` responds only when `Host` is the artifact host and
  `Sec-Fetch-Dest` is `iframe`: a top-level visit, a subresource load or a
  request without Fetch Metadata is 403.
- The app's CSP lists the artifact origin in `frame-src`; the app sends
  `X-Frame-Options: DENY` and `frame-ancestors 'none'` for its own pages.
- The session cookie is host-only (no `Domain`), `HttpOnly`, `SameSite=Lax`,
  and `Secure` in production (`auth/session.ts`), so it is sent only to the
  app host.

### 2.1 Same-site rule (fail closed)

Widget scripts run only when the artifact origin is a different **site**
(registrable domain, Public Suffix List with its private section) from the
app (`server/src/artifacts/site.ts`). A subdomain of the app's domain is the
same site: `artifacts.session.dev` beside `session.dev` shares the site
`session.dev`, so browsers treat requests between them as same-site for
`SameSite` cookies and `Sec-Fetch-Site`, and a cookie scoped to the parent
domain would reach both. IP addresses and hosts without a registrable domain
(`localhost`) are their own site; the scheme is not considered.

- `loadConfig` computes `config.widgetScripts` once. When the two origins are
  the same site, `prepareWidget` returns no run page (`runUrl: null`), a run
  token is refused (410), and widgets show their static page with the status
  "Scripts off". The server logs the reason at error level at boot
  (`logWidgetScriptPolicy`); when scripts are on it logs that at info level.
- An artifact origin on the same host as the app is a configuration error and
  the process does not start.
- The deployed configuration (`web/fly.toml`: `https://session.dev` and
  `https://artifacts.session.dev`) is the same site, so production serves
  static widget pages only until `SESSION_ARTIFACT_ORIGIN` is moved to a host
  on another registrable domain (`web/SETUP.md` §2).
- Development (`http://localhost:1480` and `http://artifacts.localhost:8787`)
  and the end-to-end suite (`http://127.0.0.1:<port>` and
  `http://localhost:<port>`) are different sites, so scripts run there.

## 3. Widget pages

`artifacts.prepareWidget` mints two capability URLs for one widget block,
each a 64-hex random token valid for an hour (an in-memory LRU of at most 64
previews per account and 256 in all): the **static page** and, while scripts
are allowed, the **run page**. The HTML always comes from a stored answer the
caller can read (named by the SHA-256 of the block's HTML) or from a stored
revision (§5); a client never supplies served HTML.

Both pages use the desktop's widget wrapper (`artifacts/widgetPage.ts`, from
`src-tauri/src/file_server.rs`): its theme tokens and utility classes, and
Session's scripts in `<head>` ahead of the widget's markup, which is the whole
`<body>`. The navigation guard runs first on both pages (cancels link
activations, responds to liveness pings, reports `pagehide`), and the height
reporter last.

| | Static page | Run page |
| --- | --- | --- |
| Widget HTML | sanitized (parse5; scripts, event handlers, links, `meta`, embedding and raw-text elements, comments removed; checked to be a parse/serialize fixed point) | as written, with `http-equiv` renamed to `data-http-equiv` |
| Session's scripts | navigation guard, height reporter | navigation guard, WebRTC prelude, `window.sessionWidgetState`, error notice, height reporter |
| `script-src` | the SHA-256 hashes of Session's two scripts | `'unsafe-inline'` |

The rest of the response policy is the same for both:

```
default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:;
font-src data:; media-src data: blob:; connect-src 'none'; object-src 'none';
base-uri 'none'; form-action 'none'; frame-ancestors <app origin>;
sandbox allow-scripts
```

with `Permissions-Policy` turning off camera, microphone, geolocation,
display capture, USB, serial, HID, payment, MIDI, clipboard, fullscreen, wake
lock, WebAuthn and motion sensors, and `Cache-Control: no-store`,
`Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`,
`X-DNS-Prefetch-Control: off`.

The client frame is `<iframe sandbox="allow-scripts">` with
`referrerpolicy="no-referrer"`: no `allow-same-origin`,
`allow-top-navigation`, `allow-popups`, `allow-forms`, `allow-modals` or
`allow-downloads`. The CSP `sandbox` directive repeats the restriction, so the
document has an opaque origin even if it were ever loaded another way.

What a widget script can and cannot do:

- It cannot read or set cookies or web storage (opaque origin), read the
  app's DOM (cross-origin), or navigate the top-level page, open windows or
  submit forms (sandbox flags and `form-action 'none'`).
- It cannot make network requests: `connect-src 'none'` and
  `default-src 'none'` cover fetch, XHR, WebSocket, EventSource, beacons,
  workers, frames and every passive resource except `data:`/`blob:`. A
  request to the app would in any case be cross-site and refused by the CSRF
  guard (`Sec-Fetch-Site: cross-site`, `Origin: null`).
- It can navigate its own frame. The guard cancels link clicks; a scripted
  navigation is noticed by the missing ping responses or the second load event,
  and the app removes the frame ("The widget navigated away from its page").
  The new document stays inside the sandbox. A navigation to the app gets
  `X-Frame-Options: DENY`, so nothing renders, and the request's opaque
  initiator makes it `Sec-Fetch-Site: cross-site`, which the CSRF guard
  refuses for tRPC. The app's other GET routes change nothing a widget could
  use: `/auth/github` starts a sign-in (a state cookie and a redirect to
  GitHub, which the frame cannot show) and the callback requires that
  state.
- Known residual: WebRTC is outside every CSP directive that browsers
  enforce. The run page removes the RTC constructors from the widget's
  global object, but a script can obtain fresh constructors from a child
  frame it creates, so a widget could send what it holds (its own HTML and
  the inputs the reader typed or saved into it) to a peer. The desktop closes
  this by turning WebRTC off in its web view; a browser offers no equivalent.
- Resource use (a script that loops or allocates) is not contained beyond
  what the browser does for a cross-origin frame. The app stops a widget that
  repeatedly takes keyboard focus (§4).

## 4. The widget in the client

`features/widgets/SessionWidget.tsx` (the desktop's `SessionWidget.tsx`),
rendered by `ResearchMarkdown` for a complete block of an answer passed with
`widgetNodeId`:

- One header bar: the revision's title (or the fence's, or "Widget"), the
  status ("Running", "Stopped", "Scripts off"), Preview/Source, Ask for
  changes (when the thread provides `WidgetChangeContext`), Run scripts or
  Reload, and the "…" menu.
- The frame starts on the static page. Run scripts loads the run page and
  focuses the frame; the choice is shared with expanded copies of the same
  widget (`widgetExecution.ts`). Pages about to expire are prepared again
  before Run or Reload.
- The "…" menu (`SessionWidgetMenu.tsx`): Copy HTML, Download HTML (the
  static policy as a `<meta>` CSP), Open expanded view (the desktop's "Open in
  browser"; the web has no in-app browser, so the current page opens in a
  dialog), the artifact's revisions (check on the current one; selecting one
  previews its static page in the dialog), and Saved inputs: Remember inputs,
  Reset inputs, Copy inputs from `<parent>`.
- The frame bridge (`widgetBridge.ts`) accepts a message only from the
  frame's own window (`event.source`), with origin `"null"`, within a budget
  of 40 messages a second (burst 80) per frame, and matching a zod schema:
  height (clamped to 48–900 px), pong, unload, saved-input ready and save.
  Saved inputs must be JSON of at most 16 KiB (`widgetStateJson`, checked
  before serializing). The app sends the frame only pings and the saved
  inputs of the frame's revision.
- Containment (`useWidgetGuards.ts`, the desktop's `useSessionWidgetGuards`):
  a ping every second, with the frame removed after four unanswered pings or
  a second load; focus that enters a running frame without a pointer or key
  action returns to the previous element, and three such takes within ten
  seconds stop the widget's scripts ("Stopped").
- Contexts (`features/widgets/context.ts`) for the thread page:
  `WidgetChangeContext` (`{ ask(answer, html), blocked? }`; the prompt is
  `widgetChangePrompt` from `@session/shared/lib/sessionWidgetActions`),
  `SessionWidgetStreamingContext` (no revision is recorded while true), and
  `WidgetAnswerContext`, which `ResearchMarkdown` fills with the node and the
  answer text, keeping a thread page's `messageKey`, `treeId` and `blocked`.

## 5. Revisions and saved inputs

The desktop's research artifact store (`research_artifacts.rs`) on
`widget_revisions` and `widget_state` (`repos/widgets.ts`):

- `artifacts.register({ nodeId, slot, html, meta })` records the revision of
  a displayed block. The server looks for a complete block with that HTML and
  fence metadata in the node's stored answer and takes the id, title and
  parent from that metadata. Revision ids, legacy ids for unnamed fences,
  title normalization and the immutability of a stored revision are the
  desktop's.
- `artifacts.history({ treeId, artifactId })` first records every named
  revision of the artifact in the thread's settled answers, then lists them in
  lineage order (roots oldest first, each followed by its descendants);
  `unresolved` counts sources that could not be stored.
- `artifacts.getState` / `updateState` read and change the caller's saved
  inputs for one revision: `enable`, `disable` (forgets the value), `reset`,
  `save` (only while enabled), `migrate` (copies the same user's value from
  the parent revision). Saved inputs are scoped per user.
- A declared parent that is malformed or not stored makes the revision a root
  with `unresolvedParent`; `parent_revision` keeps the declared value as
  written so a later parent resolves it.
- The `artifacts.*` procedures have their own budget of 600 calls a minute
  per account instead of the general mutation budget.

## 6. Agent guidance

Every launch carries the desktop's widget guidance word for word
(`SESSION_WIDGET_AGENT_GUIDANCE` in `server/src/runs/prompts.ts`, from
`AGENT_GUIDANCE` in `research_widgets.rs`): scripts start only when the
reader asks, the static page must show a meaningful state, saved inputs go
through `window.sessionWidgetState`.

## 7. Not ported

- Native WKWebView browsing of arbitrary sites (framing is blocked by
  `X-Frame-Options`/`frame-ancestors`; a general proxy is out of scope).
- The Codex browser plugin bridge and CDP mirror. If visual snapshots of web
  sources are needed later, a server-side screenshot service is the place.
- The artifact tray (`artifact_*` commands), `browser.open` over the control
  socket, `image_files.rs`, `session-file:` link resolution, and the
  loopback file server's directory browsing.
- The widget body font follows the system font stack; the desktop passes the
  app's chosen body font to the page. The frame's light or dark scheme
  follows the browser's `prefers-color-scheme`, not the app's appearance
  setting.
- While a widget frame has focus, the app's keyboard shortcuts do not reach
  the app (the desktop forwards them natively).
