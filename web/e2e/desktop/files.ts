// The app's files as the checks read them.

import type { TestBridge } from "./bridge.js";

/** The replica file of the person the Keychain item names. */
export function replicaFileOf(bridge: TestBridge, handle?: string): string {
  const h =
    handle ?? (JSON.parse(bridge.keychain ?? "{}") as { handle?: string }).handle ?? "nobody";
  return `replica-${h.toLowerCase().replace(/[^a-z0-9._-]/g, "_")}.sqlite`;
}

/** The outbox as stored: each entry's name, state and input. */
export function storedOutbox(
  bridge: TestBridge,
): { name: string; state: string; input: Record<string, unknown>; mutationId: string }[] {
  return bridge
    .query<{ body: string }>(
      replicaFileOf(bridge),
      "SELECT body FROM sync_client_outbox ORDER BY pos",
    )
    .map((r) => JSON.parse(r.body) as never);
}
