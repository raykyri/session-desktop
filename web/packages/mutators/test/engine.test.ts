// The engine's properties over a history that calls every mutator:
// - coverage: every mutator applies at least once, and is refused at least
//   once;
// - determinism: under a guard that throws on `Date`, `Math.random`,
//   `crypto.getRandomValues` and `Intl`, and over frozen records, two runs on
//   the same state and input give identical outcomes and writes;
// - prediction: on a partial replica (a random part of the full state, the
//   rest UNKNOWN), a mutator predicts exactly what the server writes, or
//   answers `unknown`.

import test from "ava";

import {
  MUTATORS,
  UNKNOWN,
  apply,
  inIndex,
  splitKey,
  type IndexName,
  type Kind,
  type MemoryStore,
  type Outcome,
  type RecordSource,
  type StoredRecord,
} from "../src/index.js";

import { history } from "./scenario.js";
import { rng, type Step } from "./world.js";

const json = (v: unknown): unknown => JSON.parse(JSON.stringify(v));

/** Whether a step's write runs the server's pre-check. */
function needsPre(s: Step): boolean {
  const def = MUTATORS.get(s.envelope.name);
  const parsed = def?.input.safeParse(s.envelope.input);
  return parsed?.success === true && def?.needsPre(parsed.data) === true;
}

/** The server's outcome of a step, again, from the store before it. */
function server(s: Step, source: RecordSource = s.before): Outcome {
  return apply(MUTATORS, source, { u: s.u }, s.envelope, {
    now: s.now,
    server: { random: rng(7), ownsKey: (u, k) => u === "mel" && k === "KEY1" },
  });
}

test("every mutator applies at least once in the history, and is refused at least once", (t) => {
  const w = history(t);
  const applied = new Set<string>();
  const refusedNames = new Set<string>();
  for (const s of w.steps)
    (s.out.status === "ok" ? applied : refusedNames).add(s.envelope.name);
  t.deepEqual(
    MUTATORS.names.filter((n) => !applied.has(n)),
    [],
    "never applied",
  );
  // a few mutators have no way to refuse a signed-in person's valid input
  const always = new Set(["mutes.set", "blocks.set", "notifications.markAllRead"]);
  t.deepEqual(
    MUTATORS.names.filter((n) => !refusedNames.has(n) && !always.has(n)),
    [],
    "never refused",
  );
});

/** Freeze a value and everything in it. */
function deepFreeze<T>(v: T): T {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v)) deepFreeze(x);
  }
  return v;
}

/** Run `f` with the clock, the random sources and `Intl` replaced by ones
 * that throw. */
function guarded<T>(f: () => T): T {
  const realDate = globalThis.Date;
  const realRandom = Math.random;
  const realIntl = globalThis.Intl;
  const realLocale = String.prototype.localeCompare;
  const realToLocale = Number.prototype.toLocaleString;
  const crypto = globalThis.crypto as { getRandomValues: unknown } | undefined;
  const realGetRandom = crypto?.getRandomValues;
  const no = (what: string) => () => {
    throw new Error(`a mutator called ${what}`);
  };
  const FakeDate = new Proxy(realDate, {
    construct: no("new Date"),
    apply: no("Date()"),
    get: (target, p) =>
      p === "now" || p === "parse" || p === "UTC" ? no(`Date.${String(p)}`) : Reflect.get(target, p),
  });
  globalThis.Date = FakeDate;
  Math.random = no("Math.random");
  Object.defineProperty(globalThis, "Intl", {
    value: new Proxy({}, { get: no("Intl") }),
    configurable: true,
  });
  String.prototype.localeCompare = no("localeCompare") as unknown as typeof realLocale;
  Number.prototype.toLocaleString = no("toLocaleString") as unknown as typeof realToLocale;
  if (crypto) crypto.getRandomValues = no("crypto.getRandomValues");
  try {
    return f();
  } finally {
    globalThis.Date = realDate;
    Math.random = realRandom;
    Object.defineProperty(globalThis, "Intl", { value: realIntl, configurable: true });
    String.prototype.localeCompare = realLocale;
    Number.prototype.toLocaleString = realToLocale;
    if (crypto) crypto.getRandomValues = realGetRandom;
  }
}

