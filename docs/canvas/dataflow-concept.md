# Canvas variant C: dataflow

Mock: `docs/mockups/canvas-dataflow.html` (seed content from `session-handoff.html`).

A channel's canvas is a reactive document, like a spreadsheet. Every object is a cell holding either text a person
wrote or an expression computing text from other cells. A post is a series of text cells. An ask is a text cell
followed by a cell whose expression is `answer(above)`. Nothing re-runs without a click.

A column is one person's multi-turn exchange with the model. Only the column's author continues it or inserts into
it; everyone else branches (Branch, or "Ask about this" on a passage). The model is a workspace setting (Gemini 3.8 Flash in the mock), named once at the top left; every model cell
uses it. On cards, a person's part shows only their avatar to its left (no name or time), and model output shows
the circle-dot mark to its left.

faketalk was unreachable (GitHub 404; site blocked by the network policy), so the design follows the stated
principles: everything is a cell, cells relate only by reference, references bind at run time, everything is
inspectable.

## Primitives (two, plus reference syntax)

**Cell** `{ id, author, at, prev?, body, out?, prevOut? }`
- `body.text`: written by a person; `@id` (or `@id#n`, passage n) is a reference, drawn as a chip.
- `body.expr`: computed (grammar below).
- `out = { html, read: [{id, hash}], expr, by, model, at }`: the last result, what it read and which workspace model
  produced it; `prevOut` is the one before.
- `prev`: the cell this one follows. A series is a `prev` chain.

**Placement** `{ head, x, y | dx, dy }` positions a column head.
A root's Placement is absolute; a branch (a second child of some cell) is placed relative to that cell until dragged.
The child without a Placement continues the column, so an insert cannot change which child continues.

**Reference** is syntax, not a stored record. Edges come from `prev` (branches) and references (drawn on selection).

## Expressions

```
answer(above)                     the default ask; never shown unless inspected
summarize(@a, @b, …)              model
compare(@a, @b, "on what")        model
filter(@a, "criterion")           model
quote(@a#n)                       free: passage n of @a, recomputed whenever @a changes
```

`above` is the `prev` chain to the root, through any branch, plus the cells those parts mention (one hop). An ask
always reads the whole thread above it: `answer` must include `above`, and `@id` can add cards but nothing can leave
a part out. A branch reads the cell it branches from and everything above it, through earlier forks; with "Ask about
this", `@id#n` marks the passage in focus but the context is the same. `summarize`, `compare`, `filter` and `quote`
read only what they name.

**Compaction.** When the thread above exceeds the model's budget, the earliest parts are replaced by a compacted
summary and the rest are sent in full. `out.read` records which parts the summary covered, with their hashes, so an
edit to a compacted part still marks the answer stale. (Not in the mock.)

A part that starts with `=` in the composer is computed. In the seed:

```
r4  =filter(@ia, "published before 1980")                   reads ia
cc  =compare(@ia, @aa, "who the agent or network works for") reads ia, aa
r3  =quote(@ia#4)                                            no run; follows ia's latest answer
```

