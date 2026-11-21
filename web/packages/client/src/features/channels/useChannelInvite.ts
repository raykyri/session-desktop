// Opening a channel invite link, `/c/<name>#<code>` (02 W6.9, 04 B4). The
// code left the address bar on page load and waits in memory
// (`lib/pendingInvite.ts`). On the channel's page:
//
// - an active account joins with it (`spaces.join { space, invite }`), with
//   the toast "Joined #name."; a link that is used, revoked or expired, or
//   whose channel is frozen, answers "This invite link has expired or was
//   already used." (04 §9);
// - a member of the channel already: the code is dropped;
// - signed out, or an account without an invite: the auth dialog opens, and
//   the code stays in memory for this page load, so an account that redeems
//   an invite in the dialog joins next. A sign-in through a provider leaves
//   the page, and the person opens the link again.

import { useEffect, useRef } from "react";

import { clearPendingInvite, readPendingInvite } from "../../lib/pendingInvite.js";
import { useReplica } from "../../replica/ReplicaProvider.js";
import type { ChannelView } from "../../replica/queries.js";
import { openAuthDialog } from "../auth/authDialog.js";
import { showToast } from "../shell/Toast.js";
import type { Viewer } from "../shell/viewer.js";

/** The one message for a channel link that does not work. */
export const LINK_UNUSABLE = "This invite link has expired or was already used.";

export function useChannelInvite(viewer: Viewer, channel: ChannelView | null): void {
  const source = useReplica();
  const asked = useRef(false);
  const kind = viewer.kind;
  const id = channel?.id;
  const name = channel?.name;
  const joined = channel?.joined ?? false;
  useEffect(() => {
    const invite = readPendingInvite();
    if (invite?.kind !== "channel" || id === undefined || invite.channel !== name) return;
    if (kind !== "member") {
      if (!asked.current) {
        asked.current = true;
        openAuthDialog(kind === "waiting" ? { step: "code", redeem: true } : { step: "landing" });
      }
      return;
    }
    clearPendingInvite();
    if (joined) return;
    void source.mutate("spaces.join", { space: id, invite: invite.code }).then((outcome) => {
      if (outcome.ok) {
        if (!outcome.unsent) showToast(`Joined #${name}.`);
      } else {
        const code = outcome.error.code;
        const unusable = code === "FORBIDDEN" || code === "NOT_FOUND";
        showToast(unusable ? LINK_UNUSABLE : outcome.error.message, { alert: true });
      }
    });
  }, [source, kind, id, name, joined]);
}
