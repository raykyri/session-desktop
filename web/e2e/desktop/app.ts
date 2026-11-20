// Starting the Desktop app in the desktop-mode e2e (phase 3): a scenario's
// records in the server, a device token for the person (`POST
// /api/test/device`, the device calls as the app makes them) in the test
// bridge's Keychain, and the app's frontend opened from its own origin with
// the bridge installed.

import { expect, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";

import { APP_ORIGIN, DESKTOP_ORIGIN } from "../constants.js";
import { MOCK_ME, type KeyedRecord } from "../fixtures/mockup.js";
import { loadScenario } from "../scenario.js";

import { TestBridge } from "./bridge.js";

const HEADERS = { "x-requested-with": "session", "content-type": "application/json" };

export interface DeviceSignIn {
  token: string;
  device: string;
  u: string;
}

/** A device token for `login`, as the app takes it after an approval. */
export async function deviceToken(request: APIRequestContext, login = MOCK_ME) {
  const r = await request.post(`${APP_ORIGIN}/api/test/device`, {
    headers: HEADERS,
    data: { login },
  });
  if (!r.ok()) throw new Error(`device: ${r.status()} ${await r.text()}`);
  return (await r.json()) as DeviceSignIn;
}

/** The Keychain item the app keeps for a sign-in. */
export const keychainItem = (d: DeviceSignIn) =>
  JSON.stringify({ token: d.token, device: d.device, handle: d.u, me: null });

/** The app's window: a page with the bridge, at `path`. */
export async function openApp(context: BrowserContext, bridge: TestBridge, path = "/") {
  const page = await context.newPage();
  page.on("pageerror", (e) => process.stdout.write(`page error: ${e.message}\n`));
  page.on("console", (m) => {
    if (m.type() === "error" && m.args().length)
      void Promise.all(m.args().map((a) => a.jsonValue().catch(() => "?"))).then((v) =>
        process.stdout.write(`console: ${JSON.stringify(v).slice(0, 3000)}\n`),
      );
  });
  await bridge.install(page);
  await page.goto(`${DESKTOP_ORIGIN}${path}`);
  return page;
}

export interface App {
  page: Page;
  bridge: TestBridge;
  records: KeyedRecord[];
  device: DeviceSignIn;
}

/** The app signed in as the mockup's person, over a scenario's records. */
export async function signedInApp(
  context: BrowserContext,
  o: {
    scenario?: string;
    args?: unknown;
    edit?: (r: KeyedRecord[]) => KeyedRecord[];
    path?: string;
    bridge?: TestBridge;
  } = {},
): Promise<App> {
  const { records } = await loadScenario(context.request, o.scenario ?? "seed", {
    ...(o.args !== undefined ? { args: o.args } : {}),
    ...(o.edit ? { edit: o.edit } : {}),
  });
  const device = await deviceToken(context.request);
  const bridge = o.bridge ?? new TestBridge();
  bridge.keychain = keychainItem(device);
  const page = await openApp(context, bridge, o.path ?? "/");
  await expect(page.getByRole("button", { name: /^Account: / })).toBeVisible();
  return { page, bridge, records, device };
}

/** The id of a space of the scenario by its name. */
export const spaceId = (records: KeyedRecord[], name: string) =>
  String(records.find((r) => r.record.kind === "space" && r.record["name"] === name)?.record["id"]);
