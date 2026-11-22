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
| `by` | a person's handle, or `model` for a model reply |
| `text` | content (HTML for model replies) |
| `prev` | the part it follows or answers |
| `pos` | `next` · `inline` · `beside {dx,dy}` · `at {x,y}` |
| `to?` | present on an ask. `[]` means the part above, or the canvas if there is none. Otherwise part ids or passages `id#start-end`. |
| `saw?` | on an ask: the context resolved at send time |
| `code?` | `{ ask, context, place }` sources, each with its author |
| `k` | order key among inline siblings |

- A part without `to` is a post part and sends nothing.
- A part with `to` is an ask: a reified message.
- A part by the model is the reply to its `prev`. Its run records which model produced it.
- A multi-part post is a chain of parts joined by `next`.

Post and ask are the same record; in the mock every draft has both a Post button and an Ask button.

**Canvas**: `{ id, name, code? }`, a channel. It is the root of handler lookup.

**The model is a workspace setting.** Every ask in every thread runs on the same model, and nobody picks one per ask
or per turn. The mock shows the model's name once, beside the channel label ("#public · Gemini 3.8 Flash"); model
parts carry a short mark ("Gemini").

**A thread is, by default, one person working with the model over many turns:** question, answer, follow-up,
answer. In the seed, each thread's follow-ups are by the person who asked first. Other people appear only where they
show something specific: replies on a post, and one other person's branch.

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

**Context is fixed by position.** An ask placed in a thread always reads the part it hangs from and everything above
it, through earlier branch points. That covers continuations (Continue), interjections (Ask here), branches, and
passage asks. A passage ask is a branch whose quoted passage marks its focus. There is no "this message only" kind of
branch. Context handlers can only add to that base: what `context` returns is unioned with it. An ask sent to a
selection of parts in different threads has no position, so its context is what the receivers' handlers return.

**Compaction.** When the thread above an ask is longer than the model's budget, its earliest parts are replaced
by a compacted summary, and `saw` records that a compaction was used. The mock does not implement this.

**Lookup.** For part X the order is:

1. X;
2. X's head;
3. the head of the part that head hangs from, and so on;
4. the canvas;
5. the default.

**Late binding, seeded in the mock.** The Dagen H head defines `context`, and every ask in its stack resolves to it.
The handler adds jun.park's Sources card:

