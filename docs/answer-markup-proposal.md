# Answer markup proposal

Status: proposal. Written against `main` at `6dd75ad1` (2026-10-18).

Interactive mock: [Answer Markup Mock](https://claude.ai/artifact/LUWM9bjpiWciwx4j98WH6u)
(private; a copy is in `docs/mockups/answer-markup.html`).

## Problem

A research answer that walks through Sketch's Stacks feature showed the
limits of answer rendering:

- Keyboard shortcuts (`⌘L`, `⇧S`) render as inline code, not as keys.
- An aside the reader should not miss ("Nice detail: …") is an ordinary
  paragraph.
- Menu paths ("Arrange > Stack > Add Stack Layout") are plain text.
- The sizing modes (Fixed, Fit, Fill) are hard to follow in prose; they
  describe how settings combine, which is easier to see by changing them.

This proposal covers what Session can render and what it asks agents to
write. The priority agents are Claude, GPT and Gemini.

## What is on main

### Widgets (shipped)

`session-html` fenced blocks render as sandboxed widgets on both apps:

- Parser and fence contract: `web/packages/shared/src/markdown/sessionWidgets.ts`.
- Desktop: `src/components/SessionWidget.tsx`, `src-tauri/src/research_widgets.rs`,
  revisions in `src-tauri/src/research_artifacts.rs`.
- Web: `web/packages/client/src/features/widgets/SessionWidget.tsx`, served
  from the artifact origin (`web/docs/11-artifacts-and-browser.md`).
- The static page (HTML and CSS only) shows first. Scripts run after the reader
  selects **Run scripts**.
- The "Widgets in answers" setting (`researchInlineWidgets`, default on)
  controls both rendering and whether agents receive the widget guidance.

The widget guidance (`AGENT_GUIDANCE`, `research_widgets.rs:52`) already names
"how settings combine (layout rules, configuration options)" as a case for a
widget, so the Sketch sizing section is the kind of answer that should get one.

### Where scripts run

| App | Widget scripts |
| --- | --- |
| Desktop, macOS | Run after **Run scripts**; the web view has WebRTC turned off first (`research_widgets::set_scripts_allowed`). |
| Desktop, other platforms | Static page only. |
| Web, production | Static page only ("Scripts off"). `https://artifacts.session.dev` is the same site as `https://session.dev`, so the server refuses run pages (§2.1 of doc 11). |
| Web, development and e2e | Run. |

### Agents and how guidance reaches them

| Agent | App | Runtime | Guidance channel |
| --- | --- | --- | --- |
| Claude | Desktop | Claude Code CLI, stream-json mode, read-only tools (`claude_sdk.rs:32`) | `--append-system-prompt`, every launch |
| Claude | Web | Claude Fable 5.1, Anthropic API, admin accounts only | `system` string passed to `streamText` |
| GPT | Desktop | Codex CLI `exec`, read-only sandbox | `-c developer_instructions=…`; Codex reads it only when a thread starts, and follow-ups inherit it (`research_runtime.rs:488`) |
| GPT | Web | GPT-5.6 Luna through OpenRouter | `system` string |
| Gemini | Web | Gemini 3.8 Flash through Vertex AI; the web app's default model | `system` string |
| Gemini | Desktop | No adapter | None |
| Grok | Desktop | Grok CLI, read-only tool list | `--rules` |
| DeepSeek | Web | DeepSeek V4.1 Flash through OpenRouter | `system` string |

No agent can write files during research, on either app. Anything richer than
Markdown therefore has to be in the answer text.

The web app also sends a fixed research system prompt
(`RESEARCH_SYSTEM_PROMPT`, `web/packages/shared/src/research/prompts.ts:60`)
before the widget guidance. The desktop sends no equivalent; each CLI keeps
its own system prompt.

The per-provider mapping of the web's `system` string (for example to Gemini's
`systemInstruction`) is done by the AI SDK packages and was not checked here.

### What the Markdown renderer does

Both apps render answers with react-markdown 10 and the same plugins: GFM,
breaks, wikilinks, `session-html` fences, and math loaded on demand.
`mermaid` and `dot` fences render as diagrams.

- Raw HTML is shown as literal text. `<kbd>⌘</kbd>` displays as
  `<kbd>⌘</kbd>`. There is no `rehype-raw` or `rehype-sanitize`.
