# @session/mutators

The write definitions of Session's spaces, shared by the client and the
server. The client runs a write through `apply` to predict its result over its
replica; the server runs the same write through `apply` as the authority over
its store. Nothing here touches the network, the clock or a random source.

## The engine (`src/engine.ts`)

A mutator is made with `defineMutator`:

```ts
defineMutator({
  name: "threads.update",
  input: zodSchema,          // strict: an unknown field is BAD_REQUEST
  online?: true,             // never queued; EXPIRED when its id is over a minute old
  ids?: (i) => [i.id],       // client-made ids, checked against the id window
  can: (tx, i) => Scope,     // permission check; only inSpace, inSpaces, personal make a Scope
  pre?: (ctx, i) => values,  // server only: values the client cannot have
  needsPre?: (i) => boolean, // whether pre runs for this input (default: always)
  run: (tx, i, values) => result, // deterministic over tx
  effects?: (i, result) => Effect[], // post-commit work, as data
});
```

The stages run in this order:

1. `can(tx, input)` checks permissions and returns the write's `Scope`.
   `inSpace` refuses a space that does not exist or that the actor is banned
   from, then checks the role (`user`, `member`, `moderator`, `admin`,
   `owner`), so every write in a space passes the ban check.
2. `pre(ctx, input)` runs on the server only. It makes values the client
   cannot have (an invite code from the server's random source) and checks
   limits whose records no replica holds whole (device runs an hour). A
   client that predicts a write whose `pre` would run gets `unknown`.
3. `run(tx, input, values)` writes the stored shape through `tx`. It reads the
   time from `tx.now`/`tx.nowMs`, uses no random source and no `Intl`, and
   makes no ids: the first new id comes in the input, later ones from
   `tx.id(ordinal)` (`deriveId(user, mutationId, ordinal)`).
4. `effects(input, result)` lists the post-commit work: `job` (a run or a
   domain check), `notifyStaff` and `reportResolved`. Effects carry ids, never
   text.

`apply(registry, source, actor, envelope, { now, server? })` checks the actor,
the name, the input, the new ids' age and an online-only write's age, then
runs the stages. It answers:

- `{ status: "ok", result, scope, writes, effects }`: `writes` are the staged
  records (without `rev`, which the store sets) or `null` for a delete;
- `{ status: "refused", error }`: an `ApiError` with a fixed message per code
  and cause. A STALE refusal carries `current` (the target as the actor may
  read it now) and `reads` (the keys the answer is about; a server half
  answers them as `changes` and stores only the keys);
- `{ status: "unknown", reason }`: the source could not answer a read, or the
  write needs `pre` on a client. The client shows the write as pending and
  waits for the server.

Any exception that is not a `Refusal` answers INTERNAL_SERVER_ERROR with
nothing written. The server half checks the envelope (protocol version,
client, seq, idempotency, the device's clock, the mutation id's and
`queuedAt`'s age) before it calls `apply`; see `@session/sync`.

## Records (`src/records.ts`) and read rules (`src/access.ts`)

Every record has `kind` and an integer `rev` that the store sets on each
write; a record written again at a deleted key continues from its last rev.
Optional fields are `null`, so two writes of the same state are equal.
`keyOf`, `logsOf` (a space's log, a user log, or `catalog`), `audienceOf` (the
fields a write may never change) and `INDEXES` (the scans a store provides)
are the helpers a store needs.

Notable records:

- `counts`: a thread's like, follow-up and reply-like counts, so a like does
  not move the thread's rev;
- `hide`: a hidden item, keyed `hide:<item key>`. Hiding and showing do not
  change the item; "shown" compares the hide record's rev, which an author's
  edit of the hidden item also moves. A removal is the item's own `mod:
"removed"`, with its text erased;
- `skill` and `skills`: each skill is its own record; `skills` holds the
  space's order, whose rev `skills.reorder` compares;
- `device` and `apikey`: a person's devices and API keys, without tokens or
  raw keys, in their user log. The online-only calls write them; `can` checks
  them for device runs and paid asks.

`view(reader, record, u)` is the record as `u` may read it now, or null:
`canRead` decides the audience and `redact` blanks hidden text for everyone
but its author and the space's moderators, and a pending source's fields.
`viewDependents(record)` names the records whose view a record's change
changes (a hide record's item): a server half re-serves them in the same
commit.

## `RecordSource` and `withOwnIds` (`src/engine.ts`, `src/replica.ts`)

A store provides three reads:

```ts
interface RecordSource {
  get(kind, id): StoredRecord | undefined | UNKNOWN;
  scan(index, value): readonly StoredRecord[] | UNKNOWN;
  idUsed(id): boolean | UNKNOWN; // the id registry: was this id ever used
}
```

The server's source answers every read. A replica answers UNKNOWN for what it
does not hold. `withOwnIds(source, { user, minted, mutations })` wraps a
replica's source so that the ids the client minted for its unanswered writes,
and the ids derived from their mutation ids (`deriveId`, up to `MAX_DERIVED`
ordinals), count as unused. `MemoryStore` (`src/memory.ts`) is the smallest
source, with a `commit` that sets revs as a server store does.

## The registry (`src/registry.ts`)

`MUTATORS` holds every mutator by name. `NOT_MUTATORS` lists the mock's
procedures that change state but are not mutators, each with the reason:
API keys, usage and settings (account state), `research.cancelNode` and
`research.retryNode` (job state), `runs.*` (a device run's lease, which only
the server holds) and `devices.*` (device tokens). A server half serves them
as online-only calls; they never wait in an outbox.

## The mock backend and `DIFFERENCES`

The mock backend in `docs/mockups/session-web-spaces-mock-api.js` follows
these mutators. `test/mock.test.ts` runs a long history through both and
compares their stored state after every step. `DIFFERENCES` in that file
lists what the mock still does differently on purpose, each with its reason
and a test of both behaviours: the effects the mock writes in the
procedure's transaction (D2, D3: it has no effect worker) and its
deterministic invite codes (D12: it has no random source). Both sides name
replies and flat follow-ups by id since phase 1b.

## Tests

`npm test` runs ava over `test/*.test.ts`. `test/world.ts` is a server over a
`MemoryStore` for the tests; `test/decisions.test.ts` and
`test/part0.test.ts` hold a test for each decision of phases 1a.2 and 1b.
