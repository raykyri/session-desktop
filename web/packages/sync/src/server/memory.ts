// `ServerStore` over memory: maps, with an undo journal so that a
// transaction that throws leaves nothing behind. The tests run the server
// half over it and over SQLite; every read of a transaction sees its own
// writes, as SQLite's do.

import { INDEXES, type Effect, type LogId, type StoredRecord } from "@session/mutators";

import type {
  ClientRec,
  DeadLetter,
  DeviceToken,
  Epoch,
  Lease,
  LogRow,
  QueuedEffect,
  ServerStore,
  Signin,
  StoreDump,
  StoreTx,
  StoredAnswer,
  Tombstone,
} from "./store.js";

const copy = <T>(v: T): T => structuredClone(v);

/** The fields an index scan can match, by kind: from `INDEXES`. */
const INDEXED = new Map<string, string[]>();
for (const [kind, field] of Object.values(INDEXES)) {
  const l = INDEXED.get(kind) ?? [];
  if (!l.includes(field)) l.push(field);
  INDEXED.set(kind, l);
}

class Tables {
  meta = { head: 0, lastTime: 0, effectId: 0, letterId: 0 };
  records = new Map<string, { record: StoredRecord; born: number }>();
  /** kind \0 field \0 value → keys */
  index = new Map<string, Set<string>>();
  registry = new Map<string, number>();
  logs = new Map<LogId, Map<string, LogRow>>();
  epochs = new Map<LogId, Epoch>();
  tombs = new Map<string, Tombstone>();
  answers = new Map<string, StoredAnswer & { u: string; mutationId: string }>();
  seqAnswers = new Map<string, StoredAnswer & { clientId: string; seq: number }>();
  clients = new Map<string, ClientRec>();
  registrations: { u: string; at: number }[] = [];
  effects = new Map<number, QueuedEffect>();
  letters = new Map<number, DeadLetter>();
  tokens = new Map<string, DeviceToken>();
  signins = new Map<string, Signin>();
  leases = new Map<string, Lease>();
}

/** Set `key` of `m` to `v` (undefined: delete), journaling the old value. */
function setIn<K, V>(undo: (() => void)[], m: Map<K, V>, key: K, v: V | undefined) {
  const had = m.has(key);
  const old = m.get(key);
  undo.push(() => {
    if (had) m.set(key, old as V);
    else m.delete(key);
  });
  if (v === undefined) m.delete(key);
  else m.set(key, v);
}

class MemoryTx implements StoreTx {
  constructor(
    private readonly t: Tables,
    private readonly undo: (() => void)[],
  ) {}

  private meta<K extends keyof Tables["meta"]>(k: K, v: number) {
    const old = this.t.meta[k];
    this.undo.push(() => {
      this.t.meta[k] = old;
    });
    this.t.meta[k] = v;
  }

  head = () => this.t.meta.head;
  setHead = (v: number) => this.meta("head", v);
  lastTime = () => this.t.meta.lastTime;
  setLastTime = (v: number) => this.meta("lastTime", v);

  get(key: string) {
    const r = this.t.records.get(key);
    return r ? copy(r.record) : undefined;
  }

  scan(kind: string, field: string, value: string): StoredRecord[] {
    const keys = this.t.index.get(`${kind}\0${field}\0${value}`);
    return keys ? [...keys].sort().map((k) => copy(this.t.records.get(k)?.record as StoredRecord)) : [];
  }

  private indexKeys(r: StoredRecord): string[] {
    const fields = INDEXED.get(r.kind) ?? [];
    const out: string[] = [];
    for (const f of fields) {
      const v = (r as unknown as Record<string, unknown>)[f];
      if (typeof v === "string") out.push(`${r.kind}\0${f}\0${v}`);
    }
    return out;
  }

  private unindex(key: string) {
    const old = this.t.records.get(key);
    if (!old) return;
    for (const ik of this.indexKeys(old.record)) {
      const set = this.t.index.get(ik);
      if (!set) continue;
      set.delete(key);
      this.undo.push(() => set.add(key));
    }
  }

  put(key: string, record: StoredRecord, born: number) {
    this.unindex(key);
    setIn(this.undo, this.t.records, key, { record: copy(record), born });
    for (const ik of this.indexKeys(record)) {
      let set = this.t.index.get(ik);
      if (!set) this.t.index.set(ik, (set = new Set()));
      if (!set.has(key)) {
        set.add(key);
        const s = set;
        this.undo.push(() => s.delete(key));
      }
    }
  }

