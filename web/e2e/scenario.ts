// Loading a Screen entry's data into the e2e server (phase 2b): the
// mockup's scenario as records (`fixtures/mockup.ts`), the server's clock set
// to the mockup's, and a browser context signed in as the mockup's person.

import type { APIRequestContext, BrowserContext } from "@playwright/test";

import { APP_ORIGIN } from "./constants.js";
import { MOCK_ME, scenarioRecords, type KeyedRecord } from "./fixtures/mockup.js";

const HEADERS = { "x-requested-with": "session", "content-type": "application/json" };

const cache = new Map<string, Promise<{ records: KeyedRecord[]; clock: string }>>();

/** A scenario's records (computed once per name and arguments). */
export function recordsOf(name = "seed", args?: unknown) {
  const k = JSON.stringify([name, args ?? null]);
  let p = cache.get(k);
  if (!p) cache.set(k, (p = scenarioRecords(name, args)));
  return p;
}

/** The server's store becomes the scenario's records; its clock the
 * mockup's (plus `advance` ms). `edit` changes the records first. */
export async function loadScenario(
  request: APIRequestContext,
  name = "seed",
  o: { args?: unknown; edit?: (r: KeyedRecord[]) => KeyedRecord[]; origin?: string } = {},
): Promise<{ clock: string; records: KeyedRecord[] }> {
  const origin = o.origin ?? APP_ORIGIN;
  const { records, clock } = await recordsOf(name, o.args);
  const list = o.edit ? o.edit(structuredClone(records)) : records;
  const set = await request.post(`${origin}/api/test/clock`, {
    headers: HEADERS,
    data: { now: Date.parse(clock) },
  });
  if (!set.ok()) throw new Error(`clock: ${set.status()} ${await set.text()}`);
  const r = await request.post(`${origin}/api/test/records`, {
    headers: HEADERS,
    data: { records: list, fresh: true },
  });
  if (!r.ok()) throw new Error(`records: ${r.status()} ${await r.text()}`);
  return { clock, records: list };
}

/** Sign the context in as `login` (the mockup's person by default). */
export async function signInAs(context: BrowserContext, login = MOCK_ME, origin = APP_ORIGIN) {
  const r = await context.request.post(`${origin}/auth/test-login`, {
    headers: HEADERS,
    data: { login, isAdmin: false },
  });
  if (!r.ok()) throw new Error(`test-login: ${r.status()} ${await r.text()}`);
}
