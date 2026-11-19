// Mutation runs for the suite: each mutation changes one place in `src/`, then
// the type check and the whole suite run, and the run lists the tests that
// failed. A mutation no test kills is a gap in the suite. The file is restored
// from a copy taken before the change, whatever happens.
//
// Run from the package directory: `npm run mutate [-- <name prefix> ...]`.
// X1 to X20 are review round 1's mutations (X15 and X17 were not in its set),
// moved to the code as it is now; X21 on cover the fixes of round 1.

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

interface Mutation {
  name: string;
  file: string;
  from: string;
  to: string;
  /** Further places in the same file, for a fault that two checks guard. */
  also?: { from: string; to: string }[];
}

const edits = (m: Mutation) => [{ from: m.from, to: m.to }, ...(m.also ?? [])];

const MUTATIONS: Mutation[] = [
  {
    name: "X1 a ban keeps the membership",
    file: "src/mutators.ts",
    from: "      if (tx.get(memberKey(i.space, i.user))) tx.del(memberKey(i.space, i.user));\n      if (!tx.get(banKey",
    to: "      if (!tx.get(banKey",
  },
  {
    name: "X2 opening a space admits banned requesters",
    file: "src/mutators.ts",
    from: 'if (!bannedFrom(tx, s0.id, r.u)) addMember(tx, s0.id, r.u, "member");',
    to: 'addMember(tx, s0.id, r.u, "member");',
  },
  {
    name: "X3 an author's delete keeps the text",
    file: "src/mutators.ts",
    from: '        q: "",\n        t: null,\n        edited: false,',
    to: "        edited: false,",
  },
  {
    name: "X4 a hidden thread keeps its title and summary",
    file: "src/access.ts",
    from: 'return { ...r, q: "", t: null, sum: null } satisfies ThreadRec;',
    to: 'return { ...r, q: "" } satisfies ThreadRec;',
  },
  {
    name: "X5 lastSeq of anyone's client",
    file: "src/server.ts",
    from: "return c && c.u === u ? c.last : null;",
    to: "return c ? c.last : null;",
  },
  {
    name: "X6 the invite code is taken from the client's id",
    file: "src/mutators.ts",
    from: "    pre: (ctx) => {\n      const B32",
    to: "    pre: (ctx, i) => {\n      if (i.id) return { code: i.id.slice(-10).toLowerCase() };\n      const B32",
  },
  {
    name: "X7 an invite link is not used up",
    file: "src/mutators.ts",
    from: 'if (link) tx.put({ ...link, dead: "Used", usedBy: tx.me });',
    to: "",
  },
  {
    name: "X8 a snapshot sorted by key only",
    file: "src/server.ts",
    from: "      return x < y ? -1 : x > y ? 1 : born(a.key) - born(b.key);",
    to: "      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;",
  },
  {
    name: "X9 an ownership transfer keeps the old owner",
    file: "src/mutators.ts",
    from: 'if (me?.kind === "member") tx.put({ ...me, role: "admin" });',
    to: "",
  },
  {
    name: "X10 a del sent for tombstones the reader may not read",
    file: "src/server.ts",
    from: "return t && readsAudience(this.store, t, u) ? true : null;",
    to: "return t ? true : null;",
  },
  {
    name: "X11 report notifications go to every member",
    file: "src/server.ts",
    from: '    const staff = spaceRec(this.store, effect.sp)?.mods ?? [];\n    for (const [to, role] of staff) {\n      if (role === "member") continue;',
    to: '    const staff = [...this.store.records.values()].flatMap((r) =>\n      r.kind === "member" && r.sp === effect.sp ? [[r.u, "x"] as const] : [],\n    );\n    for (const [to, role] of staff) {\n      if (role === "member") continue;',
  },
  {
    name: "X12 idempotency kept 5 days",
    file: "src/server.ts",
    from: "export const DEDUP_TTL = 7 * DAY;",
    to: "export const DEDUP_TTL = 5 * DAY;",
  },
  {
    name: "X13 a like counts twice",
    file: "src/mutators.ts",
    from: "likes: Math.max(0, p.likes + (i.on ? 1 : -1))",
    to: "likes: Math.max(0, p.likes + (i.on ? 2 : -1))",
  },
  {
    name: "X14 a removal keeps the title and summary",
    file: "src/mutators.ts",
    from: '        q: "",\n        t: null,\n        sum: null,\n        r: 0,',
    to: '        q: "",\n        r: 0,',
  },
  {
    name: "X16 an approval ignores the ban",
    file: "src/mutators.ts",
    from: '          if (bannedFrom(tx, i.space, u))\n            throw refuse("PRECONDITION_FAILED", "This person is banned from the space.");\n',
    to: "",
  },
  {
    name: "X18 a hidden follow-up keeps its answer",
    file: "src/access.ts",
    from: 'return { ...r, q: "", a: null } satisfies FollowUpRec;',
    to: 'return { ...r, q: "" } satisfies FollowUpRec;',
  },
  {
    name: "X19 follow-up tombstones are never pruned",
    file: "src/server.ts",
    from: "      if (t.at >= cutoff) continue;\n      this.tombs.delete(key);",
    to: '      if (t.at >= cutoff) continue;\n      if (t.kind !== "followup") this.tombs.delete(key);',
  },
  {
    name: "X20 threads.delete gets kept wrong",
    file: "src/mutators.ts",
    from: "      const kept = p.r > 0;\n",
    to: "      const kept = p.r > 1;\n",
  },
  {
    name: "X21 a snapshot returns the server's head",
    file: "src/server.ts",
    from: "    return { records, version, epoch: this.serve(log, u, version, now), lastSeq };",
    to: "    const head = this.store.head;\n    return { records, version: head, epoch: this.serve(log, u, head, now), lastSeq };",
  },
  {
    name: "X22 a join decision ignores the request's rev",
    file: "src/mutators.ts",
    from: "        if (r.rev !== i.base[u]) throw stale();\n",
    to: "",
  },
  {
    name: "X23 a moderation decision ignores the item's rev",
    file: "src/mutators.ts",
    from: '      if (r.rev !== i.base.rev) throw stale();\n      if (r.mod === "removed") throw removed();',
    to: '      if (r.mod === "removed") throw removed();',
  },
  {
    name: "X24 a removal ignores the member's rev",
    file: "src/mutators.ts",
    from: "      if (revOf(tx, memberKey(i.space, i.user)) !== i.base.rev) throw stale();\n      if (!tx.get(memberKey(i.space, i.user))) return null;",
    to: "      if (!tx.get(memberKey(i.space, i.user))) return null;",
  },
  {
    name: "X25 a tombstone keeps the whole record",
    file: "src/server.ts",
    from: "const tomb: Tombstone = { key, ...audience(this, old), rev: old.rev, at };",
    to: "const tomb = { ...old, key, ...audience(this, old), rev: old.rev, at } as Tombstone;",
  },
  {
    name: "X26 likes, saves and notifications ignore access to their space",
    file: "src/access.ts",
    from: "return own && (sp === null || readsSpace(g, sp, u));",
    to: "return own;",
  },
  {
    name: "X27 INTERNAL_SERVER_ERROR is recorded",
    file: "src/contract.ts",
    from: '  "INTERNAL_SERVER_ERROR",\n]);',
    to: "]);",
  },
  {
    name: "X28 the client does not follow OUT_OF_ORDER's expected seq",
    file: "src/client.ts",
    from: 'res.error.code === "OUT_OF_ORDER" && res.error.expectedSeq !== undefined',
    to: 'res.error.code === "OUT_OF_ORDER" && res.error.expectedSeq === -1',
  },
  {
    name: "X31 the client drops a write after a transient answer",
    file: "src/client.ts",
    from: "      if (!res.ok && UNRECORDED.has(res.error.code)) break;",
    to: '      if (!res.ok && UNRECORDED.has(res.error.code) && res.error.code === "WRONG_CLIENT") break;',
  },
  {
    name: "X29 an online-only write with an old mutation id is a recorded refusal",
    file: "src/server.ts",
    from: '        return skew("mutationId: expected a ULID from the past minute (online only)");',
    to: '        return final(refuse("PRECONDITION_FAILED", "This change can be made only while online."));',
  },
  {
    // the pull checks the cursor's age, and housekeeping drops served
    // cursors at the same age: either alone holds, so both go
    name: "X30 a cursor's age is not checked",
    file: "src/server.ts",
    from: "        s.at < now - TOMBSTONE_TTL\n",
    to: "        false\n",
    also: [
      {
        from: "    for (const [k, s] of this.served) if (s.at < now - TOMBSTONE_TTL) this.served.delete(k);\n",
        to: "",
      },
    ],
  },
];

