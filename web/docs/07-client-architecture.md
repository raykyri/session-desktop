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
      layout/                AppShell, Sidebar
    routes/
      login.tsx  home.tsx  highlights.tsx
      research.$treeId.tsx  settings.tsx  admin.tsx
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
      navigation.ts          feed mode, feed scroll anchors, sidebar
      drafts.ts              composer drafts (sessionStorage + server interface_drafts)
      overlays.ts            dialog/menu/lightbox stack
      liveTurns.ts           per-node streaming buffers
      lightboxes.ts          image/diagram (useSyncExternalStore, ported)
      notifications.ts       toast list
      connection.ts          SSE status
    ui/                      design-system wrappers (08-design-system-and-styling.md)
    features/
      composer/  drafts/  highlights/  home/  import/  widgets/
      journal/  markdown/  palette/  research/  sidebar/
    lib/                     client-only helpers (clipboard, keyboard, dom search)
    styles/
      app.css                @import "tailwindcss"; @theme inline; @custom-variant; layers
      tokens.css             copied verbatim from src/styles/tokens.css
      prose.css              .research-prose, code, tables (from transcript.css/research-surface.css)
      tweet.css              .journal-tweet recipe (from research-surface.css)
      fonts.css              @font-face (from tokens.css:1-133)
    assets/fonts/ brand/
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
`data-appearance`, `data-body-font` and `--font-ui` on `<html>` from the
settings store (`App.tsx:1926-1969` logic). A
`<meta name="color-scheme">` replaces `getCurrentWindow().setTheme`.

Boot sequence: settings store hydrates from localStorage → router renders →
the shell route's `beforeLoad` resolves `auth.me` through the query cache and
redirects to `/login` if it is null (`/login` and `/dev/ui` are outside the
guard) → its loader warms `settings.get`, `system.runtimeConfig`,
`workspaces.list`, `research.listTrees`, and `folders.get` in parallel, without blocking the first paint on them
→ `SessionBoot` initializes the SSE subscription, activates the draft persistence listener, and updates local settings with the authoritative server configuration. There is no "window ready" handshake because the desktop's hidden-window
flash prevention is unnecessary in the browser.

