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
- `text`, `at`.
- `run`, on model parts only: `{ by, model, effort, see, ctx, status, src }`. `by` is the person who asked, `see` is
  the context rule, and `ctx` lists the parts the rule resolved to when the run started. That context is frozen.

An ask is a person part with a model part directly under it whose `run.by` is that person. A post is a person part
with nothing produced under it. The editor has two buttons, Post and Ask; nothing else distinguishes them.

**Stack**: a vertical column of parts.

- `id`, `canvas`.
- `fork?`: `{ part, block?, quote? }`, the part, block or quoted passage the stack starts from.
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
- `none`; terms join with `+`.

```
see: fork             a Look up: only the phrase's part
see: above 1          only the question directly above
see: above 2 + fork   the two parts above, plus the fork point
```

The rule selects positions: it neither computes values (C) nor sends messages (A). The "read N" chip opens it. It
outlines the parts the answer read when it ran, or, while you edit the rule, the parts it would read. It also lists
relations. Only the asker edits the rule; Re-run is a plain action that replaces the answer. There is no staleness
tracking: an insert above an answer does not mark it, and the "inserted" label on the new part tells readers that
the answers below were written without it.

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
| comment on a node | person part after the answer; context for later asks below it unless their rule is `above N` |
| run record | `run` on the model part |
| save, counts | per-viewer state; counts as today |
| Open as its own thread | give the fork its own x, y; `fork` stays, so its context is unchanged |

## Open questions

1. An insert above someone else's answer is not part of what that answer read. Is the "inserted" label enough for
   readers, or should channels be able to limit inserts?
2. Two inserts into one gap both survive (fractional keys), but how the second author sees the first before sending
   is open.
3. With no `-` or `#id`, a rule cannot skip one comment in the middle. If that matters, an "exclude" action on a part
   is a better answer than a larger grammar.
4. `x`, `y` and `inline` are shared, so one person's drag rearranges everyone's canvas.

## Advisor log

The advisor was a separate subagent, run over three rounds.

**Round 1, concept.**
- *Criticism:* Run was a hidden fourth primitive, and splitting answers into sections would orphan forks on a re-run.
- *Changed:* one run is one part, and fork anchors carry the block and quote. Canvas and collapse are not content.

**Round 2.**
- *Criticism:* splitting answers on demand (`cont`) still orphaned forks, depth-indexed lanes would cross, and
  semantic zoom would relayout.
- *Changed:* inline block forks replace `cont`, lanes use subtree extents, and the overview keeps the geometry.
- *Rejected:* horizontal displacement, because it would break the columns people read down.

**Round 3, mock walkthrough.** This was the most useful round.
- *Criticism:* the demo put an ask between a question and its own answer, part seams and block seams looked alike,
  and the overlap sweep was unstable.
- *Changed:* no seam inside a question and answer pair, "Fork here" appears on hover, and inline forks fold. Overview
  shows one headline per stack, the sweep repeats until stable, and seed positions no longer depend on the viewer.
- *Rejected:* removing the relations line from the popover, because the brief asks for relations to be visible.

**Steer from the parent session.** Staleness marks, re-run versions (`revs`) and answer history overlap with
direction C. The steer was to cut them, keep the rule language small, and put the effort into interjection, forks and
scale.
- *Changed:* context is frozen when a part runs, and Re-run is a plain action. `rev`, `revs` and the "changed" mark
  are removed. The grammar is now `above`, `above N`, `trunk`, `fork`, `none` and `+`. Hovering a fork highlights its
  anchor in the parent.