```js
context(msg) {
  // Every ask in this thread also reads my Sources card.
  return [...ancestors(this.id), ...stack('src0')];
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
takes precedence over it. The mock opens with Dagen H at the top left, with a hint. Delete the Sources card from
the handler and Continue: the new answer no longer lists the sources, and earlier answers keep what they saw.

**The inspector** shows each handler, where it resolved from and who wrote it. Its preview ("the next ask sent here
would see …") updates as soon as a handler is edited at any level.

**Sandbox and failures.** Handlers get read-only `this`, `msg`, `part`, `ancestors` and `stack`, and no I/O. A
handler that throws is skipped, the next level runs, and the ask records the failure.

## Layout

The visual layout follows variant B (stacks); the model underneath is this variant's.

- **A thread is one card.** A head with `at` is a card. Its `next` chain is drawn as sections separated by hairlines.
  A question and the answer it prompted read as one pair. Model answers have a slightly different background. The
  header strip shows the channel, a collapse toggle, and works as the drag grip. Dragging rewrites `at`.
- **Who may add where.** Only the person who started a thread can add to it or insert into it. On their own threads a
  "+" appears in the left gutter of a hovered gap. Every gap shows one when the card is selected, or on touch. That
  "+" is Ask here. "+ Add to this thread" at the bottom is Continue. Everyone else branches, with Branch or Ask about
  this. A small "as" switch in the toolbar shows both cases. It starts as jun.park, who owns Dagen H but not ines.v's
  thread.
- **Interjections** (Ask here between B and C: `prev = B, pos = inline`) are drawn inside the card, indented with a
  rule, and fold to one line. More than two collapse to "N more". C keeps `prev = B`, so the parts below never read
  the interjection.
- **Branches** (`pos = beside`, including passage asks that quote their focus) go in lanes to the right of the parent
  card: one column width plus a gap, starting level with the anchor part. Sibling branches stack downward by the
  extent of their whole subtree, so connectors do not cross. A stored `beside` offset is not used for drawing.
- **Units.** A root card and its branch lanes form a unit, and only the root stores a position. Overlapping units are
  pushed down in one sweep, without storing the offset. The unit being edited stays put. At first load, units are
  packed into columns.
- **Connectors** run from the anchor on the parent card's right edge to the top-left of the branch. Each is a faint
  curve with a dot at the anchor, and turns accent within the active unit. Hovering a branch highlights its anchor.
  Asks sent to a passage or a selection use the same curve, dashed.
- **Zoom.** Controls sit at the bottom right (−, %, +, Fit). Below 50% each card shows one headline at a constant
  screen size.
- **What an ask read** shows as a tinted left bar on those parts when the ask or its reply is hovered or selected. The
  inspector lists them, with each part's `{ }`. Only a handler failure prints on a card. The canvas does nothing that
  is not a handler shown in its inspector.

## Mapping from today's records

| today | here |
|---|---|
| thread: post | head part, `pos: at`, no `to` |
| thread: ask (node `r`) | head part with `to: []` (sent to the canvas), and its reply |
| Continue | ask with `prev` = the answer, `pos: next` |
| Branch (beside) | ask with `pos: beside` |
| quoted-passage node | ask with `to: ["id#s-e"]` |
| Look up | an ask reading "look up …"; an `ask` handler may answer it |
| reply on a post, comment | another person's branch beside it: a part with `pos: beside` and no `to` |
| save | a per-person set of ids, outside the model |
| Open as its own thread | a new head on another canvas that keeps `prev` as a back-link, with frozen copies of its handlers |

## Open questions

1. **Who may attach code.** The mock lets anyone edit. In the app, the author would edit a part's handlers and the
   channel owner the canvas's, with a history and a timeout.
2. **Visibility.** A handler can return any id. The server must filter `saw` by what the asker may read, including
   parts on other canvases reached through `prev`.
3. **Effort.** The model is fixed for the workspace, but effort is not settled. It could be a workspace setting too,
   or an argument of `ask` that a handler may set.
4. **Branch clutter.** Replies are branches now, so a busy post grows a column of single-part branches beside it.
   Collapsing them to a count may be needed.
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

**Steer from the parent session (after round 3).**
- *It said:* keep the handler surface small; behaviour such as the Glossary inclusion or "+N" should read as the
  result of handlers. Make late binding the first thing a viewer can try.
- *Changed:* the "+N" label now names a context handler. Dagen H moved to the top left, with a hint for the
  edit-then-continue demo.

**Second steer from the parent session, on the user's behalf.**
- *It said:* make a thread one person's multi-turn exchange with the model, and make the model a single workspace
  setting.
- *Changed:*
  - each seeded thread's follow-ups are by its first asker (3 turns each in Dagen H, the intention scan and
    Banach–Tarski); hal_b's branch is the one other person's thread;
  - the model is named once in the toolbar and nowhere chosen;
  - the doc states that the model is a workspace setting, and open question 3 is now about effort only.

**Third steer from the parent session, on the user's behalf.**
- *It said:*
  - Model parts carry no timestamp. The mock never showed one, so nothing changed.
  - The draft card loses its hint text.
  - The per-ask "to … / saw" line goes.
  - A continuation always reads the whole thread, or a compacted version of it.
- *Changed:*
  - The draft is a text field and one right-aligned row (Cancel or Done, Post, Ask), with shortcuts in button titles.
    A faint "to …" line appears only for selection and passage asks.
  - The footer keeps only failures.
  - Continuations union handler results with the full thread (option (a)). The Dagen H handler, which used to filter
    answers out, now adds a Sources card, and the demo deletes it from the handler.

**Fourth steer from the parent session, on the user's behalf.**
- *It said:*
  - A branch always reads everything above the part it branches from.
  - Only a thread's author can continue it or insert into it.
  - Other people's replies on a post are branches.
  - The title becomes "Session Canvas Messages (A)".
- *Changed:*
  - Every positioned ask starts from its ancestors, and handlers only add.
  - Continue and Ask here appear only for the thread's author, with an "as" persona switch in the toolbar.
  - hal_b's post now has its replies as branches beside it.
  - Open question 4 replaced (comments are no longer inline).

**Fifth steer from the parent session, on the user's behalf.**
- *It said:* adopt variant B's visual layout. That means one card per thread, interjections folded inside, branch
  lanes, B's connectors, zoom controls and initial packing, while keeping this variant's model, handlers, inspector,
  selection asks and persona switch.
- *Changed:* the Layout section above. The mock's rendering and layout were rewritten on B's rules; the message
  model is unchanged.
