// The switch between the prototype's own mutators and read rules
// (`mutators.ts`, `access.ts`; the default) and `@session/mutators` (with
// REPLICA_PROTO_MUTATORS=package in the environment, `npm run
// test:package`). With the switch on, the server applies every write through
// `@session/mutators`' `apply`, filters every read with its `view`, and keys
// its logs and registry with its record helpers, so the whole suite runs
// against the package.
//
// `MUTATORS` (the active set) keeps the prototype's `AnyMutator` shape either
// way, so the suite can wrap a mutator's `run` or `pre` to inject a fault.
// With the switch on, each entry's `run` and `pre` call the package
// mutator's, with the package's `Tx` and pre-check context; the server runs
// an entry's `run` and `pre` in place of the package mutator's, and the
// package mutator's `can`, `ids` and `needsPre` for its name.

import * as pkg from "@session/mutators";

import * as own from "./access.js";
import type { ApplyResult } from "./contract.js";
import {
  MUTATORS as OWN_MUTATORS,
  Refusal,
  refuse,
  type AnyMutator,
  type Effect,
} from "./mutators.js";
import * as rec from "./records.js";
import type { StoredRecord } from "./records.js";

export const USE_PACKAGE = process.env["REPLICA_PROTO_MUTATORS"] === "package";

/** The prototype's key-based reads. */
interface KeyReader {
  get(key: string): StoredRecord | undefined;
}

/** A package `Reader` over key-based reads. */
const byKind = (g: KeyReader): pkg.Reader => ({
  get: <K extends pkg.Kind>(kind: K, id: string) =>
    g.get(`${kind}:${id}`) as pkg.RecordOf<K> | undefined,
});

const asPkg = (r: StoredRecord) => r as unknown as pkg.StoredRecord;
const asOwn = (r: unknown) => r as StoredRecord;

/** A package mutator in the prototype's shape. */
function adapt(m: pkg.Mutator): AnyMutator {
  return {
    input: m.input,
    online: m.online,
    who: "user",
    ids: (i) => m.ids(i),
    ...(m.pre
      ? {
          pre: (ctx, i) =>
            (m.pre as NonNullable<pkg.Mutator["pre"]>)(ctx as unknown as pkg.PreCtx, i),
        }
      : {}),
    run: (tx, i, v) => m.run(tx as unknown as pkg.Tx, i, v),
    post: (i, r) => m.effects(i, r) as unknown as Effect[],
  };
}

const PACKAGE_MUTATORS: Readonly<Record<string, AnyMutator>> = Object.freeze(
  Object.fromEntries(pkg.MUTATORS.names.map((n) => [n, adapt(pkg.MUTATORS.get(n) as pkg.Mutator)])),
);

/** The mutators the server and the client use by default. */
export const ACTIVE_MUTATORS: Readonly<Record<string, AnyMutator>> = USE_PACKAGE
  ? PACKAGE_MUTATORS
  : OWN_MUTATORS;

/** What `applyPackage` decided, as the server's `execute` needs it. */
export type PackageOutcome =
  | { kind: "refused"; refusal: Refusal }
  | {
      kind: "ok";
      result: ApplyResult;
      staged: Map<string, StoredRecord | null>;
      effects: (Effect | pkg.Effect)[];
    };

/** Run `f`, with a refusal of the prototype's (from a mutator a test
 * wrapped) thrown as the package's. */
function refusing<T>(f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof Refusal) throw pkg.refuse(e.code, e.message, e.issues);
    throw e;
  }
}

/** A package registry from a set of mutators in the prototype's shape (the
 * server's set, which a test may give a faulty definition): each entry's
 * input, ids, pre, run and effects over the package mutator of its name's
 * `can` and `needsPre`. `@session/sync`'s server half runs the suite with
 * it. */
export function packageRegistry(mutators: Readonly<Record<string, AnyMutator>>): pkg.Registry {
  const list: pkg.Mutator[] = [];
  for (const name of Object.keys(mutators)) {
    const entry = mutators[name];
    const base = pkg.MUTATORS.get(name);
    if (!entry) continue;
    if (!base) throw new Error(`${name} has no package mutator`);
    list.push(merged(base, entry));
  }
  return pkg.createRegistry(list);
}

/** A package mutator with a prototype-shaped entry's stages. */
function merged(base: pkg.Mutator, entry: AnyMutator): pkg.Mutator {
  const pre = entry.pre;
  return {
    ...base,
    input: entry.input,
    online: entry.online === true,
    ids: (i) => entry.ids?.(i) ?? [],
    pre: pre
      ? (ctx, i) => refusing(() => pre(ctx as unknown as Parameters<typeof pre>[0], i))
      : undefined,
    run: (tx, i, v) =>
      refusing(() => entry.run(tx as unknown as Parameters<AnyMutator["run"]>[0], i, v)),
    effects: (i, r) => (entry.post?.(i, r) ?? []) as unknown as pkg.Effect[],
  };
}

