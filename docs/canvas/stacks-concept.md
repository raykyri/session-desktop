# Canvas variant B: stacks

Mock: `docs/mockups/canvas-stacks.html`. Seed content is converted from `docs/mockups/session-handoff.html`.

The direction starts from how reading and writing feel. A thread is a column of parts. You write into the gaps between
parts, and a part's context is whatever sits above it. The model has two primitives, Part and Stack, on a canvas.

Reference: Kevin Kwok's faketalk could not be read from this environment. GitHub lists no repository by that name
under antimatter15, and the network policy blocked antimatter15.com and Hacker News. The design works from the
principles in the brief instead. Every part is an object with a small rule of its own. Context is resolved at the
moment a run starts (late binding). The resolved context is inspectable and editable on the canvas.

## Primitives

**Part** is a block of text with an author.

| field | meaning |
|---|---|
| `id`, `stack` | identity, and the stack the part belongs to |
| `key` | fractional index; an insert takes a key between its neighbours, so nothing is renumbered |
| `author` | `{ person: id }` or `{ model: name }` |
| `text`, `at`, `rev` | content, time written, revision (bumped by a re-run) |
| `revs` | earlier texts, kept readable after a re-run |
| `run` | model parts only: `{ by, model, effort, see, ctx, status, src }` |

`run.by` is the person who asked. `run.see` is the context rule. `run.ctx` holds the resolved `[partId, rev]` list,
frozen when the run starts. `src` holds the run's sources.

An ask is a person part with a model part directly under it whose `run.by` is that person. A post is a person part
with nothing produced under it. The editor has two buttons, Post and Ask; nothing else distinguishes them.

**Stack** is a vertical column of parts.

| field | meaning |
|---|---|
| `id`, `canvas` | identity, and the channel the stack belongs to |
| `fork?` | `{ part, rev, block?, quote? }`: the part (or one block of it, or a quoted passage) the stack starts from |
| `x?`, `y?` | position. Only stacks placed by themselves have one: roots, and forks opened as their own thread |
| `inline?` | draw this fork inside its parent, at its anchor, instead of in a lane |

A **canvas** is a channel's namespace (id, name, members). It holds stacks and has no behaviour, so it is not counted
as a primitive. Collapse, expanded answers, zoom, selection, saves and read state are per-viewer view state, not
content.

One sentence covers the data rule: parts are never split or merged; they are inserted between other parts, or a new
stack forks from a part or from one block of a part.

## Context and the attached rule

A model part sees what its rule resolves to. The default rule is `above + trunk`.

| term | resolves to |
|---|---|
| `above`, `above N` | the parts above this one in its stack (or the N nearest) |
| `trunk` | for a fork: the fork part, plus everything that part sees positionally (recursive). For a block anchor, the whole part with the block marked |
| `fork` | the fork part only (with its quote) |
| `#id` | one part; the editor enters it by clicking a part and displays it as the part's first words |
| `none` | nothing |
| `+`, `-` | union, exclusion |

Examples:

```
see: fork                  a Look up: only the phrase's part
see: above 2               the two parts directly above
see: above + trunk - #p41  everything positional, except one comment
```

The rule belongs to the model part, and it only matters when a run starts. The rule is a selector over positions.
It does not compute values (direction C) or send messages (direction A).

The popover on a model part's "sees N" chip shows the rule, outlines the parts it resolves to as you type, and lists
the relations: position in the stack, fork of, forks from here.

Staleness is derived. If the current resolution differs from `run.ctx` (a part was inserted above, a rule changed, a
part in context was re-run), the part shows a quiet "changed" mark. Only the asker sees Re-run. Re-running writes a
new rev and keeps the old text. Nothing re-runs automatically, and the mark does not cascade, because a re-run is the
only thing that changes `ctx`.

## Layout

- **Units.** A root stack and its lane forks form one unit. Only the root stores x, y.
- **Lanes.** Within a unit, each fork wants to start level with its anchor (the part, or the block). Siblings are
  stacked by the extent of their whole subtree, so a fork's own forks stay next to it and connectors do not cross.
- **Growth.** Inserting at a seam opens a draft in that gap. Parts below, and the forks anchored to them, slide down
  (FLIP over 300 ms), and connectors are redrawn every frame. If a unit now overlaps a unit below it, one sweep
  (sorted by stored y, then x) draws the lower unit further down. The offset is derived, never stored, and goes away
  when the overlap ends. Stacks elsewhere do not move.
