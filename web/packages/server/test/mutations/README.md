# Mutation runs of the server half

`mutate.ts` checks that the server's suite notices faults in the server half
(`05-delivery.md` M3, decision E4). Each mutation replaces one piece of code
in a copy of `@session/server`, `@session/sync`, `@session/db` or
`@session/mutators`, runs the type check of that package and the tests
expected to catch it (`EXPECTED`: the start of each title, run with AVA's
`--match` in the files that hold them, in the server's suite or in the
package `in` names), prints which test failed, and deletes the copy. The
packages are never changed. A mutation counts as killed only when one of its
expected tests fails; a failure of another test, or a type error, does not.
A mutation its expected tests do not kill (`SURVIVED`) is a gap in the
suite, and one whose expected tests did not run (`BROKEN`) is a gap in the
set.

Run it from the package directory, after `cd web && npx tsc -b` (the copies
use the declarations). It is not part of `npm test`.

```sh
npm run mutate                        # every mutation, 2 copies at once
npm run mutate -- X5 N2 'M3-*'        # these ids; a trailing * is a prefix
npm run mutate -- --sequences 200     # the convergence suite's full 200 sequences
npm run mutate -- --check             # only check that every pattern matches once and has its tests
npm run mutate -- --list              # the set, and the faults that do not apply
```

It first runs the suite on the unchanged copy (`--no-baseline` skips it),
uses AVA's `--fail-fast`, and runs 20 convergence sequences unless told
otherwise. It exits with 1 when a mutation survives.

- The X, N and R faults of `replica-proto/test/mutations/mutate.ts` that
  apply to server-half code, with the same patterns where the code is shared
  (`@session/sync`'s server half and wire, `@session/mutators`).
- Re-expressed where the server has its own code: X19, N15, N20 and N29 (the
  in-memory store's expiry and id registry) against `SqliteStore`; N9 and
  R2-22 (the in-memory target's test access) against the test routes the
  HTTP target reads; N34 (a constant token key) against the configuration,
  since the server always configures its cursor key and `Tokens` never makes
  one.
- M3-1 to M3-16: the code M3 adds (the protocol check, the transport
  limits, the drain, the event stream, the store's savepoints and log order,
  the restore check, the ledger, the run texts, `save_counts`,
  `secure_delete`, boot).
- M3-17 on: each undoes one fix of the M3 and M4 reviews (body limits, the
  stream hub, event ids, the history id, the store, the configuration,
  `/read`'s scope, limits and budget, the directory), so the fix's test is
  shown to fail without it.
- Not applicable (`--list` prints the reasons): the client half's faults
  (X28, X31, N26-N28, R2-6, R2-8, R2-10 to R2-14, R2-23) and the prototype's
  join requests (X16, X22, N23, R2-2); X25 (a tombstone keeping the whole
  record) is an equivalent mutant on SQLite, whose tombstone row holds the
  key, kind and audience columns only.
