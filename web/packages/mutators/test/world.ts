// A minimal server half for the package's tests: an in-memory records table
// with the indexes the mutators read through, and `apply`, which runs a
// mutator's stages in the server's order (input, `space`, ban, frozen, `who`,
// `can`, `pre`, `run`, `notify`) on a `StagedTx` and commits its writes only
// when every stage passed. The prototype server (`@session/replica-proto`)
// is the full acceptance suite; this one tests the mutators alone.

import type { ExecutionContext } from "ava";

import {
  MUTATORS,
  Refusal,
  StagedTx,
  UnknownRead,
  authorize,
  inIndex,
  isoToMs,
  msToIso,
  predict,
  registryKey,
  uniqueOf,
  type AnyMutator,
  type ApiError,
  type Draft,
  type ErrorCode,
  type Index,
  type Kind,
  type PreCtx,
  type Prediction,
  type Source,
  type StoredRecord,
  type UniqueIndex,
} from "../src/index.js";

export const MINUTE = 60_000;
export const DAY = 86_400_000;
/** The model and effort every ask names: a registry entry and an effort it
 * accepts. */
export const MODEL = { model: "claude-fable", effort: "medium" } as const;

const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** mulberry32: a seeded random source. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Answer = { ok: true; result: unknown } | { ok: false; error: ApiError };

/** A store of committed records, read as `Source`. */
class Store implements Source {
  readonly records = new Map<string, StoredRecord>();
  readonly registry = new Map<string, number>();
  /** Every record ever committed, as it was written. */
  readonly written: StoredRecord[] = [];

  byKey(key: string) {
    return this.records.get(key);
  }
  keysIn(kind: Kind, index: Index): string[] {
    return [...this.records]
      .filter(([, r]) => r.kind === kind && inIndex(r, index))
      .map(([k]) => k);
  }
  uniqueKey(index: UniqueIndex, value: string): string | undefined {
    for (const [k, r] of this.records) if (uniqueOf(r, index) === value) return k;
    return undefined;
  }
  idTaken(id: string): boolean {
    return this.registry.has(id);
  }
  commit(staged: ReadonlyMap<string, StoredRecord | null>) {
    for (const [key, next] of staged) {
      if (next === null) {
        this.records.delete(key);
        continue;
      }
      const reg = registryKey(next);
      const rev = (this.records.get(key)?.rev ?? this.registry.get(reg) ?? 0) + 1;
      this.records.set(key, { ...next, rev });
      this.registry.set(reg, rev);
      this.written.push({ ...next, rev });
    }
  }
}

export interface ApplyOptions {
  /** The mutator set (default: the package's). */
  defs?: Readonly<Record<string, AnyMutator>>;
  mutationId?: string;
}

export class World {
  readonly store = new Store();
  ms = isoToMs("2026-11-16T10:00:00Z");
  private n = 0;
  readonly random: () => number;

  constructor(seed = 1) {
    this.random = rng(seed);
  }

  /** A new ULID at the world's time: the time and a counter. */
  id(): string {
    let t = "";
    for (let i = 0, x = this.ms; i < 10; i++, x = Math.floor(x / 32)) t = B32.charAt(x % 32) + t;
    let r = "";
    for (let i = 0, x = ++this.n; i < 16; i++, x = Math.floor(x / 32)) r = B32.charAt(x % 32) + r;
    return t + r;
  }

  advance(ms: number) {
    this.ms += ms;
  }

  get(key: string): StoredRecord | undefined {
    return this.store.records.get(key);
  }

  rev(key: string): number {
    return this.get(key)?.rev ?? 0;
  }

  /** Write a record as it is, outside any mutator (what an operator job or
   * the run loop writes). */
  put(r: Draft) {
    const tx = new StagedTx(this.store, "", "", "");
    tx.put(r);
    this.store.commit(tx.staged);
  }

  /** Records of a kind, in key order. */
  all<K extends Kind>(kind: K): Extract<StoredRecord, { kind: K }>[] {
    return [...this.store.records.values()].filter(
      (r): r is Extract<StoredRecord, { kind: K }> => r.kind === kind,
    );
  }

  /** The server's apply, without the protocol: the stages in order, and a
   * commit of everything they wrote, or nothing. */
  apply(me: string, name: string, input: unknown, o: ApplyOptions = {}): Answer {
    const def = (o.defs ?? MUTATORS)[name];
    if (!def) return { ok: false, error: { code: "NOT_FOUND", message: name } };
    const parsed = def.input.safeParse(input);
    if (!parsed.success)
      return {
        ok: false,
        error: new Refusal(
          "BAD_REQUEST",
          undefined,
          parsed.error.issues.map((x) => `input.${x.path.join(".")}: ${x.code}`),
        ).toError(),
      };
    const tx = new StagedTx(this.store, me, msToIso(this.ms), o.mutationId ?? this.id());
    const ctx: PreCtx = {
      me,
      now: this.ms,
      random: this.random,
      inviteCodeTaken: (code) => this.store.uniqueKey("invite.code", code) !== undefined,
      queuedRuns: () => this.all("run").filter((r) => r.u === me && r.status === "queued").length,
    };
    try {
      authorize(tx, def, parsed.data);
      const values = def.pre?.(ctx, parsed.data) ?? {};
      const result = def.run(tx, parsed.data, values);
      def.notify?.(tx, parsed.data, result);
      this.store.commit(tx.staged);
      return { ok: true, result };
    } catch (e) {
      if (e instanceof Refusal) return { ok: false, error: e.toError() };
      return { ok: false, error: { code: "INTERNAL_SERVER_ERROR", message: String(e) } };
    }
  }