- **Seams.** Each stack shows "+ Add to this stack" at its end. On desktop, hovering a gap shows a "+" in the left
  gutter, which keeps it clear of text selection and dragging. On touch, tapping a stack selects it and every gap
  shows a 32px "+". Inside a selected answer, fainter "+" marks sit between blocks. They create an inline fork at
  that block, so the column grows at that point without the answer being split.
- **The draft is a small stack.** A textarea, "+ part" (or Enter on an empty line after a blank line), Post and Ask.
  A scope line says what an ask there would see ("sees 1 part above; the 1 below it does not").
- **Forks.** "Fork" on any part, or "Fork from selection" (which stores the block and quote), opens a lane stack to
  the right that sees everything up to the fork. "Move out" turns an inline fork into a lane fork.
- **New stacks.** "+ Add post" and "+ Add ask" place a root at the free spot nearest the centre of the view.
  Double-clicking the canvas writes at the pointer.
- **Overview.** Units are packed into columns by last activity. Collapsing a unit shows the root's first part and
  "n parts · m forks". Below 50% zoom the geometry stays fixed, and each part shows a headline at a constant screen
  size. "Next new" jumps to the next unit with unread parts. With the seed (22 units, 66 stacks, 156 parts),
  Fit lands at about 26%.

## Mapping from today's records

| today | stacks |
|---|---|
| channel | canvas |
| thread, post | root stack with one person part |
| thread, ask | root stack: person part, model part |
| node | a person part and the model part under it |
| reply | person part appended to the post's stack |
| reply to a reply | inline fork at the reply |
| comment on a node | person part after the answer. It becomes context for later asks below it; `- #id` excludes it |
| Branch here, ask about a passage | fork with `block` and `quote` |
| Continue | append or insert in the same stack |
| Branch beside | fork at the parent's model part |
| Look up | fork whose model part has `see: fork` |
| run record | `run` on the model part |
| save, counts | per-viewer view state; counts as today |
| Open as its own thread | give the fork stack its own x, y; `fork` stays, so its context is unchanged |

## Open questions

1. **Concurrent writes.** Two people insert into the same gap at once. Fractional keys keep both, but whether the
   second person's draft should show the first person's part before the write is sent is an open question.
2. **Who may insert where.** Today a branch never changes the thread above it. An insert changes the context of
   other people's answers below it. It may need a channel-level rule, such as "insert only above your own parts", or
   only a visible mark, as now.
3. **Excluding comments.** Excluding comments takes one `#id` per comment. If this happens often, add an "exclude"
   action that writes the refs. Do not extend the grammar for it.
4. **Unread at scale.** Unread is counted per unit. At 200 units, "Next new" may need ordering by channel or by person.
5. **Shared layout fields.** `inline`, x and y are shared, so one person's drag rearranges everyone's canvas.
   Per-viewer overrides would avoid that but would break shared references such as "the stack top left".

## Advisor log

The advisor critiqued the concept over three rounds. It was run as a separate subagent.

**Round 1 (concept v1).** It found a hidden fourth primitive, Run. Splitting answers into section parts would orphan
forks on a re-run and lose the quoted passage. The stale mark would cascade and carry a social cost. Fork placement
would overlap, and pushing other stacks would overwrite people's arrangement. Reply-to-reply as a fork would explode
the stack count. `collapsed` and `Stack.see` did not belong on Stack, and the grammar was too large.
*Changed:* one run is one part (`run` is a field); the fork anchor is `{part, rev, block?, quote?}`; staleness is
quiet, asker-only and non-cascading, and a re-run keeps the old rev; a unit is laid out as one piece and
displacement is derived; Canvas is not a primitive; collapse is view state; `Stack.see` was cut; the grammar is
`above [N]`, `trunk`, `fork`, `#id`, `none`, `+`, `-`; the draft is a small stack.

**Round 2 (v2).** Split-on-demand (`cont`) brought orphaning back. Depth-indexed lanes would cross. Displacement was
undefined horizontally. Semantic zoom would trigger a relayout. The seed had no positions. Appending needed a
selection first. Open-as-own-thread broke context. `inserted` could be derived.
*Changed:* removed `cont`, and a seam inside an answer now makes an inline fork; lanes use subtree extents; there is
one top-down sweep; the overview keeps the geometry; columns are ordered by last activity; free-spot placement; an
always-visible end seam plus a gutter "+"; the fork is kept on open-as-own-thread; `inserted` is derived.
*Rejected:* horizontal displacement. The vertical sweep already resolves a unit that grows into its neighbour, and
moving units sideways would break the columns people read down.

**Round 3 (mock walkthrough).** ROUND3
