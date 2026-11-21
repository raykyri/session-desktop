# Mutation runs of the server half

`mutate.ts` checks that the server's suite notices faults in the server half
(`05-delivery.md` M3, decision E4). Each mutation replaces one piece of code
in a copy of `@session/server`, `@session/sync`, `@session/db` or
`@session/mutators`, runs the type check of that package and the server's
whole suite in the copy (the acceptance suite over HTTP, `test/conformance/`,
included), prints which test failed, and deletes the copy. A mutation in
another package that the server's suite does not kill also runs that
package's own suite. The packages are never changed. A mutation that no test
kills (`SURVIVED`) is a gap in the suite.

Run it from the package directory, after `cd web && npx tsc -b` (the copies
use the declarations). It is not part of `npm test`.

```sh
npm run mutate                        # every mutation, 2 copies at once
npm run mutate -- X5 N2 'M3-*'        # these ids; a trailing * is a prefix
npm run mutate -- --sequences 200     # the convergence suite's full 200 sequences
npm run mutate -- --check             # only check that every pattern matches once
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
  HTTP target reads.
- M3-1 on: the code M3 adds (the protocol check, the transport limits, the
  drain, the event stream, the store's savepoints and log order, the restore
  check, the ledger, the run texts, `save_counts`, `secure_delete`, boot).
- Not applicable (`--list` prints the reasons): the client half's faults
  (X28, X31, N26-N28, R2-6, R2-8, R2-10 to R2-14, R2-23) and the prototype's
  join requests (X16, X22, N23, R2-2); X25 (a tombstone keeping the whole
  record) is an equivalent mutant on SQLite, whose tombstone row holds the
  key, kind and audience columns only.
