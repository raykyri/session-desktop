// Writes in the Desktop app's stored outbox, as a process that ended left
// them (the mockup's sync-state screens: "made 5 days ago on a device that
// was off until an hour ago"), and the server's state the tests change
// meanwhile.

import type { APIRequestContext } from "@playwright/test";

import { APP_ORIGIN } from "../constants.js";
import type { KeyedRecord } from "../fixtures/mockup.js";

import type { TestBridge } from "./bridge.js";
import { replicaFileOf } from "./files.js";

const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let n = 0;

/** A ULID made at `ms` (its random part from a counter). */
export function ulid(ms: number): string {
  let t = "";
  for (let i = 0, x = ms; i < 10; i++, x = Math.floor(x / 32)) t = (B32[x % 32] ?? "0") + t;
  let r = "";
  for (let i = 0, x = ++n * 7919 + 104729; i < 16; i++, x = Math.floor(x / 32) + i * 31)
    r += B32[x % 32] ?? "0";
  return t + r;
}

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

/** The server's time now. */
export async function serverNow(request: APIRequestContext): Promise<number> {
  const r = await request.get(`${APP_ORIGIN}/api/spaces`);
  return ((await r.json()) as { serverTime: number }).serverTime;
}

export interface Seeded {
  name: string;
  input: Record<string, unknown>;
  /** How long ago it was made (its ids' time) and queued. */
  made: number;
  queued?: number;
  /** The ids its input makes. */
  minted?: string[];
  /** Its state as the earlier run left it (default: queued). */
  state?: string;
}

/** Add writes to the end of the stored outbox (the app is not running). */
export function seedOutbox(bridge: TestBridge, now: number, writes: Seeded[]): string[] {
  const file = replicaFileOf(bridge);
  const last =
    bridge.query<{ pos: number | null }>(file, "SELECT max(pos) AS pos FROM sync_client_outbox")[0]
      ?.pos ?? -1;
  const locals: string[] = [];
  writes.forEach((w, k) => {
    const at = now - w.made;
    const local = ulid(at);
    locals.push(local);
    const e = {
      local,
      mutationId: ulid(at),
      name: w.name,
      input: w.input,
      queuedAt: now - (w.queued ?? w.made),
      replaces: [],
      uncertain: false,
      sent: false,
      wire: false,
      tries: 0,
      next: 0,
      state: w.state ?? "queued",
      minted: w.minted ?? (typeof w.input["id"] === "string" ? [w.input["id"]] : []),
    };
    bridge.run(file, "INSERT INTO sync_client_outbox (pos, body) VALUES (?, ?)", [
      last + 1 + k,
      JSON.stringify(e),
    ]);
  });
  return locals;
}

const HEADERS = { "x-requested-with": "session", "content-type": "application/json" };

/** Server writes of records (`POST /api/test/records`, not fresh): each is
 * written as a server write, so its rev moves on. */
export async function serverWrite(request: APIRequestContext, records: KeyedRecord[]) {
  const r = await request.post(`${APP_ORIGIN}/api/test/records`, {
    headers: HEADERS,
    data: { records },
  });
  if (!r.ok()) throw new Error(`records: ${r.status()} ${await r.text()}`);
}

/** The next `times` writes the server takes answer `code`, unrecorded. */
export async function failNext(request: APIRequestContext, code: string, times: number) {
  const r = await request.post(`${APP_ORIGIN}/api/test/fail`, {
    headers: HEADERS,
    data: { code, times },
  });
  if (!r.ok()) throw new Error(`fail: ${r.status()}`);
}

// ---- the scenario's records ----

/** The Sablefield post "4.2 is out" (the mockup's sf4), its space and its
 * replies. */
export function sf4(records: KeyedRecord[]) {
  const sp = records.find((r) => r.record.kind === "space" && r.record["name"] === "sablefield");
  const th = records.find(
    (r) =>
      r.record.kind === "thread" &&
      r.record["s"] === sp?.record["id"] &&
      /4\.2 is out/.test(String(r.record["q"])),
  );
  return {
    space: String(sp?.record["id"]),
    thread: String(th?.record["id"]),
    path: `/s/sablefield/t/${String(th?.record["id"])}`,
    replies: records.filter(
      (r) => r.record.kind === "reply" && r.record["th"] === th?.record["id"],
    ),
  };
}

/** A copy of the records with one changed. */
export function editRecord(
  records: KeyedRecord[],
  key: string,
  f: (r: KeyedRecord["record"]) => KeyedRecord["record"],
): KeyedRecord[] {
  return records.map((r) => (r.key === key ? { key, record: f(structuredClone(r.record)) } : r));
}
