# Redesign candidate contract

Base directory: `/tmp/claude-0/-home-user-session-desktop/42988d43-d16c-5a35-836d-1c43a8851484/scratchpad/mocks` (called `$M` below).

## Goal

Redesign **Session** (the desktop app in `/home/user/session-desktop`, described in `$M/shared/brief.md`) so that:

1. A first-time user understands what the app is and what to do within the first minute.
2. It works well as a way to **chat with models** (ask, follow up, branch, compare providers, watch runs).
3. It works well as a way to **organize one's thinking**: an outline / knowledge base / knowledge graph, where answers, notes, highlights and sources become linked, reorganizable knowledge.

Each candidate takes the idioms of one reference application and applies them faithfully (layout, navigation model, density, typography, interaction conventions, terminology style), adapted to Session's objects. Do not clone a reference app's branding, logo, or product name in the UI; the app is still called Session.

## Deliverable

One file: `$M/candidates/<id>/r<round>.js`. Plain browser JavaScript (no modules, no imports, no libraries, no build step). It calls:

```js
window.SessionMocks.register({
  id: "<id>", round: 1,
  name: "Short candidate name",           // e.g. "Sheets & Groups"
  reference: "Ulysses",                   // the reference application
  summary: "One or two sentences on the concept.",
  principles: ["4-7 short bullets on the idioms adopted and why"],
  chat: "How chatting with models works in this design (2-4 sentences).",
  knowledge: "How outline / knowledge base / graph works (2-4 sentences).",
  firstRun: "What a first-time user sees and does (2-4 sentences).",
  changes: [],                            // round 2 only: what changed after self-review
  variants: [ { id: "a", name: "...", note: "one sentence on what differs" }, ... ], // 4 or 5
  fonts: "family=Inter+Tight:wght@400;600", // optional Google Fonts css2 query (only host allowed)
  css: `...`,                             // ALL selectors must start with .m-<id>-r<round>
  mount(root, ctx) { ...; return () => { /* cleanup listeners/timers */ }; }
});
```

- `ctx = { variant, theme, data, scope, setVariant }`. `theme` is `"light"` or `"dark"`; `root` also carries `data-variant` and `data-theme` attributes and the class `scope` (= `m-<id>-r<round>`). Support **both themes** with CSS custom properties defined on the scope class and overridden on `.m-<id>-r<round>[data-theme="dark"]`.
- `ctx.data` is the shared sample content from `$M/shared/data.js` (read its header comment). Render that content so candidates are comparable; you may add candidate-specific sample content inside your file when the data lacks something your design needs (e.g. a daily note), but keep the shared threads, questions, answers, sources and highlights as the core.
- The root is a fixed **1280×800** desktop window (the shell draws the outer frame and shadow and scales it to fit). Paint the full area, including your own title bar / toolbar with macOS traffic-light buttons where the reference app would have them. Do not rely on the page scrolling; scroll inside your own panes.
- The shell sets `box-sizing: border-box` globally. Never style bare element selectors, `html`, `body`, or `:root`. Never use `position: fixed` (use `absolute` within root). Do not use `alert/confirm/prompt`. No network requests other than the optional Google Fonts query. No external images (use inline SVG, CSS, or data: URIs).
- Variants switch on `ctx.variant` (rerendered via mount/cleanup on change). Variants are subtle-to-moderate alternatives within the same concept that are genuinely worth comparing (e.g. sidebar density, where the composer lives, whether the outline and chat are split or merged, graph as a pane vs. a mode, onboarding as an empty state vs. a guided sample workspace). Give each variant a real reason to exist. Offer 4 or 5.
- **Interactive**: clicking sidebar items, threads, notes, tabs, and toggles should change what is shown; the composer should accept typing and Enter should append a mock question with a simulated streaming answer (setTimeout); collapsing/expanding outline items should work; at least one first-run/empty-state path should be reachable from the UI (e.g. a "New workspace" or "Welcome" entry). Keyboard affordances matching the reference app are welcome (scope keydown listeners to root and remove them on cleanup).
- Keep the file under ~150 KB. Write clean, readable code; a small internal `h()` helper for DOM creation is fine. Use `textContent`/escaping for data strings.
- Copy: plain, technically precise language. No mannered prose, no anthropomorphic copy ("I'm thinking..."), no unnecessary analogies. Use Session's real object names unless your design deliberately renames something for clarity; if so, say so in `principles`.

## Checking your work

- Screenshot every variant in both themes:
  `cd $M && NODE_PATH=$(npm root -g) node shared/shot.mjs <id> <round> all both`
  PNGs land in `$M/shots/<id>-r<round>-<variant>-<theme>.png`; the script prints console errors. Look at the PNGs with the Read tool and fix what you see (overflow, clipped text, unreadable contrast, empty areas, misalignment).
- To test interactions, write your own short Playwright script (global `playwright`, run with `NODE_PATH=$(npm root -g)`) against `file://$M/shared/dev.html?load=<id>/r<round>.js#<id>.r<round>.<variant>`; the mock lives in `.sx-window > .mock-root`.
- Only edit files inside `$M/candidates/<id>/` and `$M/shots/`. Do not edit the shared files or another candidate's files. Do not modify the repository at `/home/user/session-desktop`.