interface Outcome {
  typecheck: string;
  passed: number;
  failed: number;
  tests: string[];
}

function run(m: Mutation, backup: string): Outcome {
  let source = readFileSync(m.file, "utf8");
  copyFileSync(m.file, backup);
  try {
    for (const e of edits(m)) {
      if (!source.includes(e.from)) throw new Error(`${m.name}: pattern not found in ${m.file}`);
      source = source.replace(e.from, e.to);
    }
    writeFileSync(m.file, source);
    const tc = spawnSync("npx", ["tsc", "-p", "tsconfig.test.json", "--noEmit"], {
      encoding: "utf8",
    });
    const ava = spawnSync("npx", ["ava", "--timeout=300s"], { encoding: "utf8" });
    const out = `${ava.stdout}${ava.stderr}`;
    const tests = [
      ...new Set([...out.matchAll(/[✘×] \[fail\]: (.+?)(?:\s{2,}|$)/gm)].map((x) => x[1] ?? "")),
    ];
    return {
      typecheck: tc.status === 0 ? "ok" : (tc.stdout.split("\n")[0] ?? "failed"),
      passed: Number(/(\d+) tests? passed/.exec(out)?.[1] ?? 0),
      failed: Number(/(\d+) tests? failed/.exec(out)?.[1] ?? 0),
      tests: tests.map((x) => x.slice(0, 140)),
    };
  } finally {
    copyFileSync(backup, m.file);
  }
}

const args = process.argv.slice(2);
// --check: only that every pattern is found, once
if (args.includes("--check")) {
  for (const m of MUTATIONS)
    for (const e of edits(m)) {
      const n = readFileSync(m.file, "utf8").split(e.from).length - 1;
      if (n !== 1) throw new Error(`${m.name}: ${n} matches in ${m.file}`);
    }
  console.log(`${MUTATIONS.length} patterns found`);
  process.exit(0);
}
const only = args;
const dir = mkdtempSync(join(tmpdir(), "replica-proto-mutate-"));
let survived = 0;
for (const m of MUTATIONS) {
  if (only.length && !only.some((o) => m.name.startsWith(o))) continue;
  const o = run(m, join(dir, basename(m.file)));
  if (o.failed === 0) survived++;
  console.log(`${o.failed ? "killed  " : "SURVIVED"} ${m.name}: ${JSON.stringify(o)}`);
}
console.log(survived ? `${survived} mutations survived` : "every mutation was killed");
process.exitCode = survived ? 1 : 0;
