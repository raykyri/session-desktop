// An invitation link (web only; `invites.create`'s `url`, `/invite#<token>`).
// The token arrives as the URL fragment, is removed from the address bar
// before anything is requested, and waits in this tab's `sessionStorage`
// (`lib/pendingInvite.ts`). Signed in, the invitation is accepted and the
// thread opens. Signed out, the reader signs in and comes back to `/invite`,
// which reads the stored token. An unknown, used, expired or revoked
// invitation, or one addressed to another GitHub account, shows the server's
// reason.
//
// `/invite/<token>`, the form of earlier links, stores its token the same way
// and replaces the address with `/invite` (`router.tsx`).

import { useNavigate } from "@tanstack/react-router";
import { LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useAcceptThreadInvite, useMe } from "../api/queries.js";
import {
  INVITE_PATH,
  captureInviteFragment,
  clearPendingInvite,
  readPendingInvite,
} from "../lib/pendingInvite.js";
import { errorMessage } from "../lib/toast.js";
import { ControlButton } from "../ui/Button.js";

/** Shown when `/invite` has no token: opened without the part after `#`, or
 * an hour after the sign-in that should have used it. */
export const INCOMPLETE_INVITE_MESSAGE =
  "This invitation link is incomplete. Open the whole link you were sent again.";

export function InvitePage() {
  // An in-app navigation to `/invite#…` still has the fragment here; a page
  // load already moved it to storage (`app/captureInvite.ts`).
  const [token, setToken] = useState(() => captureInviteFragment() ?? readPendingInvite());
  const me = useMe();
  const navigate = useNavigate();
  const accept = useAcceptThreadInvite();
  const acceptMutate = accept.mutate;
  const [error, setError] = useState<string | null>(
    token === null ? INCOMPLETE_INVITE_MESSAGE : null,
  );
  const started = useRef(false);
  // Bumped by another link opened on this page, so the same token can be
  // tried again.
  const [attempt, setAttempt] = useState(0);
  const signedIn = Boolean(me.data);
  const settled = !me.isLoading;

  // Another invitation link opened on this page changes only the fragment,
  // which reloads nothing: it is read here and starts over.
  useEffect(() => {
    const onHashChange = () => {
      const next = captureInviteFragment();
      if (next === null) return;
      started.current = false;
      setError(null);
      setToken(next);
      setAttempt((count) => count + 1);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    if (!settled || token === null) return;
    if (!signedIn) {
      // The token stays in storage across the sign-in; only the path goes
      // into the redirect.
      void navigate({ to: "/login", search: { redirect: INVITE_PATH }, replace: true });
      return;
    }
    // Once per visit: a second accept of a link invitation is harmless, but
    // a login invitation is used up by the first.
    if (started.current) return;
    started.current = true;
    acceptMutate(
      { token },
      {
        onSuccess: (tree) => {
          clearPendingInvite();
          void navigate({ to: "/r/$treeId", params: { treeId: tree.id }, replace: true });
        },
        onError: (failure) => {
          clearPendingInvite();
          setError(errorMessage(failure));
        },
      },
    );
  }, [acceptMutate, attempt, navigate, settled, signedIn, token]);

  return (
    <div className="bg-surface-feed flex h-full w-full items-center justify-center px-6">
      <div
        className="flex w-[min(400px,100%)] flex-col items-center gap-4 text-center"
        data-invite-page=""
      >
        {error ? (
          <>
            <h1 className="text-fg-heading m-0 text-base font-semibold">
              This invitation can’t be used
            </h1>
            <p className="text-fg-secondary m-0 text-sm" role="alert">
              {error}
            </p>
            <p className="text-fg-muted m-0 text-sm">
              Ask the person who shared the thread for a new invitation.
            </p>
            <ControlButton onClick={() => void navigate({ to: "/" })}>Go to Home</ControlButton>
          </>
        ) : (
          <>
            <LoaderCircle className="session-spin text-fg-muted" size={22} aria-hidden="true" />
            <p className="text-fg-muted m-0 text-sm" role="status">
              Opening the shared thread…
            </p>
          </>
        )}
      </div>
    </div>
  );
}