  del(key: string) {
    this.unindex(key);
    setIn(this.undo, this.t.records, key, undefined);
  }

  born = (key: string) => this.t.records.get(key)?.born;
  registryGet = (id: string) => this.t.registry.get(id);
  registrySet = (id: string, rev: number) => setIn(this.undo, this.t.registry, id, rev);

  private rows(log: LogId) {
    let m = this.t.logs.get(log);
    if (!m) {
      this.t.logs.set(log, (m = new Map()));
      this.undo.push(() => {
        if (m?.size === 0) this.t.logs.delete(log);
      });
    }
    return m;
  }

  logPut(log: LogId, row: LogRow) {
    // a written row moves to the end: rows of one version keep write order
    const m = this.rows(log);
    setIn(this.undo, m, row.key, undefined);
    setIn(this.undo, m, row.key, { ...row });
  }
  logDelete(log: LogId, key: string) {
    const m = this.t.logs.get(log);
    if (m) setIn(this.undo, m, key, undefined);
  }
  logGet(log: LogId, key: string) {
    const r = this.t.logs.get(log)?.get(key);
    return r ? { ...r } : undefined;
  }
  logAfter(log: LogId, after: number): LogRow[] {
    const m = this.t.logs.get(log);
    if (!m) return [];
    return [...m.values()]
      .filter((r) => r.version > after)
      .sort((a, b) => a.version - b.version)
      .map((r) => ({ ...r }));
  }
  epoch = (log: LogId) => ({ ...(this.t.epochs.get(log) ?? { n: 0, start: 0 }) });
  setEpoch = (log: LogId, e: Epoch) => setIn(this.undo, this.t.epochs, log, { ...e });

  tombGet = (key: string) => copy(this.t.tombs.get(key));
  tombPut = (t: Tombstone) => setIn(this.undo, this.t.tombs, t.key, copy(t));
  tombDelete = (key: string) => setIn(this.undo, this.t.tombs, key, undefined);
  tombsBefore(at: number, limit: number) {
    return [...this.t.tombs.values()]
      .filter((t) => t.at < at)
      .sort((a, b) => a.at - b.at)
      .slice(0, limit)
      .map(copy);
  }

  answerGet(u: string, mutationId: string) {
    const a = this.t.answers.get(`${u}\0${mutationId}`);
    return a ? copy({ digest: a.digest, answer: a.answer, at: a.at }) : undefined;
  }
  answerPut(u: string, mutationId: string, a: StoredAnswer) {
    setIn(this.undo, this.t.answers, `${u}\0${mutationId}`, { ...copy(a), u, mutationId });
  }
  seqAnswerGet(clientId: string, seq: number) {
    const a = this.t.seqAnswers.get(`${clientId}\0${seq}`);
    return a ? copy({ digest: a.digest, answer: a.answer, at: a.at }) : undefined;
  }
  seqAnswerPut(clientId: string, seq: number, a: StoredAnswer) {
    setIn(this.undo, this.t.seqAnswers, `${clientId}\0${seq}`, { ...copy(a), clientId, seq });
  }
  answersPrune(at: number, limit: number) {
    let n = 0;
    for (const m of [this.t.answers, this.t.seqAnswers] as Map<string, StoredAnswer>[]) {
      const old = [...m].filter(([, a]) => a.at < at).slice(0, limit);
      for (const [k] of old) setIn(this.undo, m, k, undefined);
      n += old.length;
    }
    return n;
  }

  clientGet = (id: string) => copy(this.t.clients.get(id));
  clientPut = (id: string, c: ClientRec) => setIn(this.undo, this.t.clients, id, { ...c });
  clientDelete = (id: string) => setIn(this.undo, this.t.clients, id, undefined);
  clientsPrune(at: number, limit: number) {
    const old = [...this.t.clients].filter(([, c]) => c.seen < at).slice(0, limit);
    for (const [k] of old) setIn(this.undo, this.t.clients, k, undefined);
    return old.length;
  }
  clientsOfDevice = (device: string) =>
    [...this.t.clients].filter(([, c]) => c.device === device).map(([id]) => id);
  registrations = (u: string, since: number) =>
    this.t.registrations.filter((r) => r.u === u && r.at >= since).length;
  registrationAdd(u: string, at: number) {
    this.t.registrations.push({ u, at });
    this.undo.push(() => this.t.registrations.pop());
  }
  registrationsPrune(at: number, limit: number) {
    const before = this.t.registrations;
    let n = 0;
    const kept = before.filter((r) => (r.at < at && n < limit ? (n++, false) : true));
    this.t.registrations = kept;
    this.undo.push(() => {
      this.t.registrations = before;
    });
    return n;
  }