- GitHub alerts (`> [!TIP]`) render as a plain block quote with `[!TIP]`
  visible.
- Inline code has no special case for key chords.

## Options

Each option is independent unless noted. A1, A2 and A3 change only the
renderer. B changes what agents are asked to write.

### A1. Key chords as keycaps

Render inline code as keys when its whole text is a key chord:

- Symbol form: one or more of `⌘ ⇧ ⌥ ⌃`, then one key (`⌘L`, `⇧⌘P`).
- Word form: modifier names joined by `+`, then one key (`Ctrl+Shift+P`,
  `Cmd+Return`, `Shift+Tab`). Modifier names: Cmd, Command, Ctrl, Control,
  Shift, Alt, Option, Opt, Win, Super, Fn.
- A key is one letter, digit or punctuation mark, or a named key (Return,
  Enter, Esc, Tab, Space, Delete, arrows, F1–F12).
- A modifier alone, a key alone, or text with spaces stays inline code.

Implementation:

- A pure `keyChordParts(text)` in `web/packages/shared/src/markdown/` (no DOM),
  used by the inline `code` component on both apps (`TranscriptMarkdown.tsx`,
  `web/packages/client/src/features/markdown/ResearchMarkdown.tsx`).
- Render `<kbd>` per part with no added text, so the rendered text stays
  `⌘L`. Find, copy and highlight anchors see the same characters as before.
- Reuse the desktop's keycap style (`.context-menu-shortcut.is-keycap`,
  `src/styles/features/shell.css:393`) as a basis for a prose-sized `kbd`.
- Inline mode (titles, compact previews) keeps rendering code as plain text.

Effect: works for every agent and for saved answers, with no prompt change.
The Sketch answer already writes `⌘L` and `⇧S` this way.

Cost: small. Risk: a code span meant as a literal string that matches the
rule, such as `Ctrl+C` quoted from a log, renders as keys. It still shows the
same characters, so this is acceptable.

### A2. Callouts from GitHub alert syntax

Render a block quote whose first line is exactly `[!NOTE]`, `[!TIP]`,
`[!IMPORTANT]`, `[!WARNING]` or `[!CAUTION]` as a callout with a label.

Implementation:

- A remark plugin in `web/packages/shared/src/markdown/` that sets
  `hProperties` (`data-callout="tip"`) on the block quote and removes the
  marker text. Add it to the base and math plugin lists on both apps.
- The label ("Tip") is interface text, not answer text. Mark it
  `data-widget-chrome` (or rename that attribute to something general) so
  find skips it (`src/lib/transcriptSearch.ts:113`).
- Inline mode drops block quotes already; the plugin must also drop the
  marker there, or compact previews show `[!TIP]`.
- Removing the marker shifts rendered-text offsets by its length. Highlight
  anchors store rendered-text offsets plus a quote with prefix and suffix
  (`src-tauri/src/research_anchors.rs`). Add a case to
  `tests/researchHighlights.test.ts`: a highlight saved after a `[!TIP]`
  line before the change still resolves after it.

Effect: none on answers that do not use the syntax. The Sketch answer does
not, so A2 depends on B or on agents that write alerts unprompted.

Cost: small.

### A3. Inline HTML allowlist

Render `<kbd>`, `<mark>`, `<sub>` and `<sup>` when an agent writes them;
leave all other HTML as literal text.

Implementation:

- A remark plugin that pairs inline `html` nodes for those four tags only and
  replaces each pair with an element. No `rehype-raw`, so there is no second
  HTML parse and no sanitizer to maintain.
- Block HTML such as `<details>` stays literal. It would need `rehype-raw`
  and `rehype-sanitize`, an HTML parse of every answer on every streamed
  update, and a sanitizer configuration that must not let anything through
  to the app origin.

Effect: only on answers that contain these tags. With B telling agents to
write keys as inline code, A3 mainly cleans up answers where an agent writes
`<kbd>` anyway.

Before building it, count how often saved answers contain these tags:

```sh
grep -rhoE '<(kbd|mark|sub|sup)>' <workspace>/.session | sort | uniq -c
```

Cost: small to medium. Lowest value of the A options.

### B. Formatting guidance

Send a short formatting block to every agent, independent of the widget
setting. Draft text:

