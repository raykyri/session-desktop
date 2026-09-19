# Research document view

Port of `src/components/research/ResearchDocument.tsx` (5,593 lines, 35
`useState`, ~30 mirror refs) and its satellites (`ResearchMessage.tsx`,
`ResearchRecap.tsx`, `ResearchRecapDialog.tsx`, `ResearchThreadActions.tsx`,
`ResearchDocumentChrome.tsx`, `DocumentComposer.tsx`) to
`packages/client/src/features/research/`. This is the largest and most complex UI subsystem. The port preserves its
structure and algorithms, migrates state management to TanStack Query and
Zustand, and
deletes the WebKit and Tauri workarounds.

## 1. Concepts

- **Tree**: one research investigation. **Node**: a question with its
  answer; the root node is the tree's first question.
- **Spine (inline chain)**: the sequence of nodes shown as one document. A
  follow-up with `inline: true` continues its parent's answer in the same
  page; at most one inline child per node. `inlineChainFor(nodes, nodeId)`
  (`src/lib/researchThreads.ts:81`) walks up while `inline` and down through
  the oldest inline children.
- **Branches**: non-inline children, shown as cards in a rail beside the
  parent's answer. A branch with a `queryAnchor` (a highlighted passage) is
  *anchored*: its card sits level with the passage and a connector line joins
  them; other branches *stack* at the top of the rail.
- **Page**: the spine for `selectedNodeId`. Selecting a node in another
  chain switches page; within the same chain it scrolls.

## 2. Component tree (ported one-to-one)