test("every step gives the same outcome twice under a guard against clocks, random sources and Intl", (t) => {
  const w = history(t);
  t.true(w.steps.length > 150);
  let internal = 0;
  for (const s of w.steps) {
    for (const r of s.before.records.values()) deepFreeze(r);
    const a = guarded(() => server(s));
    const b = guarded(() => server(s));
    const what = `${s.u}: ${s.envelope.name} ${JSON.stringify(s.envelope.input)}`;
    t.deepEqual(a, b, what);
    // and the same as the run that recorded it, without the guard (whose
    // server-made values came from another random source)
    if (!needsPre(s)) t.deepEqual(json(a), json(s.out), what);
    else t.is(a.status, s.out.status, what);
    if (a.status === "refused" && a.error.code === "INTERNAL_SERVER_ERROR") internal++;
  }
  // a guard that fired would show up as INTERNAL_SERVER_ERROR
  t.is(internal, 0);
});

/** A part of a full store: each key, each index value and each id is known
 * or not, by a seeded choice. A key that is known answers as the full store
 * does (the record, or none); an index value that is known lists every
 * record the full store lists. Everything else is UNKNOWN. The writer's own
 * new ids are known to be unused, as a client knows the ids it minted. */
class PartialReplica implements RecordSource {
  private readonly keys = new Map<string, boolean>();
  private readonly indexes = new Map<string, boolean>();
  private readonly ids = new Map<string, boolean>();

  constructor(
    private readonly full: MemoryStore,
    private readonly random: () => number,
    private readonly p: number,
    private readonly minted: ReadonlySet<string>,
  ) {}

  private known(m: Map<string, boolean>, k: string): boolean {
    let v = m.get(k);
    if (v === undefined) m.set(k, (v = this.random() < this.p));
    return v;
  }

  get(kind: Kind, id: string): StoredRecord | undefined | typeof UNKNOWN {
    return this.known(this.keys, `${kind}:${id}`) ? this.full.get(kind, id) : UNKNOWN;
  }

  scan(index: IndexName, value: string): readonly StoredRecord[] | typeof UNKNOWN {
    if (!this.known(this.indexes, `${index}=${value}`)) return UNKNOWN;
    return [...this.full.records.values()].filter((r) => inIndex(r, index, value));
  }

  idUsed(id: string): boolean | typeof UNKNOWN {
    if (this.minted.has(id) && !this.full.idUsed(id)) return false;
    return this.known(this.ids, id) ? this.full.idUsed(id) : UNKNOWN;
  }
}

test("on random partial replicas, a prediction is the server's outcome or unknown", (t) => {
  const w = history(t);
  const random = rng(4242);
  let exact = 0;
  let unknown = 0;
  for (const s of w.steps) {
    const truth = server(s);
    for (const p of [0.3, 0.6, 0.9, 1]) {
      for (let k = 0; k < 4; k++) {
        const replica = new PartialReplica(s.before, random, p, s.minted);
        const guess = apply(MUTATORS, replica, { u: s.u }, s.envelope, { now: s.now });
        const what = `${s.u}: ${s.envelope.name} ${JSON.stringify(s.envelope.input)} (p ${p})`;
        if (guess.status === "unknown") {
          unknown++;
          continue;
        }
        exact++;
        t.deepEqual(guess, truth, what);
      }
    }
  }
  t.log(`${exact} exact predictions, ${unknown} unknown`);
  t.true(exact > 1000);
});

test("on a full replica, every write without a server pre-check is predicted exactly", (t) => {
  const w = history(t);
  for (const s of w.steps) {
    const replica = new PartialReplica(s.before, () => 0, 1, s.minted);
    const guess = apply(MUTATORS, replica, { u: s.u }, s.envelope, { now: s.now });
    const what = `${s.u}: ${s.envelope.name} ${JSON.stringify(s.envelope.input)}`;
    // a write the server's pre-check would see is unknown, unless `can`
    // refuses it first
    if (needsPre(s) && guess.status === "unknown") t.not(server(s).status, "unknown", what);
    else t.deepEqual(guess, server(s), what);
  }
});

test("a write's keys are well formed and its records are of the kind their key names", (t) => {
  const w = history(t);
  for (const s of w.steps) {
    if (s.out.status !== "ok") continue;
    for (const [key, r] of s.out.writes) {
      const k = splitKey(key);
      t.truthy(k, key);
      if (r) t.is(r.kind as string, k?.[0] ?? "", key);
      if (r) t.false("rev" in r, key);
    }
  }
});