> Formatting in Session answers:
> - Write keyboard shortcuts as inline code that contains only the keys: `⌘L`, `⇧⌘P` on Apple platforms, `Ctrl+Shift+P` elsewhere. Give each alternative its own code span: `⌘L` or `⇧S`.
> - Write menu paths in bold with › between items: **File › Export › PNG**.
> - For a warning the reader must not miss, or a tip that is easy to overlook, use a block quote whose first line is [!NOTE], [!TIP], [!IMPORTANT], [!WARNING] or [!CAUTION]. Use at most two per answer; keep everything else in the prose.
> - Outside session-html blocks, do not write HTML tags.

Implementation:

- Keep the text in one file both apps read, so the copies cannot drift:
  for example `web/packages/shared/src/research/answerFormatGuidance.md`,
  loaded with `include_str!` in `src-tauri` and imported as text on the web
  server. The widget guidance is duplicated today
  (`research_widgets.rs:52` and `web/packages/server/src/runs/prompts.ts:31`)
  with no test comparing the two; this would be a reason to move it to the
  same mechanism.
- Desktop: change `research_widgets::agent_guidance(enabled)` (or its caller
  at `main.rs:914`) to always return the format block, followed by the
  widget block when widgets are on. The three channels already exist.
- Web: add the block to `researchSystemPrompt`
  (`web/packages/server/src/runs/prompts.ts:65`) after
  `RESEARCH_SYSTEM_PROMPT`.
- Codex reads developer instructions only when a thread starts. A change to
  the text reaches new threads only; existing threads keep what they started
  with. The same is already true for the widget guidance.

Before shipping, run a fixed set of prompts (a software walkthrough with
shortcuts, a configuration comparison, a factual question, a sourced
summary) through Claude Code, Codex and Gemini 3.8 Flash with and without
the block, and check:

- shortcuts come out as code spans the A1 rule matches;
- callouts appear at most twice and not in answers that do not need them;
- answers are not longer;
- no HTML tags outside `session-html`.

Cost: small in code; the evaluation is most of the work. About 150 tokens
per launch.

### W. Widget follow-ups (already shipped; changes only)

- **Web scripts in production.** Move `SESSION_ARTIFACT_ORIGIN` to a host on
  another registrable domain (`web/SETUP.md` §2). Until then, every web
  answer, including those from Gemini (the default web model) and GPT, shows
  widgets as static pages,
  so a widget like the Sketch sizing demo cannot be used there.
- **Static pages that teach on their own.** The guidance already requires a
  meaningful initial state. On web production that state is all the reader
  gets, so the evaluation for B should also check widgets with scripts off.

### E. Gemini on the desktop

Gemini runs only on the web app. A desktop adapter would follow the Codex
and Grok pattern in `research_runtime.rs` (`launch_jsonl`), using the Gemini
CLI in headless mode with JSON streaming, a read-only tool list, and a
system-level channel for the guidance. This is separate work; none of the
options above depend on it.

## Recommendation

1. A1 and A2 together, in `web/packages/shared/src/markdown/`, with both apps
   wired in one change.
2. B, with the shared guidance file and the evaluation above. Ship it after
   A1 and A2 so the syntax it asks for already renders.
3. The web artifact origin move (W), since it decides whether widget scripts
   can run in any web answer, Gemini's included.
4. A3 only if the count of saved answers with these tags justifies it.
5. E when desktop Gemini is wanted for other reasons.

## Self-review

Checked after writing the first version of this document:

- The earlier version of this proposal (written against `5d88827`)
  recommended building inline HTML widgets. They have since shipped as
  `session-html`; this version treats them as existing and lists only
  follow-ups.
- The earlier version proposed rendering `<details>` through an allowlist.
  Raw block HTML would need a full HTML parse and a sanitizer on every
  answer render; A3 is now limited to four inline tags handled by a remark
  plugin.
- The earlier version proposed asking agents to write `<kbd>`. Inline code
  keeps working in every other Markdown viewer and in copied text, and A1
  renders it as keys, so B asks for inline code and A3 dropped in priority.
- The earlier version suggested adding the guidance to the user prompt as a
  fallback. The widget guidance now reaches every agent through a
  system-level channel, so B uses those channels instead.
- A2 changes rendered text and so can affect highlight anchors; the
  required test is listed under A2.
- The web per-provider handling of the `system` string was not verified in
  code, and the mock's B output is an illustration, not recorded model
  output.
