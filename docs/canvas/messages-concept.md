# Canvas variant A: messages

Mock: `docs/mockups/canvas-messages.html`. I could not read Kevin Kwok's faketalk from this session: GitHub search
found no public repository by that name, and the network proxy refused antimatter15.com. The design follows the
principles instead: everything is an object, objects interact only by messages, binding is late, and the running
environment can be inspected.

## Primitives

There are two records. Handler code is a field on them.

**Part**: one block of text, written by a person or produced by a model.

| field | meaning |
|---|---|
| `id`, `canvas` | identity; its channel |
| `by` \| `model` | author: a person's handle, or a model |
| `text` | content (HTML for model replies) |
| `prev` | the part it follows or answers |
| `pos` | `next` · `inline` · `beside {dx,dy}` · `at {x,y}` |
| `to?` | present on an ask. `[]` means the part above, or the canvas if there is none. Otherwise part ids or passages `id#start-end`. |
| `saw?` | on an ask: the context resolved at send time |
| `code?` | `{ ask, context, place }` sources, each with its author |
| `k` | order key among inline siblings |

- A part without `to` is a post part and sends nothing.
- A part with `to` is an ask: a reified message.
- A part by a model is the reply to its `prev`.
- A multi-part post is a chain of parts joined by `next`.

Post and ask are the same record; in the mock every draft has both a Post button and an Ask button.

**Canvas**: `{ id, name, code? }`, a channel. It is the root of handler lookup.

## Messages

| selector | sent by | to | default |
|---|---|---|---|
| `ask(msg)` | a person submitting an ask | each receiver | `model(msg)` |
| `context(msg) → ids` | the system | each receiver; the results are unioned into `saw` | the receiver and its ancestors |
| `place(reply, msg) → pos` | the system | the ask | `'next'` |

When an ask is sent:

1. `context` runs on each receiver, and the union of the results is stored as `saw`.
2. `ask` is offered to each receiver in order. The first handler that returns `reply(text)` answers. If none does, one
   model call runs on `saw`.
3. `place` positions the reply.

Handlers run once per send and are never recomputed, so an old answer still says what it saw.

**Lookup.** For part X the order is:

1. X;
2. X's head;
3. the head of the part that head hangs from, and so on;
4. the canvas;
5. the default.

**Late binding, seeded in the mock.** The Dagen H head defines `context`, and every follow-up in its stack resolves to
it:

```js
context(msg) {
  // Follow-ups see people's questions and the first answer, not answers to other follow-ups.
  return ancestors(this.id).filter(id => !part(id).by.model || part(id).prev === this.head);
}
```

The Glossary card answers "define …" from its own parts, with no model:

```js
ask(msg) {
  const m = msg.text.match(/^(?:define|look up)\s+(.+?)[?.]*$/i);
  if (!m) return model(msg);
  const line = stack(this.id).map(id => part(id).text)
    .find(l => l.toLowerCase().startsWith(m[1].toLowerCase() + ' —'));
  return line ? reply(line) : model(msg);
}
```

The canvas `context` adds the Glossary terms an ask mentions to every ask in #public. The Dagen H head's own handler
takes precedence over it.

