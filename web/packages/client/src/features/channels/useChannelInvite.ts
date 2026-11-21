// Opening a channel invite link, `/c/<name>#<code>` (02 W6.9, 04 B4). The
// code left the address bar on page load or at the route and waits in
// memory (`lib/pendingInvite.ts`). On the channel's page:
//
// - an active account joins with it (`spaces.join { space, invite }`), with
//   the toast "Joined #name."; a link that is used, revoked or expired, or
//   whose channel is frozen, answers "This invite link has expired or was
//   already used." (04 §9, B5); a banned person gets the server's message;
// - a member of the channel already: the code is dropped;
// - signed out: the auth dialog opens on "Sign in to join #name.". A
//   sign-in through a provider leaves the page; the code waits in this
//   tab's `sessionStorage` for the page load after it, and the account joins
//   then;
// - an account without an invite: the code step opens, and an account that
//   redeems an invite in the dialog joins next.

import { frozenMessage, type ApiError } from "@session/mutators";
import { useEffect, useRef } from "react";

import { clearPendingInvite, readPendingInvite } from "../../lib/pendingInvite.js";
import { useReplica } from "../../replica/ReplicaProvider.js";
import type { ChannelView } from "../../replica/queries.js";
import { openAuthDialog } from "../auth/authDialog.js";
import { showToast } from "../shell/Toast.js";
import type { Viewer } from "../shell/viewer.js";

/** The one message for a channel link that does not work. */
export const LINK_UNUSABLE = "This invite link has expired or was already used.";

/** What a refused link join shows: the one message for a link that does not
 * work (unknown, used, revoked or expired, or its channel frozen), else the
 * server's own message (a ban). */
export function linkJoinMessage(error: ApiError, channel: string): string {
  if (error.code === "NOT_FOUND") return LINK_UNUSABLE;
  if (
    error.code === "FORBIDDEN" &&
    (error.message === LINK_UNUSABLE || error.message === frozenMessage(channel))
  )
    return LINK_UNUSABLE;
  return error.message;
}

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
        openAuthDialog(
          kind === "waiting" ? { step: "code", redeem: true } : { step: "landing", channel: name },
        );
      }
      return;
    }
    clearPendingInvite();
    if (joined) return;
    void source.mutate("spaces.join", { space: id, invite: invite.code }).then((outcome) => {
      if (outcome.ok) {
        if (!outcome.unsent) showToast(`Joined #${name}.`);
      } else {
        showToast(linkJoinMessage(outcome.error, name), { alert: true });
      }
    });
  }, [source, kind, id, name, joined]);
}
