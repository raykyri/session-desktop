// `UPGRADE_REQUIRED` (`426`, `01` S1, `02` §9.2): the server no longer
// accepts this build's protocol. The tab keeps unsent composer text in
// `drafts` (the caller does that first), writes the time of the reload to
// sessionStorage and reloads once. A second `426` within 60 s of that
// reload shows "Session was updated. Reload to continue." with a Reload
// button instead of reloading in a loop; one more than 60 s after it reloads
// again and overwrites the time.

import { create } from "zustand";

export const UPGRADE_RELOAD_KEY = "session-upgrade-reload-at";
/** A second `426` within this long of the reload shows the message. */
export const UPGRADE_RELOAD_WINDOW_MS = 60_000;
export const UPGRADE_MESSAGE = "Session was updated. Reload to continue.";

interface UpgradeState {
  /** The Reload message is showing. */
  stuck: boolean;
}

export const useUpgradeStore = create<UpgradeState>()(() => ({ stuck: false }));

export interface UpgradeDeps {
  storage: Pick<Storage, "getItem" | "setItem">;
  now: () => number;
  reload: () => void;
}

const browserDeps = (): UpgradeDeps => ({
  storage: globalThis.sessionStorage,
  now: () => Date.now(),
  reload: () => globalThis.location.reload(),
});

let before: (() => void)[] = [];

/** Run `keep` before the reload (the replica puts the text of its unsent
 * writes back in their drafts). Returns the unsubscribe. */
export function beforeUpgradeReload(keep: () => void): () => void {
  before.push(keep);
  return () => {
    before = before.filter((f) => f !== keep);
  };
}

let reloading = false;

/** A `426` arrived: reload once, or show the Reload message when this tab
 * reloaded for the same reason less than 60 s ago. */
export function upgradeRequired(deps: UpgradeDeps = browserDeps()): "reload" | "message" | "none" {
  if (reloading) return "none";
  if (useUpgradeStore.getState().stuck) return "message";
  const now = deps.now();
  let last = Number.NaN;
  try {
    last = Number(deps.storage.getItem(UPGRADE_RELOAD_KEY));
  } catch {
    // no sessionStorage: reload
  }
  if (Number.isFinite(last) && last > 0 && now - last < UPGRADE_RELOAD_WINDOW_MS) {
    useUpgradeStore.setState({ stuck: true });
    return "message";
  }
  try {
    deps.storage.setItem(UPGRADE_RELOAD_KEY, String(now));
  } catch {
    // reload without the record: a loop is then bounded by the server
  }
  // only before a reload: without one the writes stay "Not sent", with
  // their own Retry and Discard
  for (const keep of before)
    try {
      keep();
    } catch {
      // a draft that could not be kept does not stop the reload
    }
  reloading = true;
  deps.reload();
  return "reload";
}

/** Tests: forget a reload in progress and hide the message. */
export function resetUpgradeForTests(): void {
  reloading = false;
  before = [];
  useUpgradeStore.setState({ stuck: false });
}