  effectAdd(effect: Effect, at: number) {
    const id = this.t.meta.effectId + 1;
    this.meta("effectId", id);
    setIn(this.undo, this.t.effects, id, { id, effect: copy(effect), at, attempts: 0, next: at });
  }
  effectsDue(now: number, limit: number) {
    return [...this.t.effects.values()]
      .filter((e) => e.next <= now)
      .sort((a, b) => a.next - b.next || a.id - b.id)
      .slice(0, limit)
      .map(copy);
  }
  effectUpdate(id: number, attempts: number, next: number) {
    const e = this.t.effects.get(id);
    if (e) setIn(this.undo, this.t.effects, id, { ...e, attempts, next });
  }
  effectDelete = (id: number) => setIn(this.undo, this.t.effects, id, undefined);
  deadLetterAdd(d: Omit<DeadLetter, "id">) {
    const id = this.t.meta.letterId + 1;
    this.meta("letterId", id);
    setIn(this.undo, this.t.letters, id, { id, ...copy(d) });
  }

  tokenGet = (device: string) => copy(this.t.tokens.get(device));
  tokenByHash = (hash: string) => copy([...this.t.tokens.values()].find((t) => t.hash === hash));
  tokenPut = (t: DeviceToken) => setIn(this.undo, this.t.tokens, t.device, { ...t });
  signinGet = (request: string) => copy(this.t.signins.get(request));
  signinPut = (s: Signin) => setIn(this.undo, this.t.signins, s.request, { ...s });
  signinsPrune(at: number, limit: number) {
    const old = [...this.t.signins].filter(([, s]) => s.at < at).slice(0, limit);
    for (const [k] of old) setIn(this.undo, this.t.signins, k, undefined);
    return old.length;
  }
  leasePut = (l: Lease) => setIn(this.undo, this.t.leases, l.run, { ...l });
  leaseDelete = (run: string) => setIn(this.undo, this.t.leases, run, undefined);
  leasesBefore(at: number, limit: number) {
    return [...this.t.leases.values()]
      .filter((l) => l.until < at)
      .sort((a, b) => a.until - b.until)
      .slice(0, limit)
      .map((l) => ({ ...l }));
  }
}

export class MemoryServerStore implements ServerStore {
  private readonly t = new Tables();
  private depth = 0;

  transaction<T>(fn: (tx: StoreTx) => T): T {
    if (this.depth > 0) throw new Error("transactions do not nest");
    const undo: (() => void)[] = [];
    this.depth++;
    try {
      return fn(new MemoryTx(this.t, undo));
    } catch (e) {
      for (let k = undo.length - 1; k >= 0; k--) (undo[k] as () => void)();
      throw e;
    } finally {
      this.depth--;
    }
  }

  records(): Map<string, StoredRecord> {
    return new Map([...this.t.records].map(([k, r]) => [k, r.record]));
  }

  dump(): StoreDump {
    const t = this.t;
    return copy({
      records: [...t.records].map(([key, r]) => ({ key, record: r.record, born: r.born })),
      registry: [...t.registry].map(([id, rev]) => ({ id, rev })),
      logRows: [...t.logs].flatMap(([log, rows]) => [...rows.values()].map((r) => ({ log, ...r }))),
      epochs: [...t.epochs].map(([log, e]) => ({ log, ...e })),
      tombstones: [...t.tombs.values()],
      answers: [
        ...[...t.answers.values()].map((a) => ({
          u: a.u,
          mutationId: a.mutationId,
          digest: a.digest,
          answer: a.answer,
          at: a.at,
        })),
        ...[...t.seqAnswers.values()].map((a) => ({
          clientId: a.clientId,
          seq: a.seq,
          digest: a.digest,
          answer: a.answer,
          at: a.at,
        })),
      ],
      clients: [...t.clients].map(([clientId, c]) => ({ clientId, ...c })),
      registrations: [...t.registrations],
      effects: [...t.effects.values()],
      deadLetters: [...t.letters.values()],
      tokens: [...t.tokens.values()],
      signins: [...t.signins.values()],
      leases: [...t.leases.values()],
    });
  }
}