"Computable" means two kinds of cell: model cells cost money, run on request and record what they read; free cells
have no `out` and are derived on render. Naming the model functions puts the operation on the card ("= compare A with
B on …").

## Recomputation

A model cell is **stale** when a cell it read has a different hash (edited or re-run), when `above` resolves to a
different set (a part was inserted), or when its expression changed. That is one state: "Inputs changed since this
answer · Re-run". The inspector gives the reason per input. Re-run reads the current set.

The cause carries a summary: "Edited after 9 answers read it · Re-run 9", or "6 answers below have not read this yet
· Re-run 6". A current answer has no footer or timestamp; what it read is in the inspector and marked on the canvas
when it is selected. After a re-run, "Show previous" brings back the answer before it.

## Layout

- **Columns** are `prev` chains from placed heads, laid out depth by depth. A column that would overlap a placed one
  moves down; nothing moves sideways. Answers clamp to eight lines, and a running answer reserves that height.
- **Insert between two cards** ("+" in the gap, column author only): the new ask gets `prev` = the card above, and the card below is
  relinked to follow it. It reads only the parts above. The column grows. Later answers read `above`, so they depend
  on it and turn stale; text parts never do. The insert composer says so in one faint line.
- **Branch from mid-thread** (Branch on a card, or "Ask about this" on a selected passage) opens a column to the right
  at that card's height. It reads the thread up to the fork. Further branches nearby stack below.
- **Fold** shows a column as one line per card, keeping stale marks.
- **Connectors** (as in variant B): one curve from the parent column's right edge at the exact anchor (the card, or the
  passage for "Ask about this", clamped to the visible answer) to 16px down the branch's left edge, with a dot at the
  anchor. Neutral at .55 opacity; accent for the hovered or selected column's unit, whose anchor is also marked; dashed
  once dragged away. Reference edges appear only on selection, dotted and accent.

## Mapping from the handoff model

| Today | Dataflow |
|---|---|
| Thread (post) | root text cell; a multi-part post is a chain of text cells |
| Thread (ask) | root text cell + `answer(above)` |
| Node, Continue | question + answer appended at the tail, by the column's author only |
| Branch, Branch here, Branch (ask beside) | branch with a relative Placement |
| Passage branch, Look up | branch whose question carries `@id#n` |
| Reply on a post | text branch from the part it replies to (a column belongs to its author) |
| Comment on a node | text branch from the answer; no run |
| Open as its own thread | give the branch head an absolute Placement; nothing is copied |
| Save | a per-user set of ids, outside the model |
| Channel | the canvas; Placements are per canvas |
| Run record; model and effort pickers | `out` (with `out.model`), `prevOut`, the in-flight run; the model is a workspace setting |
| Follow-up counts | derived from `prev` and references |

## Open questions

- **Cost.** Who may re-run another person's answer, and who pays for "Re-run 9" on a shared thread.
- **Insert noise.** An insert near the top of a long thread stales every answer below. Whether later answers should
  read inserts at all needs testing.
- **Model changes.** When the workspace model changes, existing answers keep `out.model`. Whether that makes them
  stale is open; the mock does not.
- **Passage anchors.** `@ia#4` is an index, so after a re-run it points at the new passage 4. Matching the stored text
  is unsolved.
- **Scale.** Semantic zoom; shared layout under last-writer-wins; concurrent appends at the tail.

## Advisor log

**Round 1 (v1: Cell, Stack, Reference).** Said: overwriting answers breaks what people built on; Stack order,
`Stack.from` and references are three relations; the question was hidden in an expression; positional refs break on
insert. Changed: `prev` links replace Stack, the question is a text cell, read sets record hashes, ids shown as chips,
Save leaves the model. Rejected: a single model function.

**Round 2 (v2: Cell, Placement).** Said: "oldest child continues the column" breaks after an insert (I had hit the
same bug); show the read set before anything goes wrong. Changed: explicit column heads, a "Read …" footer (later removed),
relative branches. Rejected: author-only post chains (permission is social, not structural).

**Round 3 (mock walkthrough).** Most useful: no passage gesture; Enter did opposite things in two composer modes; one
edit badged twenty answers; seven run verbs. Changed: selection popover, one composer, outcome and preflight labels,
"Re-run n" on the cause, one verb, reference edges on selection, Fold.

**Parent-session steers.** (1) One stale state; inserts join the series (no asides or Merge); only the previous
answer; at most three primitives; show `summarize`, `compare`, `filter`. This reversed my round 2 asides and round 1
function cut. (2) A column is one person's exchange; one workspace model, recorded in `out.model`. (3) Circle-dot mark,
no model timestamps, no answer footer; the composer is a field and Cancel, Post, Ask; a tail ask always reads the
whole thread, with no exclusions, compacted when too long. (4) A branch reads the full context up to its fork cell; only a column's author continues or
inserts, so replies (lettie's) become branches.