**The inspector** shows each handler, where it resolved from and who wrote it. Its preview ("the next ask sent here
would see …") updates as soon as a handler is edited at any level.

**Sandbox and failures.** Handlers get read-only `this`, `msg`, `part`, `ancestors` and `stack`, and no I/O. A
handler that throws is skipped, the next level runs, and the ask records the failure.

## Layout

- **Positions.** Only heads (`at`, `beside`) store coordinates; `next` and `inline` parts are drawn inside their
  stack. A `beside` offset is relative to the anchor part. Dragging a header moves the stack and rewrites `at` or the
  offset. Stacks are a convention, not a record.
- **Order.** A part, then its `inline` children by `k`, then its single `next` child. A second Continue becomes a
  branch.
- **Growth.** "Ask here" between B and C creates `prev = B, pos = inline`, drawn indented with a rule. C keeps
  `prev = B`, so the parts below never see the interjection, and nobody else's part is edited. The stack grows, and
  more than two interjections collapse to "N more".
- **Branching mid-thread.** "Branch" on B creates `prev = B, pos = beside`, with context B and everything above it.
  Selecting text and choosing "Ask about this" does the same with `to: ["B#s-e"]`.
- **Collisions.** Heads are placed in creation order, each followed by its branches. Overlapping stacks move down; a
  branch pushed far from its anchor takes the next lane to the right.
- **Connectors** appear only where position does not show the relation: branches, passage asks and selection asks.
  Each ask also shows its receivers ("to d1 · Gemini reply") and what it saw ("saw 3 + 1 from elsewhere", or
  "answered by code on g0 · no model").

## Mapping from today's records

| today | here |
|---|---|
| thread: post | head part, `pos: at`, no `to` |
| thread: ask (node `r`) | head part with `to: []` (sent to the canvas), and its reply |
| Continue | ask with `prev` = the answer, `pos: next` |
| Branch (beside) | ask with `pos: beside` |
| quoted-passage node | ask with `to: ["id#s-e"]` |
| Look up | an ask reading "look up …"; an `ask` handler may answer it |
| reply, comment | person part, `pos: inline`, no `to` |
| save | a per-person set of ids, outside the model |
| Open as its own thread | a new head on another canvas that keeps `prev` as a back-link, with frozen copies of its handlers |

## Open questions

1. **Who may attach code.** The mock lets anyone edit. In the app, the author would edit a part's handlers and the
   channel owner the canvas's, with a history and a timeout.
2. **Visibility.** A handler can return any id. The server must filter `saw` by what the asker may read, including
   parts on other canvases reached through `prev`.
3. **Model and effort.** These are not fields yet. They could be args of `ask`, or chosen by a handler.
4. **Comments in context.** An inline reply is an ancestor of anything asked under it. Should comments enter context
   by default?
5. **Scale.** Push-down layout makes long columns at 50+ stacks. Zoom (Ctrl/⌘ + wheel) helps. Collapsing stacks to
   their heads would also help, and should be view state, not a field.

## Advisor log

The advisor was a separate agent, run for three rounds.

**Round 1 (v1: Object, Message, Handler; messages ask, context, place, render).**
- *It said:*
  - Message duplicates the ask part, and Handler is already a field.
  - Insertion rewrote `C.prev`, which edits another person's part and changes the context below it.
  - `render` is view state.
  - Nothing could change who answers.
- *Changed:* Message merged into the part. Insert and branch became one record that differs only in `pos`. `render`
  was cut, `ask` became overridable, and `saw` snapshots context.
- *Rejected:* a single ask affordance. The brief wants insert and branch as distinct gestures, and they still create
  the same record.

**Round 2 (v2).**
- *It said:*
  - The head definition contradicted itself, and `next` was not unique.
  - Time order misplaced inserts.
  - Multi-receiver dispatch was undefined.
  - The Glossary demo read `msg.context` before it existed.
  - No demo exercised the canvas level.
- *Changed:* `at` merged into `pos`, and lookup climbs through branch anchors. There is one `next` per part and an
  order key. The first receiver that replies wins. A canvas `context` demo replaced a layout-only `place` demo.

**Round 3 (mock walkthrough; the advisor read the code and screenshots).**
- *It said:*
  - The mock read as feed columns: nothing could be moved, and receivers were truncated.
  - Branches fell far from their anchors.
  - `saw` misreported code answers.
  - The canvas demo fed a maths glossary to a parking question.
  - Code replies showed a person's name, and failures were invisible.
- *Changed:*
  - stacks can be dragged and the canvas zooms;
  - each ask has a "to …" line;
  - `saw` separates context from elsewhere and code answers;
  - branches are placed right after their anchor and take the next lane;
  - the Glossary has one part per term, and the canvas adds only the terms an ask mentions;
  - code replies read "code on g0 · by lettie";
  - failures and handler authors are shown.
- *Deferred:* edit permissions (open question 1).
