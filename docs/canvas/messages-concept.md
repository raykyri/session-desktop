# Canvas variant A: messages

Mock: `docs/mockups/canvas-messages.html`. Reference: Kevin Kwok's faketalk could not be read from this session
(no public repository turned up in GitHub search, and the proxy refused antimatter15.com). The design follows the
stated principles instead: everything is an object, objects interact only by messages, handlers bind late, and the
environment can be inspected while it runs.

## Primitives

Two records. Handler code is a field, not a third kind.

**Part** — one block of text on the canvas, written by a person or produced by a model.

| field | meaning |
|---|---|
| `id`, `canvas` | identity; the channel it belongs to |
| `by` \| `model` | a person's handle, or the model that wrote it |
| `text` | the content (HTML for model replies) |
| `prev` | the part this one follows or answers |
| `pos` | `next` · `inline` · `beside {dx,dy}` · `at {x,y}` |
| `to?` | present on an ask: `[]` = the part above (the canvas if none), or explicit part ids / passage addresses `id#start-end` |
| `saw?` | on an ask: the context ids resolved when it was sent |
| `code?` | `{ ask, context, place }` handler sources |
| `k` | order key among inline siblings |

A part without `to` is a post part and sends nothing. A part with `to` is an ask: the reified message, as Smalltalk
reifies a message send. A part by a model is the reply to its `prev`. A multi-part post is a chain of person parts
joined by `next`. Post and ask are the same record. In the mock every draft has both a Post and an Ask button.

**Canvas** — `{ id, name, code? }`: a channel and the root of handler lookup.

## Messages

| selector | sent by | to | default |
|---|---|---|---|
| `ask(msg)` | a person, by submitting an ask part | each receiver in `to` | `model(msg)` |
| `context(msg) → ids` | the system | each receiver; the results are unioned | the receiver and its ancestors |
| `place(reply, msg) → pos` | the system | the ask part | `'next'` |

When an ask is sent:

1. `context` runs on each receiver, and the union of the results is stored as `saw`.
2. `ask` is offered to each receiver in order. The first handler that returns `reply(text)` answers. If none does, one
   model call runs on `saw`.
3. `place` decides where the reply goes.

Handlers run once per send, and nothing is recomputed afterwards. An old answer can always say what it saw, even after
someone edits a handler.

**Lookup** for part X: X, then X's head, then the head of the part that head hangs from, and so on, then the canvas,
then the default. The inspector shows where each handler resolved from (`own`, `head d0`, `canvas`, `default`).

**Late binding, as seeded in the mock.**

The Dagen H head carries a `context` handler. Every follow-up below it resolves `context` to that handler, so editing
it on one card changes what every later ask in the stack sees:

```js
context(msg) {
  // Follow-ups see people's questions and the first answer, not answers to other follow-ups.
  return ancestors(this.id).filter(id => !part(id).by.model || part(id).prev === this.head);
}
```

The Glossary card answers asks sent to it without a model:

```js
ask(msg) {
  const m = msg.text.match(/^(?:define|look up)\s+(.+?)[?.]*$/i);
  if (!m) return model(msg);
  const line = stack(this.id).flatMap(id => part(id).text.split('\n'))
    .find(l => l.toLowerCase().startsWith(m[1].toLowerCase() + ' —'));
  return line ? reply(line) : model(msg);
}
```

The canvas `context` adds the Glossary to every ask in #public. The Dagen H head's own `context` handler takes
precedence over the canvas, and the inspector shows that.

Handlers are sandboxed. They have read-only access to `this`, `msg`, `part`, `ancestors` and `stack`, and no I/O. A
handler that throws is reported in the inspector, and lookup falls through to the next level.

## Layout

- **Positions.** A head (`at` or `beside`) starts a stack. `next` and `inline` parts are drawn inside their stack, so
  only heads store coordinates. A `beside` offset is relative to the anchor part, so a branch moves with the part it
  hangs from. Stacks are a drawing convention, not a record.
- **Drawing order.** Each part is drawn first. Its `inline` children follow in `k` order, each with its own
  subtree. Its `next` child comes last. Each part has at most one `next`; a second Continue becomes a `beside`
  branch.
- **Growth.** "Ask here" in the gap between B and C creates an ask with `prev = B` and `pos = inline`, drawn indented
  with a rule. C keeps `prev = B`, so C's context never includes the interjection, and nothing anyone else wrote is
  edited. The stack grows and later parts move down. An interjection group of more than two collapses to "N more".
- **Branching from mid-thread.** "Branch" on B creates `prev = B` with `pos = beside`. Its default context is B and
  everything above it. Selecting text and choosing "Ask about this" does the same, with `to: ["B#s-e"]`.
- **Collisions.** Stacks are placed in creation order. A stack that would overlap one already placed moves down.
- **Connectors** are drawn only where position does not already show the relation: branches, replies placed
  beside, passage asks and asks to a selection.

## Mapping from today's records

| today | here |
|---|---|
| thread (post) | head part with `at`, no `to` |
| thread (ask), node `r` | head part with `at` and `to: []` (sent to the canvas), plus its reply |
| node: Continue | ask with `prev` = the answer, `pos: next` |
| node: Branch (beside) | ask with `pos: beside` |
| node with quoted passage | ask with `to: ["id#s-e"]` |
| Look up | an ask whose text is "look up …"; a canvas or card `ask` handler can answer it |
| reply on a post, comment on a branch | person part, `pos: inline`, no `to` |
| save | a per-person set of part ids, outside this model; it sends no message and draws nothing |
| Open as its own thread | a new head on another canvas, keeping `prev` as a back-link and frozen copies of its resolved handlers |

## Open questions

1. **Who may attach code.** A canvas handler is one person's code running on everyone's asks. It needs an edit
   permission (the owner), a history, and a timeout.
2. **Context across canvases.** The default context of a promoted thread still crosses back to its original canvas
   through `prev`. Readers of the new channel may not be able to read those parts.
3. **Model and effort.** Both are in no field. They could be args of `ask`, or a handler could choose them.
4. **Replies in context.** A person's inline reply is an ancestor of anything asked under it. Should comments enter
   context by default?
5. **Insertions above old answers.** An insertion never changes `saw` for the parts below it, and the mock does not
   flag the parts below as having asked without it. Should it?
6. **Collisions at 50+ stacks.** Push-down layout produces long columns. A canvas this size probably needs
   collapsing whole stacks to their head, which is view state, not a field.

## Advisor log

Advisor: a separate agent, three rounds.

**Round 1 (concept v1: Object, Message, Handler; four messages, including `render`).**
- It said: Message duplicates the question part; Handler is a field; `prev` was doing three jobs; insertion
  rewrote `C.prev`, which edits another person's part and changes the context below it; `render` is view state;
  nothing could change who answers; context should be snapshotted.
- Changed: all of the above. Message merged into the part; insert and branch became one record differing by `pos`;
  `render` cut; `ask` made overridable; `saw` added.
- Rejected: a single ask affordance. The brief asks for insert and branch as distinct interactions, and both create
  the same record.

**Round 2 (v2).**
- It said: the head definition contradicted itself (a branch had no `at`); `next` was not unique; time order put
  inserts in the wrong place; `to` duplicated `prev`; the Glossary demo used `msg.context` before it existed;
  multi-receiver dispatch was undefined; the `place` demo was layout, not messaging; no demo used the canvas level.
- Changed: `at` merged into `pos`; lookup climbs through anchors; one `next` per part; an order key; `to: []`
  defaults to the part above; the first receiver to reply wins; the place demo replaced by a canvas `context` demo.

**Round 3 (mock walkthrough).** _(pending)_
