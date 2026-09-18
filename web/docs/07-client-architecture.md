# Client architecture

`packages/client` is a Vite + React 19 single-page app. It ports the desktop
frontend (`src/`) onto a router, a query cache, and stores, replacing the
12,091-line `App.tsx` (108 `useState`, 150 mirror refs, one hand-ordered
Escape dispatcher) with per-route components and shared stores.

## 1. Package layout

```
packages/client/
  index.html
  ava.config.mjs             AVA with tsx and the jsdom setup file
  vite.config.ts             react plugin, tailwind plugin, PACKAGE_VERSION define for MathJax
  src/
    main.tsx                 createRoot, providers (Query, Router, Theme)
    app/
      router.tsx             route tree (code-based), auth guard, boot loader
      providers.tsx
      queryClient.ts         the client the router and the providers share
      SessionBoot.tsx        subscription, draft writer, settings mirror
      layout/                AppShell, Sidebar, StageHeader (history nav)
    routes/
      login.tsx  home.tsx  bookmarks.tsx  highlights.tsx
      research.$treeId.tsx  encyclopedia.$slug.tsx  settings.tsx  admin.tsx
    api/
      trpc.ts                createTRPCClient (batch + subscription links); the only
                             module that names `@session/server`, as a type
      api.ts                 desktop-named wrappers (createResearchTree, …)
      cache.ts               query key factory and the cache writers events and
                             mutations share
      events.ts              SSE bridge: subscription → coalesced cache patches + stores
      queries.ts             hooks and query options (useTreeSummaries, useNodeContent, …)
    stores/
      settings.ts            Zustand persist; mirrors server UserSettings
      navigation.ts          per-document node history, folder scope, visibility filter
      drafts.ts              composer drafts (sessionStorage + server interface_drafts)
      overlays.ts            dialog/menu/lightbox stack
      selection.ts           research multi-select
      liveTurns.ts           per-node streaming buffers
      lightboxes.ts          image/diagram (useSyncExternalStore, ported)
      notifications.ts       toast list
      connection.ts          SSE status
    ui/                      design-system wrappers (08-design-system-and-styling.md)
    features/
      sidebar/  home/  research/  encyclopedia/  highlights/  journal/
      composer/  markdown/  settings/  agents/  import/  palette/  artifacts/
    lib/                     client-only helpers (clipboard, keyboard, dom search)
    styles/
      app.css                @import "tailwindcss"; @theme inline; @custom-variant; layers
      tokens.css             copied verbatim from src/styles/tokens.css
      prose.css              .research-prose, code, tables (from transcript.css/research-surface.css)
      tweet.css              .journal-tweet recipe (from research-surface.css)
      fonts.css              @font-face (from tokens.css:1-133)
    assets/fonts/ model-icons/ brand/
  test/                      AVA + global-jsdom + Testing Library
```

Dependencies: `react`, `react-dom`, `@tanstack/react-router`,
`@tanstack/react-query`, `@trpc/client`,
`zustand`, `@base-ui-components/react`, `lucide-react`,
`@tanstack/react-virtual`, `react-markdown`, `remark-gfm`, `remark-breaks`,
`remark-math`, `rehype-mathjax`, `mermaid`, `@viz-js/viz`, `dompurify`,
`zod`, `tailwindcss`, `@tailwindcss/vite`.

## 2. Providers and boot

`main.tsx` mounts `QueryClientProvider`, the tRPC provider, `RouterProvider`,
and a `ThemeEffects` component that writes `data-color-theme`,
`data-appearance`, `data-body-font`, `--font-ui`, and the `reduce-motion`
class on `<html>` from the settings store (`App.tsx:1926-1969` logic). A
`<meta name="color-scheme">` replaces `getCurrentWindow().setTheme`.

Boot sequence: settings store hydrates from localStorage → router renders →
the shell route's `beforeLoad` resolves `auth.me` through the query cache and
redirects to `/login` if it is null (`/login` and `/dev/ui` are outside the
guard) → its loader warms `settings.get`, `system.runtimeConfig`,
`workspaces.list`, `research.listTrees`, `folders.get`,
`encyclopedia.listPages` in parallel, without blocking the first paint on them
→ `SessionBoot` opens the SSE subscription, installs the draft writer, and
takes the server's settings over the local mirror. No "window ready"
handshake; the desktop's hidden-window flash prevention is unnecessary.