/** Apply one write through the package: the mutator named `name` in
 * `mutators` (the server's set), run by `@session/mutators`' `apply` over
 * `source`. */
export function applyPackage(
  mutators: Readonly<Record<string, AnyMutator>>,
  source: pkg.RecordSource,
  u: string,
  envelope: { mutationId: string; name: string; input: unknown; clientTime: number },
  now: number,
  random: () => number,
): PackageOutcome {
  const entry = Object.hasOwn(mutators, envelope.name) ? mutators[envelope.name] : undefined;
  const base = pkg.MUTATORS.get(envelope.name);
  const list: pkg.Mutator[] = [];
  if (entry && base) list.push(merged(base, entry));
  else if (entry) throw new Error(`${envelope.name} has no package mutator`);
  const out = pkg.apply(pkg.createRegistry(list), source, { u }, envelope, {
    now,
    server: { random },
  });
  if (out.status === "refused")
    return {
      kind: "refused",
      refusal: new Refusal(out.error.code, out.error.message, out.error.issues),
    };
  if (out.status === "unknown")
    return { kind: "refused", refusal: refuse("INTERNAL_SERVER_ERROR") };
  const staged = new Map<string, StoredRecord | null>();
  for (const [key, draft] of out.writes)
    staged.set(key, draft === null ? null : asOwn({ ...draft, rev: 0 }));
  return {
    kind: "ok",
    result: { ok: true, result: out.result },
    staged,
    effects: [...out.effects],
  };
}

// ---- read rules and record helpers ----

export type Audience = own.Audience;

export const audience = (g: KeyReader, r: StoredRecord): Audience =>
  USE_PACKAGE ? (pkg.audience(byKind(g), asPkg(r)) as unknown as Audience) : own.audience(g, r);

export const readsAudience = (g: KeyReader, a: Audience, u: string | null): boolean =>
  USE_PACKAGE ? pkg.readsAudience(byKind(g), a, u) : own.readsAudience(g, a, u);

export const view = (g: KeyReader, r: StoredRecord, u: string | null): StoredRecord | null => {
  if (!USE_PACKAGE) return own.view(g, r, u);
  const v = pkg.view(byKind(g), asPkg(r), u);
  return v === null ? null : asOwn(v);
};

export const isClosed = own.isClosed;

export const spaceRec = (g: KeyReader, sp: string) => own.spaceRec(g, sp);

export const audienceOf = (r: rec.Draft | StoredRecord) =>
  USE_PACKAGE ? pkg.audienceOf(r as unknown as pkg.Draft) : rec.audienceOf(r);
export const createdOf = (r: StoredRecord) =>
  USE_PACKAGE ? pkg.createdOf(asPkg(r)) : rec.createdOf(r);
export const idOf = (r: rec.Draft | StoredRecord) =>
  USE_PACKAGE ? pkg.idOf(r as unknown as pkg.Draft) : rec.idOf(r);
export const keyOf = (r: rec.Draft | StoredRecord) =>
  USE_PACKAGE ? pkg.keyOf(r as unknown as pkg.Draft) : rec.keyOf(r);
// the prototype has no catalog log: no write here makes a catalog source
export const logsOf = (r: rec.Draft | StoredRecord): rec.LogId[] =>
  USE_PACKAGE
    ? pkg.logsOf(r as unknown as pkg.Draft).filter((l): l is rec.LogId => l !== "catalog")
    : rec.logsOf(r);
export const registryKey = (r: rec.Draft | StoredRecord) =>
  USE_PACKAGE ? pkg.registryKey(r as unknown as pkg.Draft) : rec.registryKey(r);

/** The keys whose view a record's change changes besides its own (a hide
 * record's item), with the switch on; none for the prototype's records. */
export const viewDependents = (r: rec.Draft | StoredRecord): string[] =>
  USE_PACKAGE ? pkg.viewDependents(r as unknown as pkg.Draft) : [];

/** Whether a tombstone of this kind is in a space's log: the records of
 * the kinds the person's user log holds alone (likes, saves, notifications)
 * are not. */
export const inSpaceLog = (kind: string) =>
  USE_PACKAGE
    ? !pkg.NO_SPACE_LOG.has(kind as pkg.Kind)
    : kind !== "like" && kind !== "save" && kind !== "notif";
