// `01` U1, U3: the mutators read no clock, no random source and no Intl
// (the prototype's `inv1` test, run over every mutator of the package), and
// every record they write has the stored shape, with no per-viewer field.

import { spaces } from "@session/shared";
import test from "ava";

import { MUTATORS } from "../src/index.js";

import { everyMutator } from "./scenario.js";
import { World } from "./world.js";

/** Run `f` with the clock, the random source, Intl, crypto and performance
 * trapped; `outside` (given to `f`) runs code with the real globals, as the
 * run loop writes outside the mutators. */
function trapped(f: (outside: (g: () => void) => void) => void): void {
  const trap = (what: string) => () => {
    throw new Error(`a mutator read ${what}`);
  };
  const saved = {
    Date: globalThis.Date,
    random: Math.random,
    Intl: Object.getOwnPropertyDescriptor(globalThis, "Intl"),
    crypto: Object.getOwnPropertyDescriptor(globalThis, "crypto"),
    performance: Object.getOwnPropertyDescriptor(globalThis, "performance"),
  };
  // every use of `Date` is trapped, not only the clock: the package formats
  // and parses times without it (`src/time.ts`)
  const Trapped = new Proxy(saved.Date, {
    construct: trap("Date"),
    apply: trap("Date"),
    get: trap("Date"),
  });
  const getter = (what: string) => ({ get: trap(what), configurable: true });
  const install = () => {
    globalThis.Date = Trapped;
    Math.random = trap("Math.random");
    Object.defineProperty(globalThis, "Intl", getter("Intl"));
    Object.defineProperty(globalThis, "crypto", getter("crypto"));
    Object.defineProperty(globalThis, "performance", getter("performance"));
  };
  const restore = () => {
    globalThis.Date = saved.Date;
    Math.random = saved.random;
    for (const k of ["Intl", "crypto", "performance"] as const) {
      const d = saved[k];
      if (d) Object.defineProperty(globalThis, k, d);
    }
  };
  const outside = (g: () => void) => {
    restore();
    try {
      g();
    } finally {
      install();
    }
  };
  try {
    install();
    f(outside);
  } finally {
    restore();
  }
}

test("mutators read no clock, no random source and no Intl while they apply", (t) => {
  const w = new World();
  let applied: string[] = [];
  trapped((outside) => {
    applied = everyMutator(t, w, outside);
  });
  t.deepEqual([...new Set(applied)].sort(), Object.keys(MUTATORS).sort());
});

test("nor while a client predicts them (M1b review 4)", (t) => {
  const w = new World();
  let predicted = 0;
  trapped((outside) => {
    everyMutator(t, w, outside, (u, name, input) => {
      // the prediction runs trapped; the world's apply makes ids from its
      // own counter and reads no global either
      const { prediction } = w.predict(u, name, input);
      if (!("unknown" in prediction)) predicted++;
      return w.apply(u, name, input);
    });
  });
  t.true(predicted > 30);
});

test("every record a mutator writes has the stored shape and no per-viewer field", (t) => {
  const w = new World();
  everyMutator(t, w);
  const kinds = new Set<string>();
  for (const r of w.store.written) {
    const k = `${r.kind} ${JSON.stringify(r).slice(0, 80)}`;
    kinds.add(r.kind);
    const p = spaces.storedRecordSchema.safeParse(r);
    t.true(p.success, `${k}: ${JSON.stringify(p.error?.issues[0])}`);
    for (const f of ["mine", "saved", "liked", "likes"]) t.false(f in r, `${k} has ${f}`);
  }
  t.deepEqual([...kinds].sort(), [
    "answer",
    "ban",
    "comment",
    "counts",
    "invite",
    "member",
    "modlog",
    "node",
    "notif",
    "prefs",
    "reply",
    "run",
    "save",
    "space",
    "stats",
    "thread",
  ]);
});

test("the same write applied to the same state writes the same records", (t) => {
  const a = new World(7);
  const b = new World(7);
  everyMutator(t, a);
  everyMutator(t, b);
  t.deepEqual([...a.store.records], [...b.store.records]);
});