| Component | Source | Responsibility |
| --- | --- | --- |
| `ResearchPage` (route) | `App.tsx:11929` wiring + `ResearchDocument:1760` | Loads `tree` and route params, owns per-tree stores, renders header, search bar, scroller, portals |
| `DocumentHeader` | `:5105` | `HistoryNav`, breadcrumb, "N in thread · M branches" chip, sidebar restore, full-transcript toggle |
| `ThreadSegment` (memo) | `:1621` | One spine node: `SegmentPrompt` + grid of `ConnectorOverlay`, `AnswerPane`, `FollowupRail`; registers anchor and grid elements |
| `SegmentPrompt` (memo) | `:1514` | Back link (index 0), "Reply to" snippet (index > 0), quoted passage blockquote, `ResearchUserMessage`, the question's embedded posts (`TweetAttachments`), root footer with `ThreadActions` (Follow/Bookmark), model summary, relative time |
| `AnswerPane` (memo, custom comparator) | `:1118` | Loading/error/failure states, `Recap`, empty-state copy cascade, "Show N earlier response items", the selection root, footer (word count, duration, hidden-highlights notice, copy, answer menu) once the run settles; while it is active a single status line replaces the footer, carrying the queue position, "Working…"/"Thinking…", the elapsed time and a confirmed Cancel link |
| `TimelineItem` (memo) | `:782` | One timeline message: markdown body, raw disclosures, activity disclosures, "Excluded from active context" chip |
| `FollowupRail` (memo) | `:1391` | Docked ask composer slot, stacked cards, anchored cards (absolute `top`) |
| `ConnectorOverlay` (memo) | `:1485` | SVG paths and endpoint dots per connector |
| `FollowupComposer` | `renderComposer :4841` | Tail composer and the docked ask composer (same component, `docked` prop); mode menu thread/branch; hints; Cmd-Enter / Shift-Cmd-Enter |
| `SelectionPopover` | `:5430` | Highlight (H) / Expand-Merge (E) / Ask (A) |
| `NodeContextMenu` | `:5245` | Copy thread as Markdown, Retry run, Generate summary, Edit document, Delete |
| `RecapDialog` | `ResearchRecapDialog.tsx` | instructions → candidate → apply (the desktop's adapter/model picker is dropped; recaps run on `gemini-flash`) |
| `DeleteBranchDialog` | `:5501` | confirm with active-run refusal |
| `DocumentEditor` | `DocumentComposer.tsx` | edit modal for `document` roots (creation not exposed, as today) |

The posts a question links to are resolved once, at launch, and stored on the
node (`journal/attachments.ts`); `SegmentPrompt` renders the snapshots below
the question and drops from the displayed text any permalink that trailed it
and did embed (`visibleResearchPrompt`, ported from
`ResearchMessage.tsx:63`). The stored prompt is never rewritten: it is what
the run was launched with, and a post that did not resolve leaves its
permalink readable. The card itself is `TweetEmbed`, the same component the
Home feed and a journal entry mount (`10-home-feed-journal-encyclopedia.md`
§2); the desktop's side-by-side treatment for several posts in one message is
not ported, so they stack.

`ResearchRecap` renders only for `kind === "run"`, `status === "complete"`,
and `recap.responseRevision === content.responseRevision`. The desktop's
`conversation` kind (terminal exports) and its parallel rendering path are
not ported.

## 3. Layout

CSS Grid per segment, two tracks (`research.css:932`):
`grid-template-columns: minmax(0, 640px) minmax(220px, 260px)`, gap
`clamp(28px, 4vw, 52px)`, `align-items: start`, `position: relative`.
Content column `width: min(100%, 1160px)`, centered. Segments are a flat
vertical list with 44 px between them. In Tailwind: the grid becomes
utilities with arbitrary values referencing tokens
(`grid-cols-[minmax(0,640px)_minmax(220px,260px)]`), and the desktop's
literal 640 px (a WebKit `var()` workaround explained at `research.css:838-843`,
applied at `:940`) becomes a token `--research-answer-max-width`. The grid
class is `RESEARCH_COLUMNS_CLASS` (`layout.ts`), and a segment's prompt row
lays out on it too, so the prompt and the answer share one wrapping edge.

Rail: `position: relative` flex column. Stacked cards flow; anchored cards
and the docked ask composer are `position: absolute; left: 0; right: 2px`
with computed `top`. Collision pass (`:3582`): sort desired tops, measure card
heights, cascade downward with a 12 px gap. Ask displacement (`:3635`):
clearing the inline transforms animates the cards back to their default layout positions.

Measurement: a per-segment element registry (`anchor`, `grid`, `root`,
`aside`) filled by ref callbacks (`:2044-2073`); one `ResizeObserver` on the
content container (width changes > 0.5 px) plus `resize`, debounced 140 ms
into a layout nonce; a `MutationObserver` on annotated segments' response
roots only (rAF-coalesced) into a highlight-DOM nonce. Positions from
`getBoundingClientRect` of the passage `Range`, grid, and rail.

Connectors (`:3477`): endpoints from `researchAnchorConnectorEndpoints`
(`researchSelection.ts:26`: passage right edge + 8 px, card left edge − 6 px,
card Y clamped 24 px inside the card), grid-relative; lane assignment by
greedy interval coloring with 8 px clearance; lane 0 straight, others use
`connectorElbowPath` with 14 px stagger capped at 25 % of the span; SVG
`position:absolute; inset:0; overflow:visible; pointer-events:none`,
`stroke-dasharray: 2 5`.

Responsive at `max-width: 900px` (`research.css:2103`): single column, rail
below the answer with a top border, connectors hidden, anchored cards and the
docked composer become static, transforms cleared.

All of this ports as-is; only the styling moves to utilities and the scoped
`prose.css`.

## 4. Data flow on the web

Desktop: `detail` (tree + nodes) arrives as a prop replaced on every
`research.node.updated`, which the Rust side emits once per text delta that
changes the 220-char preview (`state.rs:9152`, `:8735`) with only the
frontend's 16 ms coalescing as a limit, so up to ~60×/s; turns are polled at 1 Hz for each chain node, requiring extensive memoization workarounds (`useStableValue`, `segmentViewCacheRef`, `sameSegmentNode`, and string effect dependencies) to mitigate frequent re-renders.

Web:
- `useQuery(["tree", treeId])` gives `ResearchTreeDetail`; events patch it
  in place through the shared reducers, and `response_preview` updates are
  coalesced server-side to ≤ 2/s, so segment props change only when their
  node changes. Nodes are selected with `useMemo` per id, so `ThreadSegment`
  memoization works without mirror refs.
- `useNodeContent(nodeId)` = `useQuery(["nodeContent", nodeId])` for the
  snapshot (turns, in-flight text, `seq`), combined with the `liveTurns`
  store while the node is active. The hook returns `{ turns, inFlightText,
  responseRevision, source: "live" | "snapshot", error }`; the store applies
  ordered deltas and refetches on gaps; on `research.run.finished` plus the
  terminal `node.updated` it refetches once and clears the live buffer
  (`05-run-lifecycle-and-streaming.md` §4, §9). Snapshot polling at 2 s only
  while SSE is down.
- `fetchStamp` (`${status}:${responseSnapshotAt}:${recap.id}`) is replaced by
  query invalidation keyed on those fields in the event bridge.
- Highlight mutations (`highlights.create/remove/removeMany`) write the
  returned value into the `tree` cache node's `highlights`
  (`patchNodeHighlights` logic, `:4073`); the write waits for server confirmation rather than applying optimistically,
  because highlights render from persisted IDs. A provisional ID would briefly
  duplicate the persisted highlight in the overlap layer. Create-then-remove ordering for Expand is preserved (`:4134`).
- Mutations owned by the page (previously props from `App.tsx`):
  `research.forkNode`, `cancelNode`, `retryNode`, `renameTree`,
  `renameNode`, `removeBranch`, `removeTree`, `setTreeFollowed`,
  `setTreeBookmarked`, `updateDocument`, `markTreeViewed` (on mount and when
  the tree gains a completion while open), `recaps.*`.
- Per-tree persistent UI state (`researchNavigation.ts`: `selectedNodeId`,
  `scrollByNode` with 15-min TTL, `expandedByNode`, `askByNode`,
  `followupDraft`, `focusHighlight`) moves into the `navigation` and
  `drafts` stores keyed by tree id; `selectedNodeId` is the `?node=` search
  param with the store as fallback for reload without params.
- `responseRevision` remains the anchor coordinate system and concurrency
  token; a changed revision drops the open selection popover and ask.

## 5. Highlight and selection flow (ported verbatim)

Algorithms live in `shared` (`researchSelection.ts`, `researchHighlights.ts`)
and the DOM glue in `features/research/selection/`:

1. `mousedown` on the selection root records the flat offset at the pointer
   (`flatOffsetAtPoint`, TreeWalker over text nodes; `caretPositionFromPoint`
   with `caretRangeFromPoint` fallback) and eligibility: Highlight API
   present, node has a `responseRevision`, target not in a non-text row
   (`.tool-block, .thinking-block, .activity-group-block`).
2. Past a 3 px drag threshold, each rAF snaps the native selection with
   `createResearchSelectionSnapper(root.textContent, lang, boundaries)`
   (`Intl.Segmenter` words, pictographic graphemes as units, units split at
   message seams, attached punctuation expanded) and re-applies it with
   `setBaseAndExtent` keeping focus on the pointer side. The
   `selectionchange` re-snap pass (WebKit) is kept; it is harmless elsewhere.
3. `mouseup` → `captureHighlightSelection`: exactly one segment root; not
   touching a non-text row; not whitespace-only unless it intersects a
   highlight.
4. Projection `answer-v1` is `root.textContent` of the response content
   root: every rendered text node in DOM order, no separators. Showing the
   full trace changes the projection, so highlights are created only against
   the collapsed answer's revision and hidden ones are reported
   ("N highlights hidden · Show full transcript").
5. Anchor: `{version: 1, projection: "answer-v1", responseRevision, start,
   end, exact, prefix, suffix}` with 128 chars of context on each side,
   clamped to the enclosing `.research-response-message`; surrogate pairs
   never split.
6. Popover placement: `researchSelectionActionPlacement` on the last client
   rect; beside when width fits (260 px, 340 px with Expand), else below;
   `offscreen` when scrolled out; repositioned on scroll/resize via rAF;
   dismissed on outside mousedown or Escape. Bare keys H/A/E when the target
   is not editable.
7. Painting: CSS Custom Highlight API only, no wrapped spans. Four registry
   layers: `session-research-highlights`, `session-research-query-anchors`,
   `session-research-highlight-overlaps` (priority 1),
   `session-research-selected-highlights` (priority 2), styled in
   `prose.css` with the `highlight-pseudo-literal` marker. `Highlight`
   objects are created once and mutated (WebKit repaint bug; harmless
   elsewhere). DOM search uses the same registry with distinct names.
8. Anchor relocation (`resolveResearchHighlightOffset`): same revision + exact
   + both contexts → stored offsets. Otherwise, use the nearest occurrence of `exact` whose prefix
   and suffix match, then a single occurrence matching one side. If no match is
   found, mark the highlight as orphaned rather than guessing; the
   hidden-highlights notice lists orphaned highlights.
9. Click on a painted highlight (`selectAnnotationAtPoint`) selects the whole
   annotation and re-enters capture so removal goes through the same popover.
   Hover sets `is-highlight-hovered` and raises the paired card + connector.
10. `?highlight=<id>` (from the Highlights feed): after the page visit
    restores and the passage has painted, scroll so the range sits
    `max(72px, height/3)` from the top; then clear the param.

Browser support: the Custom Highlight API is available in Chromium, Safari,
and Firefox ≥ 140. If the API is unavailable, text selection still works, but only saved highlights are rendered via a DOM fallback overlay, since rendering transient selection layers using DOM elements causes prohibitive repaint costs. The layer is one absolutely positioned
element appended after everything the renderer produced, holding one box per
client rect of each resolved range. Wrapping highlighted ranges in `<mark>` tags is not feasible: because React manages these DOM nodes, wrapping them alters the DOM hierarchy and triggers reconciliation errors.
The layer contributes no text, so the `answer-v1` projection is identical with
and without it, and it is repainted on the same reflow nonce the geometry
passes use.

## 6. Navigation within the document

`applySelection` (`:2578`): record outgoing scroll; set `?node=`; same chain
→ `scrollToSegment` (smooth, `block: "start"`); different chain → begin page
visit (scroll top, reset per-visit state). `selectNode` also pushes the
per-tree history stack (`researchHistory.ts`), pruned when nodes are deleted.
Cmd-[ / Cmd-] and Alt-Left/Right (non-editable target) and mouse buttons 3/4
navigate the stack and fall through to router history when exhausted. Trackpad
swipes are left to the browser.

Cmd-J focuses the tail composer (window event from the shortcut dispatcher).
Escape exits ask mode.

Scroll restoration: `useLayoutEffect` gated on "every chain node has content
or a terminal error" and latched once per visit; if nothing was saved and the
selected node is mid-chain, scroll to that segment; `recordScroll` debounced
250 ms into the store; final flush on unmount; `pendingScrollNodeId` scrolls
to a newly submitted inline follow-up when the updated detail includes it.

"Show earlier": `TIMELINE_ITEM_RENDER_WINDOW = 100`; expansion persisted per
tree (`expandedByNode`) because saved scroll offsets depend on it; full-trace
toggle is per visit.

## 7. Timeline rendering

New in the web view: a Sources footer under the answer listing the distinct
URLs from `web_search` and `web_fetch` results (title, domain, open in new
tab), document chips under the prompt for attached documents (open in the
preview panel), a thinking indicator driven by `research.run.thinking`, and
the model label per segment (a thread may mix models).

`buildTimelineItems(turns)` → `timelineItemsAfterLastToolCall` (collapsed
answer) unless the full trace is shown; window 100 items from the tail (the
answer is at the bottom); `hasTranscriptActivity` gates the header toggle.
Oversize policy constants: `MARKDOWN_CHAR_LIMIT = 100_000`,
`PLAINTEXT_DISPLAY_CHAR_LIMIT = 1_000_000`, `ACTIVITY_PAYLOAD_CHAR_LIMIT =
200_000`. Activity disclosures via `TranscriptActivityItem`; thinking is an
activity item. Empty-state cascade: failed → cancelled → `sourceError` →
complete-but-unavailable → active ("Generating response…" or
"Working…") → "No response was generated." Duration text from a 1 s tick
that runs only while a chain node is active: bare while the run is active
("1m 08s", on the status line beside "Working…"), "Ran for …" or a bare
duration in the settled footer, and nothing at all before the run starts —
the status line already reports that.

Streaming: the live turns from `liveTurns` feed the same
`buildTimelineItems`; the in-flight assistant turn's text grows in place, so
the markdown for that block re-renders per delta (≤ 20/s). The desktop memoizes each `ResearchTimelineItem` so unaffected items do not
re-render. When the
snapshot arrives, the same `Turn[]` shape produces identical timeline keys,
so the DOM is reconciled without a flash.

Retry and cancel surfaces: answer-pane Retry (`failed | cancelled |
interrupted`, not archived; `interrupted` normally auto-resumes and shows
"Resuming…" first), "Queued · N ahead" on the status line while `queued`
behind other runs (a claimed run reads "Working…" instead; there is no
second "Queued" line), a Cancel link beside "Working…" on
every active segment (behind a confirm dialog), composer "Retry follow-up" for a settled inline tail, "Retry run" in
the node menu. `paneId`-based conditions (`cancellationNeedsRetry`,
`!paneId`) are removed: the web has no pane-backed runs.

Composer gating (`:4755-4830`): target = ask node, or last complete chain
node (branch mode), or the tail (thread mode); `canFollowUpFrom` requires
`complete`; `canContinueThread` also needs a free inline slot; hints for
failed/cancelled/interrupted tail and branch-from-last-complete. The
follow-up composer carries a model chip defaulting to the parent's model
(gated models hidden for non-admins) and an attach button for documents.
Cmd-Enter submits in the selected mode, Shift-Cmd-Enter always branches.

## 8. Dialogs and menus

Rebuilt on Base UI wrappers: node context menu (right-click on a segment or
rail card), answer `⋯` menu, mode menu, `RecapDialog`, `DeleteBranchDialog`,
`RenameTreeDialog` / `DeleteTreeDialog` (`ResearchTreeMenu.tsx`),
`DocumentEditor`. `turnPaneRectFrom` clamping is dropped.

## 9. Removed

`paneId` plumbing, the `conversation` kind and `terminalExport` badge,
`legacyFollowupCount` label, WebKit literal-640px and `scrollLeft` pin, `overflow: hidden auto`
(replaced by `overflow-x: clip`), mirror refs, `useStableValue`,
`segmentViewCacheRef`, and custom prop comparators made unnecessary by the
normalized cache.

## 10. Tests carried over

`researchSelection`, `researchHighlights`, `researchThreads`,
`researchBranches`, `researchDocuments`, `researchHistory`,
`researchNavigation`, `turnTimeline`, `researchRecap`, `researchTreeMenu`,
plus new component tests: streaming swap without remount, sequence gap
refetch, `interrupted` rendering with Resume, anchored card collision cascade, connector lane
assignment, selection snapping on a fixture DOM, hidden-highlight notice
when the full trace is shown, `?highlight=` focus scroll.
