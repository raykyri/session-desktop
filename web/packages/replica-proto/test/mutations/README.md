# Mutation runs

`mutate.ts` checks that the suite notices faults. Each mutation replaces one
piece of code in `src/` of a copy of the package with a faulty version, runs
the type check and the whole suite in that copy, prints which tests failed,
and deletes the copy. The package itself is never changed. A mutation that no
test kills (`SURVIVED`) is a gap in the suite.

Run it from the package directory. It is not part of `npm test`. It runs 4
copies at once; a full run takes about 45 minutes on 4 cores:

```sh
npm run mutate                    # every mutation
npm run mutate -- X1 N2 R2-5      # the mutations whose names start with these
npm run mutate -- --slots 2       # 2 copies at once
npm run mutate -- --check         # only check that every pattern matches once
```

It exits with 1 when a mutation survives.

- X1 to X31 are review round 1's mutations (its set had no X15 and no X17)
  and the ones that covered round 1's fixes.
- N2 to N34 are review round 2's mutations (N18, N19 and N32 were not in its
  set). N1, a pull that moves its version past rows the reader may not read,
  is left out: with the version sealed in the token it changes nothing a
  reader gets (`mutate.ts` says why).
- R2-1 on cover round 2's fixes: restricting decisions, admission ids, the
  counts record, report notifications for staff only, write age and clock
  offsets, bounded tables, client backoff and failure, the effect worker,
  input bounds and the storage scan.
- U6-1 on cover the build's contract (`01` U6), M1a-10 on the M1a review's
  fixes, and M1b-1 on the checks `@session/mutators` added (M1b).

The mutators, the stored shape and the read rules live in
`@session/mutators` since M1b: their patterns name `../mutators/src/<file>`.
Each copy holds a copy of that package too, which the copy of this one
imports; a mutation there is type-checked in that package and runs its suite
as well as this one. Build the declarations first (`cd web && npx tsc -b`):
the copies use them.

A pattern that no longer matches stops the run with an error: when the code
changes, move the pattern with it and keep the fault the same. Where the code
a fault was in is gone, the mutation names the same fault in the code that
replaced it, and says so in a comment (X21, X29, N5, N20, N25, N31).