The sign-in page reads the refusal the server put on the redirect
(`/login?error=not_allowed|invite_required|invite_invalid|expired_state|
missing_code|exchange_failed|profile_failed`, `server/src/auth/github.ts`) and
sends `return_to` back through `/auth/github`. A deployment with no GitHub
credentials answers that route with a 503 page rather than a redirect, so
"signups are closed" has no parameter to render.

## 3. Routes

| Path | Component | Notes |
| --- | --- | --- |
| `/login` | `LoginPage` | GitHub button; shows allowlist/closed messages |
| `/` | `HomePage` | Home feed + composer; search `?ws=` |
| `/bookmarks` | `BookmarksPage` | feed with `bookmarkedOnly` |
| `/highlights` | `HighlightsPage` | |
| `/r/$treeId` | `ResearchPage` | search `?node=&highlight=&filter=`; `key={treeId}` remount as today |
| `/e/$slug` | `EncyclopediaPage` | search `?ws=` |
| `/settings` | `SettingsPage` | sections: General, Appearance, Research (instructions, default model), Usage |
| `/admin` | `AdminPage` | admin only: user list with usage and model access |

Search params validated with zod (`validateSearch`). The workspace scope
`ws` defaults to `settings.defaultWorkspaceId`; changing it calls
`settings.update`. Cross-page navigation uses router history, so the
desktop's `ResearchWorkspaceHistory` reducer is retired; `ResearchHistoryNav`
in headers calls `router.history.back()/forward()` and disables buttons using
`window.history.length` heuristics plus a router-tracked index.

Synthetic tab ids for Cmd-1..9 and cycling (`src/lib/sidebarMode.ts`) stay;
they resolve to routes.

## 4. State management (ADR-6)

### 4.1 Server state — TanStack Query

Query keys (factory in `api/queries.ts`):

```
["me"]                                   auth.me
["settings"]                             settings.get
["runtimeConfig"]                        system.runtimeConfig (models)
["documents", workspaceId]               documents.list
["usage"]                                usage.summary
["workspaces"]                           workspaces.list
["folders", workspaceId]                 folders.get
["trees", { workspaceId, includeArchived }]  research.listTrees
["tree", treeId]                         research.getTree
["nodeContent", nodeId]                  research.getNodeContent
["activity", { workspaceId, bookmarkedOnly }]  infinite: feed.recentActivity
["highlightsFeed", workspaceId]          highlights.listFeed
["encyclopedia", workspaceId]            listPages
["encyclopediaPage", workspaceId, slug]  getPage
["activeNodes"]                          research.listActivity
["adminUsers"]                           admin.listUsers
```

The factory lives in `api/cache.ts` and is re-exported from `api/queries.ts`,
which is the import path the rest of the client uses: the cache writers the
bridge and the mutations share need the keys, and the hooks need the writers,
so the keys sit below both rather than beside one of them.

Defaults: `staleTime: Infinity` for event-patched lists (events keep them
fresh), `refetchOnWindowFocus: false`, `retry: 1`. Mutations write their
returned objects into the cache (`setQueryData`) using the reducers from
`shared/research/events.ts` (ported `researchEvents.ts`: `patchTreeSummary`,
`upsertTreeDetailNode`, `removeTreeDetailNodes`, `upsertActivityNode`, …).

### 4.2 Event bridge (`api/events.ts`)

One `events.subscribe` subscription for the app's lifetime. Incoming events
are queued and flushed on a 16 ms trailing timer (`EVENT_COALESCE_MS`,
`useSessionEvents.ts:37-51`); a flush runs inside
`notifyManager.batch(() => …)` so all `setQueryData` calls yield one render.
Per event type:

- `research.*` → `parseResearchEvent` (shared) → apply reducer to `trees`,
  `tree`, `activity`, `highlightsFeed`, `activeNodes` caches; `malformed` or
  `unsupported` → `invalidateQueries` for the affected scope.
- `research.turn.delta|committed|run.*` → `liveTurns` store.
- `encyclopedia.*`, `journal.*`, `workspace.*`, `folders.updated`,
  `settings.updated`, `models.updated` → targeted `setQueryData` or
  invalidate.
