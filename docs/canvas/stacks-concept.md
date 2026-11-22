# Canvas variant B: stacks

Mock: `docs/mockups/canvas-stacks.html`. Its seed is converted from `docs/mockups/session-handoff.html`.

A thread is a column of parts. You write into the gaps between parts, and a part's context is what sits above it.
There are two primitives, Part and Stack, and they live on a canvas.

faketalk could not be read from here: GitHub lists no such repository for antimatter15, and antimatter15.com and
Hacker News are blocked. The design follows the principles in the brief instead. Each part is an object with a small
rule of its own. Context binds late, when a run starts, and the resolved context can be inspected and edited.

## Primitives

**Part**: a block of text with an author.

- `id`, `stack`, `key`. The key is a fractional index: an insert takes a key between its neighbours, so nothing is
  renumbered.
- `author`: `{ person }` or `{ model }`.
- `text`, `at`, `rev`, `revs`. A re-run bumps `rev`, and earlier texts stay readable in `revs`.
- `run`, on model parts only: `{ by, model, effort, see, ctx, status, src }`. `by` is the person who asked, `see` is
  the context rule, and `ctx` is the list of `[partId, rev]` pairs the rule resolved to when the run started.

An ask is a person part with a model part directly under it whose `run.by` is that person. A post is a person part
with nothing produced under it. The editor has two buttons, Post and Ask; nothing else distinguishes them.

**Stack**: a vertical column of parts.

- `id`, `canvas`.
- `fork?`: `{ part, rev, block?, quote? }`, the part, block or quoted passage the stack starts from.
- `x?`, `y?`: set only on stacks placed by themselves (roots, and forks opened as their own thread).
- `inline?`: draw this fork inside its parent, at its anchor.

A **canvas** is a channel's namespace with no behaviour, so it is not a primitive. Collapse, zoom, saves and read
state are per-viewer, not content. Parts are never split or merged: they are inserted between parts, or a stack forks
from a part or one of its blocks.

## Context rule (the attached code)

A model part sees what its `see` rule resolves to. The default is `above + trunk`.

- `above`, `above N`: the parts above it in its stack, or the N nearest.
- `trunk`: for a fork, the fork part and everything that part sees, recursively. A block anchor includes the whole
  part, with the block marked.
- `fork`: the fork part only.
- `#id`: one part. You enter it by clicking the part; it is shown as the part's first words.
- `none`; `+` and `-` add and remove.

```
see: fork                  a Look up: only the phrase's part
see: above 1               only the question directly above
see: above + trunk - #p41  everything positional except one comment
```

The rule selects positions: it neither computes values (C) nor sends messages (A). The "sees N" chip opens it, outlines
what it resolves to as you type, and lists relations. Only the asker edits it ("Save rule and re-run"). When the
resolution differs from `run.ctx`, the chip turns amber. A re-run writes a new rev and keeps the old one; nothing
re-runs automatically.

## Layout and interaction

- **Seams.** Every stack ends with "+ Add to this stack". On desktop, hovering a gap shows a "+" in the left gutter.
  On touch, tapping a stack selects it and its gaps show the "+". There is no seam between a question and the answer
  it prompted: the pair reads as one.
- **Inserting.** A draft opens in the gap, with "+ part", Post, Ask and a line saying what an ask there would see.
  Parts below and their forks slide down (FLIP, 300 ms). Stacks elsewhere stay where they are.
- **Inside an answer.** Hovering a passage (or tapping one in a selected stack) shows "Fork here". It creates an inline
  fork at that block, so the column grows there without splitting the answer. Inline forks fold to one line. "Move
  out" turns one into a lane fork.
- **Forks.** "Fork" on any part, or "Fork from selection" (which stores the block and quote), opens a stack in the
  next lane. It sees everything up to the fork.
- **Units.** A root and its lane forks form a unit, and only the root stores x and y. Forks start level with their
  anchor; siblings stack by subtree extent, so connectors don't cross. Overlaps between units are resolved downward,
  never stored, and the unit being edited stays put.
- **New stacks.** "+ Add post" and "+ Add ask" place a root at the free spot nearest the centre of the view.
  Double-clicking the canvas writes at the pointer.
- **Scale.** The seed has 22 units, 65 stacks and 156 parts. Units are packed in columns by last activity. Collapsed
  units show their first part and "n parts · m forks". Below 50% zoom each stack shows one headline at a constant
  screen size. Connectors are faint except in the active unit. "Next new" jumps to the next unit with unread parts.

## Mapping from today's records

| today | stacks |
|---|---|
| channel | canvas |
| post thread | root stack with one person part; replies are appended parts |
| reply to a reply | inline fork at the reply |
| ask thread | root stack: person part, then model part |
| node | person part plus the model part under it |
| Continue | append, or insert, in the same stack |
| Branch here, ask about a passage | fork with `block` and `quote` |
| Branch beside | fork at the parent's model part |
| Look up | fork whose model part has `see: fork` |
| comment on a node | person part after the answer. It is context for later asks below it; `- #id` excludes it |
| run record | `run` on the model part |
| save, counts | per-viewer state; counts as today |
| Open as its own thread | give the fork its own x, y; `fork` stays, so its context is unchanged |

## Open questions

1. An insert above someone else's answer changes that answer's context. Should channels be able to limit this, or is
   the amber mark enough?
2. Two inserts into one gap both survive (fractional keys), but how the second author sees the first before sending
   is open.
3. Excluding comments takes one `#id` each. If that is common, add an "exclude" action that writes the refs, rather
   than more grammar.
4. `x`, `y` and `inline` are shared, so one person's drag rearranges everyone's canvas.

## Advisor log

The advisor was a separate subagent, run over three rounds.

**Round 1, concept.**
- *Criticism:* Run was a hidden fourth primitive. Section parts would orphan forks on a re-run and lose the quoted
  passage. Stale marks would cascade. Pushing stacks aside would overwrite people's arrangement.
- *Changed:* one run is one part, and fork anchors carry `rev`, `block` and `quote`. Stale marks are quiet and only the
  asker re-runs. Displacement is derived. Canvas and collapse are not content, and the grammar is cut to seven terms.

**Round 2, v2.**
- *Criticism:* splitting answers on demand (`cont`) brought orphaning back. Depth-indexed lanes would cross. Semantic
  zoom would relayout. Appending needed a selection first.
- *Changed:* inline block forks replace `cont`. Lanes use subtree extents. Overview keeps the geometry. The end seam and
  gutter "+" no longer need a selection.
- *Rejected:* horizontal displacement. The downward sweep already resolves an overlap, and moving units sideways would
  break the columns people read down.

**Round 3, mock walkthrough.** This was the most useful round.
- *Criticism:* the demo put an ask between a question and its own answer. Part seams and block seams looked alike. The
  sweep was unstable. Seed positions depended on the viewer.
- *Changed:* no seam inside a question and answer pair, and "Fork here" appears on hover. Inline forks fold. The stale
  mark is a chip, with details in the popover. Connectors are faint unless their unit is active. Overview shows one
  headline per stack. The sweep repeats until stable, with the edited unit fixed. Seed positions no longer depend on
  the viewer.
- *Rejected:* showing the stale chip only to the asker, because readers need to know that an answer did not read a
  part inserted above it. Also rejected: removing the relations line, because the brief asks for relations to be
  visible.
