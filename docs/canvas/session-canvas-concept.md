# Session Canvas

Mock: `docs/mockups/session-canvas.html`. This is the working copy of the canvas design, started from variant B
("stacks"; `docs/canvas/stacks-concept.md` and `docs/mockups/canvas-stacks.html` on `claude/canvas-stacks` at
`e4e829d`). Variants A (messages) and C (dataflow) are on `claude/canvas-messages` and `claude/canvas-dataflow`. Its
seed is converted from `docs/mockups/session-handoff.html`.

A thread is a column of posts. Its author writes into the gaps between posts, and a post's context is what sits above
it. There are two stored primitives, Post and Thread, and they live on a canvas.

## Terms

| term | meaning |
|---|---|
| post | one block of text by one author, or one model answer (stored: Post) |
| thread | the stored sequence of posts (stored: Thread) |
| stack | how a thread is drawn on the canvas: a vertical column of posts |
| branch | a thread that starts from a post, or from one paragraph of it (stored: a Thread with `fork`) |

"Branch" is the UI word; `fork` is the field name in the stored model. The mock's code still calls posts "parts" and
threads "stacks".

## Primitives

**Post**: a block of text with an author.

- `id`, `thread`, `key`. The key is a fractional index: an insert takes a key between its neighbours, so nothing is
  renumbered.
- `author`: `{ person }` or `{ model }`.
- `text`, `at`.
- `run`, on model posts only: `{ model, status, src }`.
  - `model` only records what produced the post. The model is a workspace setting, not chosen per ask, and is shown
    once beside "Add ask". There is no effort setting.
  - `status` is queued, running, complete or stopped. The thread's author can stop a queued or running answer; the
    text written so far stays, and the answer reads "Stopped before it finished".

An ask is a person's post with a model post directly under it. A plain post is a person's post with nothing produced
under it. The editor has two buttons, Post and Ask; nothing else distinguishes them.

**Thread**: an ordered list of posts, drawn as a stack.

- `id`, `canvas`.
- `fork?`: `{ part, block?, quote? }`, the post a branch starts from. A block or quote marks one paragraph as the
  focus.
- `x?`, `y?`: set only on threads placed by themselves (roots, and branches placed on their own).

A thread's **author** is the person who wrote its first post. Only the author continues a thread, by adding to its end
or inserting between its posts; everyone else branches. By default a thread is one person's multi-turn exchange with
the model: question, answer, follow-up, answer.

A **canvas** is a channel's namespace with no behaviour, so it is not a primitive. Collapse, zoom, saves and read
state are per-viewer, not content. Posts are never split or merged.

## Context

Context is fixed by position, everywhere. A model post reads:
- every post above it in its thread;
- if the thread is a branch, the post it starts from and everything that post read, recursively.

A branch from a paragraph reads the same full context; the paragraph only marks the focus. An insert reads what is
above it; the answers below it keep what they read when they ran.

**No attached code.** Every candidate rule turned out to be a choice the person shouldn't have to make, because
position already says what a post is about. What a run read is computed from position when it is needed, not stored.

There are no staleness marks and no labels on inserted posts. An inserted ask and its answer are indented under the
post above them.

**Compaction.** When the thread above is longer than the model's context budget, the earliest posts are replaced by a
compacted summary. The posts nearest the new post, and the branch point, stay verbatim. The mock doesn't implement
this.

## Layout and interaction

- **Seams (author only).** Your own stacks end with "Continue". On desktop, hovering the line between two posts shows
  a small "+" in the left gutter, and clicking the line or the "+" opens an insert there; on touch, tapping a post
  shows the "+" in the gaps beside it. There is no seam between a question and its answer. Other people's stacks
  show no seams; you branch from them instead.
- **Inserting.** A draft opens in the gap and the posts below slide down (FLIP, 300 ms). The draft is a text field and
  one row: [⊕ add a post] [Post] [Ask]. An X at the top right discards it, and the Ask shortcut is in the button's
  title. An empty insert closes when it loses focus.
- **The post menu.** Branching lives in one place: right-click a post, or long-press it on touch. Nothing appears on
  hover or on text selection. Both items read the same context (the post and everything above it); each item's
  second line says where the result goes:
  - "Ask about this paragraph" (on an answer's paragraph): a new stack in the next lane that targets that paragraph
    (`fork.block`). Its connector starts at the paragraph, which keeps a small mark, and the branch's header reads
    "From paragraph" above the quoted paragraph. A branch from a whole post reads "From answer" (question, post).
    While the menu is open, the paragraph is tinted. With text selected, the item reads "Ask about the selection".
  - "Branch from this answer / question / post": a new stack in the next lane, about the whole post.
  Every branch is drawn in a lane beside its anchor. Hovering a branch highlights its anchor (post or paragraph).
- **Units.** A root and its branches form a unit, and only the root stores x and y.
  - Branches start level with their anchor, and siblings stack by subtree extent, so connectors don't cross.
  - Overlaps between units are resolved downward and never stored.
  - The unit being edited keeps its place.
- **Scale.** The seed has 22 units, 61 threads and 158 posts.
  - Units are packed in columns by last activity.
  - Zoom is explicit: the −/+ buttons, Fit, and the keyboard (+, −, 0). The wheel, trackpad and touch only pan.
    Cards show their full content at every zoom.
  - A collapsed unit shows its first post, "N more posts", and the branch count with a branch icon.
  - A bell at the top right lists the posts new to the viewer, newest first; choosing one opens its unit and selects
    its stack, and "Mark all as read" clears the list.

## Mapping from today's records

| today | canvas |
|---|---|
| channel | canvas |
| post thread | root thread; the author's own follow-ups are appended posts |
| reply, reply to a reply | a branch by the replier, from the post or the reply |
| ask thread | root thread: the person's post, then the model post |
| node | a person's post plus the model post under it |
| Continue | the author's next turn in the same thread (append or insert) |
| Branch here, ask about a passage, Look up | branch with `block` or `quote` as focus; full context |
| Branch beside | branch at the parent's model post |
| comment on a node | the author's post after the answer, or anyone's branch from it (or from one paragraph) |
| run record | `run` on the model post |
| save, counts | per-viewer state; counts as today |
| Open as its own thread | give the branch its own x, y; `fork` stays, so its context is unchanged |

## Open questions

1. Can a thread's author invite others to continue it, or is branching always enough?
2. Two inserts by the author on two devices into one gap both survive (fractional keys). Is that the right merge?
3. Asks at the end of a thread can't skip posts above them. Does compaction need to drop posts the author marks as
   asides first?
4. `x` and `y` are shared, so one person's drag rearranges everyone's canvas.

## Advisor log

This log uses the terms of the time (part, stack, fork).

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
