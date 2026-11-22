# Canvas variant B: stacks

Mock: `docs/mockups/canvas-stacks.html`. Its seed is converted from `docs/mockups/session-handoff.html`.

A thread is a column of parts. You write into the gaps between parts, and a part's context is what sits above it.
There are two primitives, Part and Stack, and they live on a canvas.

I couldn't read faketalk from here (GitHub has no such repository, and antimatter15.com is blocked). The design
follows the principles in the brief instead.

## Primitives

**Part**: a block of text with an author.

- `id`, `stack`, `key`. The key is a fractional index: an insert takes a key between its neighbours, so nothing is
  renumbered.
- `author`: `{ person }` or `{ model }`.
- `text`, `at`.
- `run`, on model parts only: `{ by, model, ctx, status, src }`.
  - `by` is the person who asked.
  - `ctx` lists the parts it read, frozen when the run started.
  - `model` only records what produced the part. The model is a workspace setting, not chosen per ask, and is shown
    once beside "+ Add ask". There is no effort setting.

An ask is a person part with a model part directly under it. A post is a person part with nothing produced under it.
The editor has two buttons, Post and Ask; nothing else distinguishes them.

**Stack**: a vertical column of parts.

- `id`, `canvas`.
- `fork?`: `{ part, block?, quote? }`, the part the stack starts from. A block or quote marks a passage as the focus.
- `x?`, `y?`: set only on stacks placed by themselves (roots, and forks opened as their own thread).
- `inline?`: draw this fork inside its parent, at its anchor.

A stack's **author** is the person who wrote its first part. Only the author continues a stack, by adding to its end
or inserting between its parts; everyone else forks. By default a stack is one person's multi-turn exchange with the
model: question, answer, follow-up, answer.

A **canvas** is a channel's namespace with no behaviour, so it is not a primitive. Collapse, zoom, saves and read
state are per-viewer, not content. Parts are never split or merged.

## Context

Context is fixed by position, everywhere. A model part reads:
- every part above it in its stack;
- if the stack is a fork, the part the fork starts from and everything that part read, recursively.

A fork from a passage ("Fork here", "Fork from selection", Look up) reads the same full context. The passage only marks
the focus. An insert reads what is above it; the answers below it keep what they read when they ran.

**No attached code.** Variant B ends up without any. Every candidate rule turned out to be a choice the person shouldn't
have to make, because position already says what a part is about. Each part stays inspectable without code:
- The "read N" chip on an answer opens a read-only list of the parts it read, outlined on the canvas.
- The same list shows the part's relations: its position in the stack, what it forks from, and the forks that start
  at it.
- `run.ctx` is the computed value, stored on the part.

Re-run is a plain action for the asker. There are no staleness marks; an insert is labelled "inserted".

**Compaction.** When the thread above is longer than the model's context budget, the earliest parts are replaced by a
compacted summary. The parts nearest the new part, and the fork point, stay verbatim. `run.ctx` records that a
compaction was used and which parts it covered. The mock doesn't implement this.

## Layout and interaction

- **Seams (author only).** Your own stacks end with "+ Add to this stack". On desktop, hovering a gap shows a "+" in
  the left gutter; on touch, tapping a stack shows its gaps. There is no seam between a question and its answer.
  Other people's stacks show no seams; you fork them instead.
- **Inserting.** A draft opens in the gap and the parts below slide down (FLIP, 300 ms). The draft is a text field
  and one row: [⊕ add a part] [Post] [Ask]. An X at the top right discards it, and the Ask shortcut is in the button's
  title. An insert adds one faint line: "Answers below won't read this."
- **Inside an answer.** Hovering a passage (or tapping it on touch) shows "Fork here". It opens an inline fork at that
  block, folded to one line when idle; "Move out" turns it into a lane fork.
- **Forks.** "Fork" on any part, or "Fork from selection", opens a stack in the next lane. Hovering a fork highlights
  its anchor.
- **Units.** A root and its lane forks form a unit, and only the root stores x and y.
  - Forks start level with their anchor, and siblings stack by subtree extent, so connectors don't cross.
  - Overlaps between units are resolved downward and never stored.
  - The unit being edited keeps its place.
- **Scale.** The seed has 22 units, 61 stacks and 158 parts.
  - Units are packed in columns by last activity.
  - A collapsed unit shows its first part and "n parts · m forks".
  - Below 50% zoom, each stack shows one headline at a constant screen size.
  - "Next new" jumps to the next unit with unread parts.

## Mapping from today's records

| today | stacks |
|---|---|
| channel | canvas |
| post thread | root stack; the author's own follow-ups are appended parts |
| reply, reply to a reply | inline fork by the replier, at the post or at the reply |
| ask thread | root stack: person part, then model part |
| node | person part plus the model part under it |
| Continue | the author's next turn in the same stack (append or insert) |
| Branch here, ask about a passage, Look up | fork with `block` or `quote` as focus; full context |
| Branch beside | fork at the parent's model part |
| comment on a node | the author's part after the answer, or anyone's inline fork |
| run record | `run` on the model part |
| save, counts | per-viewer state; counts as today |
| Open as its own thread | give the fork its own x, y; `fork` stays, so its context is unchanged |

## Open questions

1. Can a stack's author invite others to continue it, or is forking always enough?
2. Two inserts by the author on two devices into one gap both survive (fractional keys). Is that the right merge?
3. Asks at the end of a stack can't skip parts above them. Does compaction need to drop parts the author marks as
   asides first?
4. `x`, `y` and `inline` are shared, so one person's drag rearranges everyone's canvas.

## Advisor log

The advisor was a separate subagent, run over three rounds. Steers from the parent session, made for the user,
follow.

**Round 1.** Run was a hidden fourth primitive, and section parts would orphan forks. *Changed:* one run is one
part; fork anchors carry block and quote.

**Round 2.** Split-on-demand (`cont`) still orphaned forks, and depth lanes would cross. *Changed:* inline block
forks, subtree-extent lanes. *Rejected:* horizontal displacement, which would break the columns people read down.

**Round 3, mock walkthrough.** This was the most useful round.
- *Criticism:* the demo put an ask between a question and its own answer, and part seams and block seams looked
  alike.
- *Changed:* no seam inside a question and answer pair; a hover "Fork here"; folded inline forks; one overview
  headline per stack; a stable sweep.
- *Rejected:* dropping the relations line, which the brief asks for.

**Steer 1.** Remove staleness and versions (they overlap with direction C), and keep the rule language small.

**Steer 2.** A stack is one asker's exchange, and there is one workspace model.

**Steer 3.** No timestamps on answers. The composer is one row. The end of a stack reads the whole thread, and
compaction is described.

**Steer 4.** Forks read the full context too, so context is positional everywhere and the rule language is removed:
B has no attached code. Only a stack's author continues it, so replies by others became forks. The draft has ⊕ and X.
The title is "Session Canvas Stacks (B)".
