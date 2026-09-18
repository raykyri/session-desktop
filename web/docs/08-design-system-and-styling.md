# Design system and styling

Goal: keep the desktop's visual design (two color themes × two appearances,
semantic tokens, typography contracts documented in `docs/css-conventions.md`)
while moving component styling to Tailwind v4 utilities and library
primitives.

## 1. What is preserved verbatim

- `src/styles/tokens.css` (767 lines) → `packages/client/src/styles/tokens.css`,
  unchanged except: the `@font-face` blocks move to `fonts.css` with Vite
  asset URLs, and `background: transparent` on `:root` (macOS vibrancy)
  becomes `var(--workspace-bg)`.
- `reduced-motion.css` `@media (prefers-reduced-motion)` block.
- The switching model: `data-color-theme="green-blob|orange-blob"`,
  `data-appearance="dark|light"`, `data-body-font` on `<html>`, plus
  `.reduce-motion` on the shell.
- Fonts: DM Sans, Valley Sans (variable, bundled, OFL, `font-display: swap`),
  JetBrains Mono, Ioskeley Mono (`font-display: block`, `tokens.css:1-133`);
  the DM Sans half-pixel optical offset
  (`--font-ui-size-offset`). Local-font probing for Anthropic Sans Text and
  Inter is kept via `document.fonts.check()`; they remain unbundled.

## 2. Tailwind v4 integration (`styles/app.css`)

```css
@import "tailwindcss";
@import "./fonts.css" layer(base);
@import "./tokens.css" layer(base);

@theme inline {
  /* type scale: Tailwind's --text-* is font-size; the app's --fs-* feed it */
  --text-xs: var(--fs-xs);
  --text-sm: var(--fs-sm);
  --text-base: var(--fs-base);
  --text-input: var(--fs-input);
  --font-ui: var(--font-ui);
  --font-mono: var(--font-mono);
  --radius-sm: var(--radius-sm);
  --radius-md: var(--radius-md);
  --radius-lg: var(--radius-lg);
  --spacing-control-sm: var(--control-h-sm);
  --spacing-control-md: var(--control-h-md);
  --spacing-control-lg: var(--control-h-lg);
  /* colors: the app's --text-* ramp is a COLOR ramp; expose it as fg-* */
  --color-fg-primary: var(--text-primary);
  --color-fg-strong: var(--text-strong);
  --color-fg-secondary: var(--text-secondary);
  --color-fg-muted: var(--text-muted);
  /* … every --text-* token → --color-fg-* */
  --color-surface-workspace: var(--workspace-bg);
  --color-surface-panel: var(--panel-bg);
  --color-surface-popover: var(--popover-bg);
  --color-surface-field: var(--field-bg);
  --color-surface-card: var(--content-card-bg);
  /* … every surface token → --color-surface-* */
  --color-accent: var(--accent-color);
  --color-accent-soft: var(--accent-soft);
  --color-control: var(--control-bg);
  --color-control-hover: var(--control-bg-hover);
  --color-border-control: var(--control-border);
  --color-status-failed: var(--status-failed);
  /* … status, danger, highlight tokens */
  --color-focus-ring: var(--focus-ring);
  --shadow-popover: var(--popover-shadow);
  --shadow-dialog: var(--dialog-shadow);
  --z-popover: var(--z-popover);
  --z-dialog: var(--z-dialog);
  --z-toast: var(--z-toast);
  --z-context-menu: var(--z-context-menu);
  --transition-fast: var(--transition-fast);
}

@custom-variant light (&:where([data-appearance="light"], [data-appearance="light"] *));
@custom-variant warm (&:where([data-color-theme="orange-blob"], [data-color-theme="orange-blob"] *));
@custom-variant reduce-motion (&:where(.reduce-motion, .reduce-motion *));

@layer components {
  @import "./prose.css";
  @import "./tweet.css";
}
```

Because every themeable value is a token consumed through `var()`, utilities
like `bg-surface-panel text-fg-primary` re-resolve when the root attribute
changes; the `light:`/`warm:` variants are needed only for the few rules
that differ structurally (for example the light-mode data-URI glyphs already
inside `tokens.css`).

Naming rule: no literal colors in components. ESLint's
`no-restricted-syntax` rule flags `#hex`/`rgb(` inside `className` strings
and `style` props; the two documented exceptions (image scrims,
`::highlight()` pseudos) live in `prose.css` with the `appearance-invariant`
/ `highlight-pseudo-literal` comment markers.

## 3. Scoped CSS that stays CSS

- `prose.css`: `.research-prose` (from `transcript.css` `.turn-markdown` and
  `research-surface.css`), headings, lists, code blocks, tables, blockquotes,
  math containers, wikilink states, `--transcript-font-delta` /
  `--transcript-line-height-delta`, `.research-summary-text`. Markdown output
  cannot carry utilities.
- `tweet.css`: `.journal-tweet` recipe (`research-surface.css`), 540 px
  `--research-feed-max-width`, media grid, quote, card, stats.
- `::highlight(session-search)` and `::highlight(session-search-active)` for
  the CSS Custom Highlight API used by DOM search.
- Keyframes for spinners and the thinking dot.

Everything else in the 12 feature files (`shell.css` 2,794 lines,
`research.css` 2,371, `journal.css` 746, …) is re-expressed as utilities on
components and deleted. `terminal.css`, `turn-pane.css`, `composer.css`
(queue chrome), `browser.css`, `history.css` are not ported.