The sign-in page extracts the error parameter returned in the redirect URL
(`/login?error=not_allowed|invite_required|invite_invalid|expired_state|
missing_code|exchange_failed|profile_failed`, `server/src/auth/github.ts`) and
sends `return_to` back through `/auth/github`, with a sign-up code from
`/login?signup=<code>` (or the earlier `?invite=<code>`) as `invite`. The two
`invite_*` refusals are about sign-up codes and say so ("A sign-up code is
required to create an account. Open the sign-up link you received.", "This
sign-up code is invalid or has already been used."); thread invitations are
a separate thing (`10-home-feed-journal.md` §4b). If a deployment has no GitHub credentials, the server returns a 503 page for
that route instead of redirecting, so the sign-in page receives no error
parameter.

## 3. Routes

| Path | Component | Notes |
| --- | --- | --- |
| `/login` | `LoginPage` | GitHub button; shows allowlist/closed messages |
| `/` | `HomePage` | Home (workspace mode) or a public feed + composer; search `?ws=` |
| `/f/$folderId` | `FolderPage` | signed in; one folder |
| `/drafts` | `DraftsPage` | signed in |
| `/drafts/$draftId` | `DraftPage` | signed in; `DraftView` |
| `/archive` | `ArchivePage` | signed in |
| `/trash` | `TrashPage` | signed in; `TrashList` |
| `/highlights` | `HighlightsPage` (lazy) | |
| `/r/$treeId` | `ThreadPage` (lazy, §10) | search `?sel=&node=&highlight=&edit=`: `sel` is each column's selection (`09` §4); `key={treeId}` remount |
| `/settings` | `SettingsPage` (lazy) | the desktop's rows in its order: Require ⌘↵ to send ("A thread's question boxes always require ⌘↵. This setting controls the Home ask box, drafts and note follow-ups."), Research instructions (signed in; saved 500 ms after typing stops and on blur, placeholder `DEFAULT_RESEARCH_LAUNCH_INSTRUCTION`, hint "Sent with every research launch"), Widgets in answers, then the web's Default model (signed in; replaces the desktop's agent choice) and Notifications (server notifications only); a separator; Appearance (Dark, Light; a stored `system` shows as what it resolves to), Color theme, Body font, Show keyboard shortcut hints, Reduce motion. Usage is a dialog in the account menu (`features/account/UsageDialog.tsx`); Text size and Default workspace have no row (the workspace switcher's Make default workspace sets the default) |
| `/admin` | `AdminPage` (lazy) | admin only: user list with usage and model access |

Search params validated with zod (`validateSearch`). The workspace scope
`ws` defaults to `settings.defaultWorkspaceId`; changing it calls
`settings.update`. A link or navigation to another route carries `ws` alone
(`workspaceSearch` in `features/sidebar/scope.ts`, the sidebar's places,
the account menu, the palette and the app shortcuts), so the thread page's
`sel`, `node`, `highlight` and `edit` stay behind. Cross-page navigation uses router history, so the
desktop's `ResearchWorkspaceHistory` reducer is retired; `HistoryNav` in the
thread header calls `router.history.back()/forward()` and disables Forward
using the router's history index and the furthest index this tab reached
(sessionStorage). Within a thread the selection is the `?sel=` parameter, so
browser history is also the thread's visit history (`09` §4).

Synthetic tab ids for Cmd-1..9 and cycling (the desktop's `sidebarMode`, now `packages/shared/src/lib/sidebarMode.ts`) stay;
they resolve to routes.

## 4. State management (ADR-6)

### 4.1 Server state — TanStack Query

Query keys (factory in `api/queries.ts`):

```
["me"]                                   auth.me
["settings"]                             settings.get
["runtimeConfig"]                        system.runtimeConfig (models)
["usage"]                                usage.summary
["workspaces"]                           workspaces.list
["folders", workspaceId]                 folders.get
["trees", { workspaceId, includeArchived }]  research.listTrees
["tree", treeId]                         research.getTree
["nodeContent", nodeId]                  research.getNodeContent
["activity", { scope, workspaceId }]     infinite: feed.recentActivity
["feedRoot", treeId]                     feed.recentQueriesForTrees (batched per tick)
["drafts", workspaceId]                  drafts.list
["trash", workspaceId]                   research.listTrash
["highlightsFeed", workspaceId]          highlights.listFeed
["activeNodes"]                          research.listActivity
["adminUsers"]                           admin.listUsers
```

The factory is defined in `api/cache.ts` and re-exported from `api/queries.ts`,
which is the import path the rest of the client uses: the cache writers the
bridge and the mutations share need the keys, and the hooks need the writers,
so the keys sit below both rather than beside one of them.

Defaults: `staleTime: Infinity` for event-patched lists (events keep them
fresh), `refetchOnWindowFocus: false`, `retry: 1`. `usage.summary` and
`admin.listUsers` use a 30-second stale time because events do not update token
counts, which would otherwise remain stale after the initial load.
Mutations write their returned objects into the cache (`setQueryData`) using
the reducers from `shared/research/events.ts` (ported `researchEvents.ts`:
`patchTreeSummary`, `upsertTreeDetailNode`, `removeTreeDetailNodes`,
`upsertActivityNode`, …).

Because the originating tab receives broadcast events for its own mutations, cache updates are applied both by the mutation response and by the subsequent SSE event. Field-replacing reducers are idempotent and
both writers may run; the count reducers on a tree summary are deltas and have
exactly one writer per change: the mutation applies the delta from the node it
is replacing (which it must read before overwriting it), and the event skips
its own delta when the referenced node is already in the caches. A mutation
that creates a node (fork, a follow-up sent at once, a note follow-up) does
the same in the other order: it counts the node only when no cache held it,
since its event may arrive before the response. A created highlight is added
only when its event has not added it already. Mutations therefore avoid invalidating lists whose count fields are patched by events, preventing race conditions where a full refetch and an event delta might double-increment a counter.

A mutation that answers with a whole detail (create, retry, a new note)
writes its summary with `writeDetailSummary` (`cache.ts`): a list that holds
the thread gets the recomputed counts merged over its own row, which keeps
the list's workspace, `trashedAt` and the reader's role; a list that does not
hold it gains it only for a created thread, and only in the reader's own
lists for the thread's workspace (never for someone else's thread). The
`research.tree.created` event follows the same rule.

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
- `research.folders.changed` → invalidate that workspace's `folders` query
  (the event carries no state); `research.trash.changed` and
  `research.drafts.changed` invalidate that workspace's `trash` and `drafts`
  queries. `feedRoot` entries are seeded by `research.tree.created`, patched
  by node and feed-item events, and dropped by `research.tree.removed`.
- `workspace.*`, `settings.updated`, `models.updated` → targeted
  `setQueryData` or invalidate.
- `research.run.thinking` → `liveTurns` thinking indicator.
- `notification.requested` → `notifications` store, unless
  `showNotifications` is off (`03-api-and-events.md` §3). The setting
  applies to these only; client toasts (`lib/toast.ts`) always show.
- `research.tree.removed` with `trashed: true` keeps the thread's saved page
  state (`features/thread/persistence.ts`) for Restore; without it (a
  deletion) the state is forgotten. A reconnect clears the recap spinners
  (`stores/recapPending`), whose `pending: false` may have been lost.
- A reader outside a thread's event audience between visits (a signed-in
  viewer of a public thread, or a guest) re-reads a cached thread and its
  presence when the page opens it (`useRefetchThreadOnOpen`); a guest's open
  thread is also re-read on focus and every 15 s while a run is active
  (`useTreeDetail(…, { eventless })`). A refused refetch (NOT_FOUND) shows
  the unavailable state even while the cache holds the thread.