- `research.run.thinking` → `liveTurns` thinking indicator.
- `notification.requested` → `notifications` store.
- On (re)connect: `invalidateQueries()` for list queries and a snapshot
  refetch for every displayed active node; the `liveTurns` store applies only
  `seq === lastSeq + 1` and refetches on gaps
  (`05-run-lifecycle-and-streaming.md` §4, §9). The bridge also publishes the
  interest set (`events.setInterest`, debounced 200 ms) from a reference-counted
  registry the mounted document views join through `useNodeInterest`.
- The first event of every connection is `connection.ready`, carrying the
  `connectionId` that `events.setInterest` addresses; a second one means the
  link reconnected, which is what triggers the invalidation and the snapshot
  re-read above.

Connection status (`connection` store) drives a subtle indicator and enables
the snapshot-poll fallback for displayed active nodes when SSE is down.

### 4.3 UI state — Zustand

| Store | Contents | Persistence |
| --- | --- | --- |
| `settings` | `UserSettings` mirror | localStorage `session.settings.v2`; server copy authoritative |
| `navigation` | per-tree node history stacks, `visibilityFilter`, `sidebarCollapsed`, `sidebarWidth`, per-node scroll offsets (15 min TTL), "show earlier" expansions | localStorage `session.navigation.v2` |
| `drafts` | home composer drafts, per-node follow-up drafts, targeted asks in progress | sessionStorage + `drafts.set` (debounce 120 ms, flush on `pagehide`) |
| `overlays` | stack of open dismissable layers with `onEscape` | none |
| `selection` | research multi-select ids | none |
| `liveTurns` | `Map<nodeId, { turns, inFlightText, inFlightTurnId, lastSeq, status }>` | none |
| `lightboxes` | image/diagram lightbox state (ported `useSyncExternalStore` stores) | none |
| `notifications` | toast list (≤ 20), dedupe by id | none |
| `connection` | `connecting | open | closed`, lastEventId | none |

Stores expose selectors; components subscribe to slices. No module-level
refs mirror state.

### 4.4 Escape and dismissal

Base UI handles Escape for its own dialogs/menus/popovers with correct
nesting. Non-library layers (lightboxes, DOM search bar, selection popover,
sidebar multi-select) register in `overlays` with a priority; a single
capture-phase keydown handler in `AppShell` calls the top entry's `onEscape`.
This replaces `App.tsx:9094-9220`.

## 5. Keyboard shortcuts and command palette

`shared/app/shortcuts.ts` is the ported `resolveAppShortcut`
(`src/lib/appShortcuts.ts`). `AppShell` installs one capture-phase listener
that stands down while a Base UI layer is open — the library owns dismissal
for its own dialogs, menus and popovers, with correct nesting — and otherwise
passes every keydown to the shared table, `isEditableTarget` included. Whether
a text field swallows a chord is decided per chord there, not for the listener
as a whole: this app is used from a composer most of the time, and Cmd-J
("focus the follow-ups") exists to be pressed from one. Only the chords that
compete with text editing or with the caret's own navigation require a
non-editable target — Cmd/Ctrl-1..9, Ctrl-Tab, Shift-Cmd-[ / ], and
Cmd-Alt-Up/Down. It dispatches:

Cmd-1..9 focus tab · Cmd-N/T Home + focus composer · Shift-Cmd-G toggle
sidebar · Ctrl-Tab / Shift-Cmd-] cycle · Cmd-Alt-Up/Down move item · Cmd-,
settings · Cmd-K palette · Cmd-J focus follow-ups (window event consumed by
`ResearchPage`) · Cmd-O folder menu · Shift-Cmd-E toggle artifact panel ·
Cmd-[ / Cmd-] node history (inside `ResearchPage`) · Cmd-F DOM search · H/A/E
on selection.

