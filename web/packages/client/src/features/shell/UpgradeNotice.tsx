// The message shown instead of a second reload when the server answers
// `UPGRADE_REQUIRED` again within 60 s of the reload it caused (02 §9.2,
// `replica/upgrade.ts`).

import { UPGRADE_MESSAGE, useUpgradeStore } from "../../replica/upgrade.js";

export function UpgradeNotice() {
  const stuck = useUpgradeStore((state) => state.stuck);
  if (!stuck) return null;
  return (
    <div role="alert" className="feed-toast outbox-toast" data-upgrade-notice="">
      <span>{UPGRADE_MESSAGE}</span>
      <button type="button" onClick={() => globalThis.location.reload()}>
        Reload
      </button>
    </div>
  );
}
