# Mutation runs

`mutate.ts` checks that the suite notices faults. Each mutation replaces one
piece of code in `src/` with a faulty version, runs the type check and the
whole suite, prints which tests failed, and restores the file. A mutation
that no test kills (`SURVIVED`) is a gap in the suite.

Run it from the package directory. It is not part of `npm test`, and a full
run takes about 20 minutes, one suite run per mutation:

```sh
npm run mutate                 # every mutation
npm run mutate -- X1 X16       # the mutations whose names start with X1 or X16
```

It exits with 1 when a mutation survives.

- X1 to X20 are review round 1's mutations (its set had no X15 and no X17),
  with their patterns moved to the code as it is now.
- X21 on cover the fixes of round 1: versions per reader, version checks on
  stale intent, tombstones, user logs, transient answers, the client's seqs,
  online-only clock skew and the cursor's age.

A pattern that no longer matches stops the run with an error: when the code
changes, move the pattern with it and keep the fault the same.
