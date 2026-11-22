# Canvas variant C: dataflow

Mock: `docs/mockups/canvas-dataflow.html`. Seed content from `docs/mockups/session-handoff.html`.

The canvas of a channel is a reactive document, closer to a notebook than to a chat. Every object is a cell. A cell
holds text that a person wrote, or an expression that computes text from other cells. A post is a series of text
cells. An ask is a text cell followed by a cell whose expression is `answer(above)`. Answers are recomputed only when
someone presses Run, because runs cost money.

Reference: I could not read faketalk. The GitHub URL returned 404 and antimatter15.com is blocked by this
environment's network policy. The design follows the stated principles instead: everything is an object (a cell);
objects relate only through references, the equivalent of messages; references bind late, when a run starts; and
every object is inspectable and editable in place.

## Primitives

**Cell** `{ id, author, at, prev?, body, versions[], pinned }`
- `body.text`: written by a person. `@id` inside the text is a reference, shown as a chip.
- `body.expr`: computed. Two functions:
  - `answer(...)`: the only model call.
  - `quote(@id#n)`: free and derived on render. It has no versions.
- `versions` (answers only): `[{ n, html, read: [{id, hash}], expr, by, at }]`. A run appends a version and keeps the
  older ones.
- `prev`: the cell this one follows. A series is a `prev` chain.

**Placement** `{ head, mode: beside | inset | chip, x, y | dx, dy }`: one record per column head.
- A root cell's Placement is absolute.
- A fork (a second child of some cell) always has a Placement:
  - `beside`: its own column, positioned relative to its anchor until someone drags it.
  - `inset`: drawn in the gap under its anchor.
  - `chip`: not opened yet; a count on the anchor.
- The child that has no Placement is the series' continuation. This rule is explicit, so an insert or an older fork
  cannot change which child continues the column.

**Reference** is syntax, not a stored record: `@id`, or `@id#n` for passage n. Fork edges come from `prev`, and
mention and quote edges come from references.

## Relations and computation

`answer(above)` reads the `prev` chain to the root, through any fork, plus the cells those parts mention (one hop, not
the mentioned cell's own chain). Arguments: `above`, `@id` to include, `-@id` to exclude. The default ask shows no
code. The user types a question, and the expression lives in the inspector. There, the × on a read-set row writes
`-@id`, and typing `@id` adds a cell.

Example: a compare cell placed under two threads.

```
cq  text  "compare @ia and @aa: in each list, who does the agent actually work for?"
ca  expr  answer(above)          → reads cq, ia, aa
    expr  answer(above, -@aa)    → reads cq, ia      (written by the × in the inspector)
r3  expr  quote(@ia#4)           → passage 4 of ia, live, no run
```

A version records the hash of each cell it read. Comparing those hashes with the current ones gives the states an
answer can be in, each worded as an event in the margin:
- **up to date**: every hash still matches.
- **edited**: "Answered before [chip] was edited", with Re-run.
- **re-run**: "Written against answer 1 of [chip], which has been re-run", with Show answer 1 and Re-run.
- **added**: "Answered before [chip] was added", with Include and re-run. This means the current `above` holds a
  cell the version did not read.
- **expression changed**: the expression differs from the one the version ran with.
- **pinned**: the answer was pinned, which hides the badges above.

Re-run behaviour:
- Re-run reads the same cells as before, so the read set is pinned. "Include and re-run" resolves the set again.
- Re-run offers a scope: "Re-run with 4 below" runs the answers lower in the series that read this one, in order.
- There is no global re-run, and badges do not propagate past the cells that actually read the change.

Every answer's footer reads "Read n parts" and shows a pager, "‹ answer 2 of 2 ›". Clicking "Read n parts" marks the
cells it read on the canvas, and marks the cells above it that it did not read as "not read". So the read set is
visible before anything goes wrong.

What "computable object" means here:
- Computed cells are either model calls, which cost money, run only on request and are versioned, or free functions,
  which are recomputed on every render and are not versioned.
- `summarize` and `compare` are not functions. They are question text, which keeps one model function.
- More free functions fit the same slot. Candidates are `count`, `list of headings` and `latest answer of`. None is
  needed for the brief.

## Layout

- **Positions.** Roots are placed absolutely. Forks are placed relative to their anchor, so they follow it when the
  column above grows. A dragged column becomes absolute.
- **Growth.** Columns are laid out parents first. A column that would overlap one already placed is pushed down below
  it; nothing moves sideways. Answers render clamped to about eight lines, and a running answer reserves that height,
  so streaming does not reflow the canvas.
- **Inserting between two cards** creates an inset fork in the gap. It reads the parts above the gap, and the column
  grows by the aside's height. The answers below do not read it and stay up to date. Geometry shows the rule: flush
  parts are context for what follows, inset parts are not. "Merge into series" relinks the aside into the chain. The
  answers below then show "added" and offer Include and re-run.
- **Branching from mid-thread.** Branch on any text part or ask card opens a new column to the right at that card's
  height, joined by a fork edge. Its answer reads the series up to the fork and nothing below it.

## Mapping from the handoff model

| Today | Dataflow |
|---|---|
| Thread, post | root text cell; a multi-part post is a chain of the author's text cells |
| Thread, ask | root text cell (question) + `answer(above)` |
| Node, Continue | question + answer appended at the tail |
| Branch, Branch here, Branch (ask beside) | fork with Placement `beside` |
| Passage branch, Look up | fork whose question carries `@id#n` |
| Reply on a post | text cell appended (flush) or an inset fork under a part |
| Comment on a node | text inset fork under the answer; no run |
| Open as its own thread | give the fork head an absolute Placement; nothing is copied |
| Save | a per-user set of ids, outside the model |
| Channel | the canvas; Placements are per canvas |
| Run record | `versions[]` + the in-flight run |
| Follow-up counts | derived from `prev` and references |

## Open questions

- **Who may re-run** someone else's answer, and who pays for the run. The mock attributes every version to the person
  who ran it.
- **Merge permission.** Proposed: the series author, or the aside's author on an ask thread.
- **Shared layout.** Layout is last-writer-wins, so one person's drag moves the column for everyone. The alternative
  is per-user overrides.
- **Passage anchors.** A passage anchor survives a re-run through its stored text. Matching it fuzzily against a
  rewritten answer is unsolved.
- **Context size.** Context through deep forks has no bound. It needs a cap and a visible estimate before a run.
- **Free functions.** Whether to keep `quote` as the only free function or to add a small set.
- **Concurrent appends.** The server must resolve "append at tail" at commit time. Otherwise two appends become a
  silent fork.

## Advisor log

(filled in below)
