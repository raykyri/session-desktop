# Canvas variant B: stacks

Mock: `docs/mockups/canvas-stacks.html`. Its seed is converted from `docs/mockups/session-handoff.html`.

A thread is a column of parts. You write into the gaps between parts, and a part's context is what sits above it.
There are two primitives, Part and Stack, and they live on a canvas.

faketalk could not be read from here (no such repository on GitHub; antimatter15.com is blocked), so the design
follows the principles in the brief: each part carries a small rule, binds its context when it runs, and can be
inspected.

## Primitives

**Part**: a block of text with an author.

- `id`, `stack`, `key`. The key is a fractional index: an insert takes a key between its neighbours, so nothing is
  renumbered.
- `author`: `{ person }` or `{ model }`.
- `text`, `at`.
- `run`, on model parts only: `{ by, model, see, ctx, status, src }`. `by` is the person who asked, `see` is
  the context rule, and `ctx` lists the parts the rule resolved to when the run started. That context is frozen.

An ask is a person part with a model part directly under it whose `run.by` is that person. A post is a person part
with nothing produced under it. The editor has two buttons, Post and Ask; nothing else distinguishes them.

By default a stack is one person's multi-turn exchange with the model: question, answer, follow-up, answer. Other
people appear as replies on a post, as an insert, or in a fork of their own.

The model is a workspace setting, shown once next to "+ Add ask", and every model part uses it. `run.model` records
what produced the part; it is not a choice made per ask. There is no effort setting. A model part carries a short
"Answer" mark, and names the asker only when that person is not the stack's author.

**Stack**: a vertical column of parts.

- `id`, `canvas`.
- `fork?`: `{ part, block?, quote? }`, the part, block or quoted passage the stack starts from.
- `x?`, `y?`: set only on stacks placed by themselves (roots, and forks opened as their own thread).
- `inline?`: draw this fork inside its parent, at its anchor.

A **canvas** is a channel's namespace with no behaviour, so it is not a primitive. Collapse, zoom, saves and read
state are per-viewer, not content. Parts are never split or merged: they are inserted between parts, or a stack forks
from a part or one of its blocks.

## Context rule (the attached code)

A model part reads what its `see` rule resolves to. The terms are small:

- `above`: the parts above it in its own stack.
- `trunk`: for a fork, the fork part and everything that part reads, recursively. A block anchor includes the whole
  part, with the block marked.
- `fork`: the fork part only.
- Terms are joined with `+`.

The rule is set by where the part is. Nobody edits it.
- A part at the bottom of a stack, or one added with "+ Add to this stack", always reads the whole thread above it:
  `above + trunk`. Inserts use the same rule.
- An answer in an inline fork ("Fork here") reads `above + fork`: its own question and the passage it starts from.
  Here reading less is the point. A Look up would use the same rule.

The rule selects positions: it doesn't compute values (C) or send messages (A). The "read N" chip opens a read-only
list of the parts the answer read, outlined on the canvas, with the rule and the part's relations. Re-run is a plain
action for the asker. An insert above an answer leaves that answer as it was; the "inserted" label tells readers.

**Compaction.** When the thread above exceeds the model's context budget, the earliest parts are replaced by a
compacted summary. The parts nearest the new part, and the fork point, stay verbatim. `run.ctx` records that a
compaction was used and which parts it covered. The mock doesn't implement this.

## Layout and interaction

- **Seams.** Every stack ends with "+ Add to this stack". On desktop, hovering a gap shows a "+" in the left gutter.
  On touch, tapping a stack selects it and its gaps show the "+". There is no seam between a question and the answer
  it prompted: the pair reads as one.
- **Inserting.** A draft opens in the gap: a text field and one row (a quiet "+ part"; Cancel, Post, Ask), with
  shortcuts in the button titles. An insert adds one faint line: "Answers below won't read this."
  Parts below and their forks slide down (FLIP, 300 ms). Stacks elsewhere stay where they are.
- **Inside an answer.** Hovering a passage (or tapping one in a selected stack) shows "Fork here". It creates an inline
  fork at that block, so the column grows there without splitting the answer. Inline forks fold to one line. "Move
  out" turns one into a lane fork.
- **Forks.** "Fork" on any part, or "Fork from selection" (which stores the block and quote), opens a stack in the
  next lane. It sees everything up to the fork.
- **Units.** A root and its lane forks form a unit, and only the root stores x and y. Forks start level with their
  anchor; siblings stack by subtree extent, so connectors don't cross. Overlaps between units are resolved downward,
  never stored, and the unit being edited stays put.
- **New stacks** go to the free spot nearest the centre of the view; double-clicking the canvas writes at the pointer.
- **Scale.** The seed has 22 units, 51 stacks and 158 parts. Units are packed in columns by last activity. Collapsed
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
| Continue | the asker's next turn in the same stack (append or insert) |
| Branch here, ask about a passage | fork with `block` and `quote` |
| Branch beside | fork at the parent's model part |
| Look up | fork whose model part has `see: fork` |
| comment on a node | person part after the answer; later asks below it read it |
| run record | `run` on the model part |
| save, counts | per-viewer state; counts as today |
| Open as its own thread | give the fork its own x, y; `fork` stays, so its context is unchanged |

## Open questions

1. An insert above someone else's answer is not part of what that answer read. Is the "inserted" label enough, or
   should channels be able to limit inserts?
2. Two inserts into one gap both survive (fractional keys). How does the second author see the first before sending?
3. Asks at the end of a stack can't skip a comment above them. Is that acceptable, or does compaction need to drop
   comments first?
4. `x`, `y` and `inline` are shared, so one person's drag rearranges everyone's canvas.

## Advisor log

The advisor was a separate subagent, run over three rounds. Steers from the parent session follow.

**Round 1.** Run was a hidden fourth primitive, and section parts would orphan forks. *Changed:* one run is one
part; fork anchors carry block and quote.

**Round 2.** Split-on-demand (`cont`) still orphaned forks; depth lanes would cross. *Changed:* inline block forks,
subtree-extent lanes. *Rejected:* horizontal displacement, which would break the columns people read down.

**Round 3, mock walkthrough. This was the most useful round.** The demo put an ask between a question and its own
answer, and part seams and block seams looked alike. *Changed:* no seam inside a question and answer pair, a hover
"Fork here", folded inline forks, one overview headline per stack, a stable sweep, viewer-independent seed
positions. *Rejected:* dropping the popover's relations line, because the brief asks for relations to be visible.

**Steer 1 (overlap with C).** *Changed:* removed staleness, `rev`/`revs` and the "changed" mark; context is frozen
at run time. Fork hover highlights the anchor.

**Steer 2 (for the user).** *Changed:* a stack is one asker's multi-turn exchange, and the seed follows that. One
workspace model is shown once beside "+ Add ask", with no per-run model or effort.

**Steer 3 (for the user).** *Changed:* answers carry no timestamp; the composer is a field and one row. A part at the
end of a stack always reads the whole thread, so the rule follows position and the popover is read-only. Compaction
is described above.