  /** A client's prediction over a replica that holds the records `holds`
   * keeps; a read of any other key or index is unknown. */
  predict(
    me: string,
    name: string,
    input: unknown,
    holds: (key: string) => boolean = () => true,
  ): { prediction: Prediction; tx: StagedTx } {
    const store = this.store;
    const replica: Source = {
      byKey: (key) => {
        if (!holds(key)) throw new UnknownRead(key);
        return store.byKey(key);
      },
      keysIn: (kind, index) => {
        const keys = store.keysIn(kind, index);
        for (const k of keys)
          if (!holds(k)) throw new UnknownRead(`${kind} ${JSON.stringify(index)}`);
        return keys;
      },
      uniqueKey: (index, value) => {
        const k = store.uniqueKey(index, value);
        if (k === undefined || !holds(k)) throw new UnknownRead(`${index} ${value}`);
        return k;
      },
      idTaken: () => false,
    };
    const tx = new StagedTx(replica, me, msToIso(this.ms), this.id());
    return { prediction: predict(tx, MUTATORS[name] as AnyMutator, input), tx };
  }

  notifs(u: string) {
    return this.all("notif").filter((n) => n.to === u);
  }
}

export function ok(t: ExecutionContext, a: Answer): unknown {
  if (!a.ok) t.fail(`expected ok, got ${JSON.stringify(a.error)}`);
  return a.ok ? a.result : undefined;
}

export function refused(t: ExecutionContext, a: Answer, code: ErrorCode): ApiError | undefined {
  if (a.ok) {
    t.fail(`expected ${code}, got ok`);
    return undefined;
  }
  t.is(a.error.code, code, JSON.stringify(a.error));
  return a.error;
}

/** A cast most tests start from: olga owns the open #lounge (members mona,
 * mel, otto) and the private #lab (member ada, joined with an invite link);
 * eve is a stranger. */
export function cast(t: ExecutionContext, seed = 1) {
  const w = new World(seed);
  const open = w.id();
  const closed = w.id();
  ok(t, w.apply("olga", "spaces.create", { id: open, name: "lounge" }));
  ok(t, w.apply("olga", "spaces.create", { id: closed, name: "lab", vis: "private" }));
  for (const u of ["mona", "mel", "otto"]) ok(t, w.apply(u, "spaces.join", { space: open }));
  admit(t, w, closed, "ada");
  return { w, open, closed };
}

/** Let `u` into a private space with a link its owner olga makes. */
export function admit(t: ExecutionContext, w: World, space: string, u: string) {
  const r = ok(t, w.apply("olga", "invites.create", { id: w.id(), space, days: 7 })) as {
    code: string;
  };
  ok(t, w.apply(u, "spaces.join", { space, invite: r.code }));
}

/** A new ask by `u`, its root run answered at once (`answered: false`
 * leaves it queued). */
export function ask(t: ExecutionContext, w: World, u: string, space: string, answered = true) {
  const id = w.id();
  ok(t, w.apply(u, "threads.create", { id, space, kind: "ask", q: "Why?", ...MODEL }));
  if (answered) finish(w, id, "r");
  return id;
}

export function post(t: ExecutionContext, w: World, u: string, space: string, q = "A post") {
  const id = w.id();
  ok(t, w.apply(u, "threads.create", { id, space, kind: "post", q }));
  return id;
}

/** An ask node by `u` under `parent`, answered at once unless `answered` is
 * false. */
export function fork(
  t: ExecutionContext,
  w: World,
  u: string,
  thread: string,
  parent = "r",
  answered = true,
) {
  const id = w.id();
  ok(t, w.apply(u, "research.forkNode", { id, thread, parent, kind: "ask", q: "And?", ...MODEL }));
  if (answered) finish(w, thread, id);
  return id;
}

/** What the run loop writes when a run ends `complete`: the run record, the
 * root's `running`, and the answer. */
export function finish(w: World, thread: string, node: string, md = "An answer.") {
  const run = w.all("run").find((r) => r.th === thread && r.node === node);
  if (!run) throw new Error(`no run of ${node} in ${thread}`);
  w.put({ ...run, status: "complete", step: 3, finishedAt: msToIso(w.ms) });
  const asker = run.u;
  w.put({
    kind: "answer",
    node,
    th: thread,
    s: run.s,
    u: asker,
    md,
    pages: [["A page", "example.com", ""]],
    tok: 1200,
    run: run.id,
    attempt: run.attempt,
    mod: null,
  });
  const th = w.get(`thread:${thread}`);
  if (node === "r" && th?.kind === "thread") w.put({ ...th, running: false });
}