## 4. Primitive wrappers (`src/ui/`)

Built on Base UI (ADR-9), each a thin styled wrapper with the app's tokens:

| Wrapper | Base UI | Replaces |
| --- | --- | --- |
| `Dialog`, `ConfirmDialog` | `Dialog` | `.confirm-dialog*`, native `<dialog>` uses, `ConfirmDialogActionButton` (stays-mounted busy state kept) |
| `Menu`, `MenuItem`, `MenuSeparator` | `Menu` | `.menu-item`, `.menu-divider`, `ResearchTreeMenuItems`, settings menu, journal card menus |
| `ContextMenu` | `ContextMenu` | `LinkContextMenu`, sidebar row menus, `clampContextMenuToViewport` |
| `Popover` | `Popover` | selection action popover, folder switcher, `placePanePopover` |
| `Select`, `LauncherSelect` | `Select` with `render` for the separated submenu row | `LauncherSelect.tsx` |
| `Tooltip` | `Tooltip` | title attributes |
| `Toast` region | own (ported `UserNotificationStack`) | |
| `Tabs` | `Tabs` | settings tabs |
| `Switch`, `Checkbox` | `Switch`, `Checkbox` | settings rows |

Own components (ported): `IconButton`, `ControlButton`, `LinkButton`,
`Field`/`Input`/`Textarea`, `ShortcutHint`, `CommandPalette` (Base UI
`Dialog` + own list), `DomSearchBar`, `PaneSearchBar` (renamed `FindBar`),
`ImageLightbox`, `DiagramLightbox`, `NotificationStack`, `ActivityMetadataLine`,
`ComposerSubmitShortcutGlyph`, `HistoryNav`, `SidebarRestoreButton`.

Each wrapper has a Storybook-less "kitchen sink" route in development
(`/dev/ui`, excluded from production) for visual checks across theme ×
appearance.

## 5. Markdown rendering (`features/markdown`)

Port of `TranscriptMarkdown.tsx`, `DiagramBlock.tsx`, `TranscriptActivity.tsx`:

- Base plugins `[remarkGfm, remarkBreaks, remarkWikilinks]` and
  `[rehypeTranscriptArtifacts]`; math plugins `[remarkMath,
  remarkTranscriptMathTweaks]` + `[rehypeMathjax]` lazy-loaded and swapped in
  via `useSyncExternalStore` as today (`TranscriptMarkdown.tsx:207`, `:871`).
  The two plugin lists are unified into one module in `shared/markdown`
  (the desktop kept two, `06` pain point 6).
- `normalizeLatexMathDelimiters`, `escapeWikilinkTablePipes` on source.
- `MarkdownLink` reads `WikilinkActionsContext` for resolve/activate.
- Code blocks → `DiagramBlock` for mermaid/dot/graphviz, lazy, DOMPurify SVG
  profile, `MutationObserver` on `data-appearance` for theme.
- `BlockedMarkdownImage`; image markers via `shared/imageMarkers` render
  thumbnails only for `session-file:` paths resolvable to artifacts (Phase 7).
- `rehypeTranscriptArtifacts` keeps inline-code file links producing
  artifact buttons; the Codex inline-visualization directives and content
  references are dropped with their native backend.
- `OversizedMarkdownPolicy`.
- Typography set on the renderer (`ResearchMessage.tsx`), never on layout
  roots.

## 6. Style contract tests (re-expressed)

The desktop's `tests/appearanceStyleContracts.test.ts` and
`tests/researchStyleContracts.test.ts` assert textual CSS. The web keeps the
intents:

1. Every dark token in `tokens.css` has a light override (same parser, same
   exclusions) — unchanged.
2. Light blocks follow dark theme blocks and flip `color-scheme` — unchanged.
3. No color literals outside `tokens.css`: run over the compiled CSS bundle
   (`vite build` output) instead of source files, with the two marker
   exceptions, plus the ESLint rule for `className`/`style`.
4. Typography ownership: `.research-prose` declares `--transcript-font-delta`
   and font metrics; placements (`.recent-query-recap`, `.research-recap`)
   declare none; `.research-summary-text` takes size from
   `--research-summary-*`. Asserted over `prose.css` source and, for
   placements, via a jsdom render that checks computed `font-size` equals the
   renderer's in Home and in a thread.
5. DM Sans half-pixel: `--fs-*` are `calc(… var(--font-ui-size-offset))`;
   code does not reference the offset — unchanged over `tokens.css` and
   `prose.css`.
6. Tweet recipe independence: `.journal-tweet` defined in `tweet.css` only;
   Home components do not redefine it (grep over `features/home`).

## 7. Accessibility and responsive behavior

- Visible `:focus-visible` rings from `--focus-ring` on every interactive
  element (`focus-visible:ring-2 ring-focus-ring`).
- `aria-current="page"` on sidebar rows, `role="listbox"` semantics from Base
  UI, labelled icon buttons.
- Page scrolling vertical only; tables and code own horizontal scroll.
- Narrow layout (< 900 px): sidebar becomes a drawer (Base UI `Dialog` with
  a side transition); the research document's rail cards stack below the
  answer (the desktop's breakpoint behavior in `research.css`).
- `prefers-reduced-motion` and the explicit setting both zero transitions
  except progress indicators.