- `research.sharing.changed` → invalidate the tree lists, the shared lists
  (`["shared", place]`), the thread, its members and invitations;
  `research.invites.changed` invalidates `receivedInvites`;
  `notification.requested` (whatever the Notifications setting, which only
  decides the toast) and `notifications.read` invalidate `["notifications"]`
  (the inbox and its unread count, also a reconnect key);
  `research.presence.changed` replaces `["presence", treeId]` (the viewer
  list it carries). `research.tree.removed` also drops the thread from the
  shared lists, and re-reads the thread's detail when a page has it open (a
  member removed or a thread moved to its owner's Trash: the refusal shows
  the unavailable state) instead of dropping it, which would leave the page
  on its copy.
- Tree events from someone else's change (`research.tree.updated`,
  `archived`, `restored`, `research.document.updated`) leave out the reader's
  own `role`, `lastViewedAt`, `followed`, `archivedAt`, `trashedAt` and
  `trashedBy`; `mergeTreeEvent` (`cache.ts`) keeps the cached values of the
  fields an event omits instead of replacing the cached tree, and
  `patchSummaryFromTreeEvent` keeps a summary's `archivedAt` the same way.
  What another person's Archive or restore means for the reader's own copy
  (the owner's Archive shows to members) is read back: such an event
  invalidates the thread's detail as well as the lists.
- On (re)connect: `invalidateQueries()` for list queries and a snapshot
  refetch for every displayed active node; the `liveTurns` store applies only
  `seq === lastSeq + 1` and refetches on gaps
  (`05-run-lifecycle-and-streaming.md` §4, §9). The bridge also publishes the
  interest set (`events.setInterest`, debounced 200 ms) from a reference-counted
  registry the mounted document views join through `useNodeInterest`. The
  open thread joins a second registry through `useThreadInterest` (the
  `treeIds` of the call: presence, and a public thread's events for a
  reader who is not a member); while one is open the bridge declares the set
  again every 30 s (`TREE_INTEREST_RENEW_MS`, inside the server's 90 s
  lapse) and when the tab becomes visible, and refetches the thread when the
  last declaration is older than 90 s. Guests have no stream, so no live
  updates and no presence.
- The first event of every connection is `connection.ready`, with the
  `connectionId` that `events.setInterest` addresses; a second one means the
  link reconnected, which is what triggers the invalidation and the snapshot
  re-read above.

Connection status (`connection` store) controls a status indicator and enables
the snapshot-poll fallback for displayed active nodes when SSE is down, once
the 10 s grace in `connection.shouldPollSnapshots` has passed
(`05-run-lifecycle-and-streaming.md` §9). A subscription error that names
`UNAUTHORIZED`, or one after which `auth.me` answers `null`, is the session
ending rather than the network dropping: the bridge navigates to `/login` with
the current path on `?redirect=`, to prevent the client from repeatedly attempting to reconnect with invalid session credentials. `/login` sends a tab that already has a
session on to that path.

### 4.3 UI state — Zustand

| Store | Contents | Persistence |
| --- | --- | --- |
| `settings` | `UserSettings` mirror | localStorage `session.settings.v2`; server copy authoritative |
| `navigation` | `feedMode`, feed scroll anchors, `sidebarCollapsed`, `sidebarWidth` (a thread's selection, scroll offsets and expansions are in `features/thread/persistence.ts`, localStorage `session.thread-navigation.v1`) | localStorage `session.navigation.v2` |
| `drafts` | home composer drafts (text, model, effort, images), per-node follow-up drafts, targeted asks in progress; `owner` = the account that wrote them | sessionStorage `session.drafts.v2` + `interfaceDrafts.set` (debounce 120 ms, flush on `pagehide`) |
| `overlays` | stack of open dismissable layers with `onEscape` | none |
| `liveTurns` | `Map<nodeId, { turns, inFlightText, inFlightTurnId, lastSeq, status }>` | none |
| `lightboxes` | image/diagram lightbox state (ported `useSyncExternalStore` stores) | none |
| `notifications` | toast list (≤ 20), dedupe by id, optional action (Undo) | none |
| `folderDialogs` (`features/home/FolderDialogsHost.tsx`) | the open New folder / Rename dialog and pending folder delete | none |
| `connection` | `connecting | open | closed`, lastEventId | none |

Stores expose selectors; components subscribe to slices. No module-level
refs mirror state.

Unsent text kept in the browser belongs to one account
(`stores/localAccount.ts`, `lib/localOwner.ts`). The drafts store records its
account in `owner`; localStorage `session.local-owner.v1` (`{ userId }`, null
when signed out) records the account of the thread pages' state
(`session.thread-navigation.v1`, which holds the unsent branches). Every
answer of `auth.me` in a route guard claims both for that session before a
view renders: drafts and thread state of another account, or stored before
the stamp existed, are dropped, with the drafts' writes still waiting for the
server. Sign-out (`useLogout`) drops them and records a signed-out browser.
An expired session (the event bridge's sign-out) or a page loaded with no
session keeps them recorded for their account but hidden: reads return
nothing and writes are skipped, so the same account signing in again gets
its unsent text back and a different account drops it. When
another tab records a different account, a tab drops what it holds without
writing it and reloads; until it does, its thread-state writes and draft
pushes are skipped, because its requests already go out with the other tab's
session. The same account keeps its drafts and thread state across reloads.

### 4.4 Escape and dismissal

Base UI handles Escape for its own dialogs/menus/popovers with correct
nesting. Non-library layers (lightboxes, DOM search bar, selection popover)
register in `overlays` with a priority; a single
capture-phase keydown handler in `AppShell` calls the top entry's `onEscape`.
This replaces `App.tsx:9094-9220`.

## 5. Keyboard shortcuts and command palette

`shared/app/shortcuts.ts` is the web's `resolveAppShortcut`: the desktop's
chord table (`packages/shared/src/lib/appShortcuts.ts`) for the surfaces the
web has, plus Shift-Cmd-H for Home. `AppShell` registers a single
capture-phase keydown listener that is bypassed when a Base UI overlay is
active (allowing the library to manage nested dialog and menu dismissals
natively), delegating all other key events to the table. Every chord in it
also works from a text field (Cmd-J, "focus follow-ups", exists to be
pressed from one), and none repeats while held. It dispatches:

Cmd-N/T and Shift-Cmd-H Home with the caret in its ask box
(`stores/homeFocus`) · Shift-Cmd-G toggle sidebar · Cmd-, (Ctrl-, off
macOS) settings · Cmd-K palette · Cmd-J focus the current level's ask box
(window event consumed by the thread page) · Cmd-O workspace menu. Not app
chords: Cmd-F DOM search, the bare H/A/E keys on a selection
(`shared/lib/researchHighlights.ts`), and Back and Forward within a thread,
which are the browser's (Cmd-[ / Cmd-] on macOS, Alt-Left/Right elsewhere;
the Back and Forward buttons' titles name them).

Browser conflicts: Cmd-N/T open new windows/tabs in browsers and cannot be
intercepted, hence Shift-Cmd-H (`RESEARCH_HOME_SHORTCUT_LABEL` is `⇧⌘H`).
The web-only digit, tab-cycle and Cmd-Alt-Up/Down chords were removed in
review round 3; the desktop has none of them. The desktop's Shift-Cmd-E
(source browser) has no web surface.

Command palette (`features/palette`): Research section (one entry per tree,
"N running" hint) and Actions section (Home, Toggle sidebar, Settings),
built only while open (`App.tsx:8098`).

## 6. Composer

`ResearchQueryComposer` (`src/components/research/ResearchQueryComposer.tsx`)
ports with the Ask/Note switch, the model menu with its Effort submenu
(`QuestionModelPicker`; ⌃Tab cycles the model), Save draft, image
attachments (`lib/researchImages.ts`, uploaded through `POST /api/images`),
draft persistence (prompt, model, effort, images), `growComposerTextarea`, and
`isComposerSubmitShortcut` (⌘↵ on Apple platforms, Ctrl↵ elsewhere; Enter
inserts a newline). Behavior: `10-home-feed-journal.md` §6. Dropped: the "Ask
network" toggle, provider cycling and custom model input. Slash commands are
not ported.

## 7. Shared package usage from the client

The client imports types and pure logic from `@session/shared`; it must not
duplicate any of it. Modules ported into `shared` are listed in
`00-plan.md` Phase 1. Client-only modules ported from `src/lib/`: `clipboard`
(minus the Tauri branch), `transcriptSearch`, the DOM half of
`composerTextarea` (`growComposerTextarea`; the height math is in shared),
the `localStorage` layers of `researchNavigation` and `researchFolders`,
`diagramLightbox`, `imageLightbox`, `windowFocus` (reduced to
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
- `safeHref` from `shared/links` allows only `http:`, `https:` and
  `mailto:`, and returns the resolved absolute URL so a protocol-relative
  href cannot resolve unpredictably downstream. The desktop's `session-file:`
  scheme is unsupported on the web because web agents cannot access a local
  filesystem (`11-artifacts-and-browser.md` §1). External links open with
  `target="_blank" rel="noopener noreferrer"`.
- Remote images in Markdown stay blocked (`BlockedMarkdownImage`). Tweet media
  is served from this origin: a snapshot hydrated by the server points at
  `/embeds/<hash>` (`03-api-and-events.md` §5), so a rendered card makes no
  request to X. The twimg hosts stay in `img-src` for snapshots stored before
  the cache existed.
- Diagram SVG passes through DOMPurify's SVG profile with the
  `afterSanitizeAttributes` hook (`DiagramBlock.tsx:106-166`).

## 10. Performance

- Route-level code splitting (`routes/chunks.ts`): the thread page
  (`/r/$treeId`, with the Markdown pipeline only it uses), Highlights, the
  notification inbox, Settings and Admin are `lazyRouteComponent` chunks. Home, the place views
  (Home's feed on another place), the login page and the invitation page
  stay in the main chunk, since a first load shows them. While a chunk
  loads, the thread route shows the page's own placeholder
  (`features/thread/ThreadPending.tsx`: the thread's header with the title a
  cache holds and "Loading research…", the same component the page shows
  while the detail loads), the others `RoutePendingPanel` ("Loading…"). On
  a first load it shows at once; on a navigation the previous page stays
  until the router's `pendingMs`. A feed card starts loading the thread
  chunk on pointer enter and focus (`FeedCard` `onIntent`), and links
  preload on intent (`defaultPreload: "intent"`). Measured with
  `vite build` (2026-10, gzip as Vite reports it): the entry chunk went
  from 1,378.5 kB (432.7 kB gzip) before the split to 631.0 kB (202.4 kB
  gzip) after it, the notification inbox included; everything a first load
  fetches (entry and its static imports) from 1,379.6 kB to 967.2 kB; the
  thread chunk is 410.4 kB (129.6 kB gzip).
- MathJax, mermaid and viz are lazy chunks within the thread page's.
- Feed virtualization with TanStack Virtual (replaces the hand-rolled canvas
  in `ResearchActivityFeed.tsx`).
- `OversizedMarkdownPolicy` retained; react-markdown re-parses on each render,
  so the timeline memoizes per turn id + revision.
- `liveTurns` deltas update one component subtree; list queries are not
  touched during streaming; deltas arrive only for nodes in the interest set.
