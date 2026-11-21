// The auth dialog's automatic openings (02 W7.2, W2.1; plan 04 I4):
//
// - an account invite link (`/i#<code>`, its code in memory,
//   `lib/pendingInvite.ts`): signed out, the dialog opens on the link's
//   answer from `auth.checkInvite`; for a waiting account, at the code step
//   with the code filled in; a member's link is dropped;
// - a waiting account that holds an open invite (back from the provider
//   with a code, or redeemed in another tab): the profile step, once per
//   page load.

import { useRouterState } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { useMe } from "../../api/account.js";
import { checkInvite } from "../../api/membership.js";
import { clearPendingInvite, readPendingInvite } from "../../lib/pendingInvite.js";
import type { Viewer } from "../shell/viewer.js";

import { openAuthDialog, useAuthDialog } from "./authDialog.js";

export function useAccountDialogs(viewer: Viewer): void {
  const me = useMe();
  const profileShown = useRef(false);
  const kind = viewer.kind;
  const pendingInvite = me.data?.pendingInvite ?? null;
  // A link followed inside the app lands on `/` through the `/i` route
  // without remounting the shell; the path change is the cue.
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  useEffect(() => {
    if (!me.isSuccess) return;
    const invite = readPendingInvite();
    if (invite?.kind !== "account") return;
    clearPendingInvite();
    if (kind === "member") return;
    if (kind === "waiting") {
      openAuthDialog({ step: "code", redeem: true, code: invite.code });
      return;
    }
    openAuthDialog({
      step: "landing",
      link: { code: invite.code, state: "checking", inviter: null },
    });
    checkInvite(invite.code)
      .then((check) => {
        const current = useAuthDialog.getState().link;
        if (current?.code !== invite.code) return;
        useAuthDialog.getState().set({
          link:
            check.status === "open"
              ? { code: invite.code, state: "open", inviter: check.inviter }
              : { code: invite.code, state: "unusable", inviter: null },
        });
      })
      .catch(() => {
        const current = useAuthDialog.getState().link;
        if (current?.code === invite.code) {
          useAuthDialog.getState().set({ link: { ...current, state: "unusable" } });
        }
      });
  }, [kind, me.isSuccess, pathname]);

  useEffect(() => {
    if (kind !== "waiting" || pendingInvite === null || profileShown.current) return;
    if (useAuthDialog.getState().open) return;
    profileShown.current = true;
    openAuthDialog({ step: "profile", profileInviter: pendingInvite });
  }, [kind, pendingInvite]);
}