Browser conflicts: Cmd-N/T open new windows/tabs in browsers and cannot be
intercepted, and Cmd-1..9 switch browser tabs on some platforms.
`resolveAppShortcut` accepts Ctrl as the primary modifier for the digit and
comma chords only (`src/lib/appShortcuts.ts:40`, `:53`, `:72`); `n`/`t`
require Meta. The shared port adds Shift-Cmd-H for Home (the documented web
chord; `RESEARCH_HOME_SHORTCUT_LABEL` is `⇧⌘H`) and keeps Ctrl-1..9 for tabs;
Cmd variants are honored where the browser lets them through. Cmd-F and the
bare H/A/E keys are not app shortcuts: DOM search and the highlight actions
handle them (`shared/research/highlights.ts`). Shift-Cmd-E is
`toggleArtifactPanel` (renamed from the desktop's `toggleSourceBrowser`).

Command palette (`features/palette`): Research section (one entry per tree,
"N running" hint) and Actions section (Home, Toggle sidebar, Settings),
built only while open (`App.tsx:8098`).

## 6. Composer

`ResearchQueryComposer` (`src/components/research/ResearchQueryComposer.tsx`)
ports with: a model chip cycling through the models the user may access on
Tab (`launcherKeyboard`, reduced to one dimension), an attach button and
drag-drop for documents (chips with name, size, extraction status, remove),
draft persistence (prompt, model, attached document ids),
`growComposerTextarea`, `isComposerSubmitShortcut` with
`requireCmdEnterToSend`. Dropped: the "Ask network" toggle, provider
cycling, custom model input, and per-model effort options (effort is fixed
at medium). Slash commands are not ported.

## 7. Shared package usage from the client

The client imports types and pure logic from `@session/shared`; it must not
duplicate any of it. Modules ported into `shared` are listed in
`00-plan.md` Phase 1. Client-only modules ported from `src/lib/`: `clipboard`
(minus the Tauri branch), `transcriptSearch`, the DOM half of
`composerTextarea` (`growComposerTextarea`; the height math is in shared),
the `localStorage` layers of `researchNavigation` and `researchFolders`,
`wikilinkClickContext`/`neighborText` from `encyclopedia`, `diagramLightbox`, `imageLightbox`, `windowFocus` (reduced to
`document.hasFocus()`), `sidebarControls`. The `humanBrowser*` modules are dropped.

## 8. Persistence keys (replacing the desktop list)

| Desktop key | Web |
| --- | --- |
| `session.settings.v1` (localStorage) | `settings` store (`session.settings.v2`) + server |
| `session.active-research-tree.v1` | URL |
| `session.research-navigation.v1`, `session.research-visibility-filter.v1`, `session.research-folder-scope.v1`, `session.journal-open.v1` | URL search params + `navigation` store |
| `session.research-browser.state.v1` (feed scroll anchor) | `navigation` store, sessionStorage |
| `session.interface-draft.*` + backend `interface_draft_*` | `drafts` store + `drafts.set` |
| `session.research-folders.v1` (legacy) | server only |
| `session.active-research-pane.v1`, `session.show-archived-research.v1` | dropped (pane-scoped and already legacy) |

## 9. Security in the client

- CSP (served by Hono): `default-src 'self'; script-src 'self'; style-src
  'self' 'unsafe-inline' (MathJax and mermaid inject styles); img-src 'self'
  data: blob: https://pbs.twimg.com https://abs.twimg.com https://avatars.githubusercontent.com;
  font-src 'self'; connect-src 'self'; frame-src <artifact origin>; object-src
  'none'; base-uri 'none'; form-action 'self' https://github.com`. No
  `unsafe-eval`, so the `PACKAGE_VERSION` define for MathJax stays
  (`vite.config.ts:9-17`).
- `safeHref` from `shared/links` still allows only `http:`, `https:`,
  `mailto:`, and `session-file:` (resolved to artifact URLs at click time,
  Phase 7). External links open with `target="_blank" rel="noopener
  noreferrer"`.
- Remote images in Markdown stay blocked (`BlockedMarkdownImage`); tweet media
  is allowed from the twimg hosts listed above.
- Diagram SVG passes through DOMPurify's SVG profile with the
  `afterSanitizeAttributes` hook (`DiagramBlock.tsx:106-166`).

## 10. Performance

- Route-level code splitting; MathJax, mermaid, viz lazy as today.
- Feed virtualization with TanStack Virtual (replaces the hand-rolled canvas
  in `ResearchActivityFeed.tsx`).
- `OversizedMarkdownPolicy` retained; react-markdown re-parses on each render,
  so the timeline memoizes per turn id + revision.
- `liveTurns` deltas update one component subtree; list queries are not
  touched during streaming; deltas arrive only for nodes in the interest set.
