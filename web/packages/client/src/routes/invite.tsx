// An invitation link (web only; `invites.create`'s `url`, `/invite/<token>`).
// Signed in, the invitation is accepted and the thread opens. Signed out,
// the reader signs in and comes back here. An unknown, used, expired or
// revoked invitation, or one addressed to another GitHub account, shows the
// server's reason.

import { useNavigate, useParams } from "@tanstack/react-router";
import { LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useAcceptThreadInvite, useMe } from "../api/queries.js";
import { errorMessage } from "../lib/toast.js";
import { ControlButton } from "../ui/Button.js";

export function InvitePage() {
  const { token } = useParams({ from: "/_shell/invite/$token" });
  const me = useMe();
  const navigate = useNavigate();
  const accept = useAcceptThreadInvite();
  const acceptMutate = accept.mutate;
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  const signedIn = Boolean(me.data);
  const settled = !me.isLoading;

  useEffect(() => {
    if (!settled) return;
    if (!signedIn) {
      void navigate({
        to: "/login",
        search: { redirect: `/invite/${encodeURIComponent(token)}` },
        replace: true,
      });
      return;
    }
    // Once per visit: a second accept of a link invitation is harmless, but
    // a login invitation is used up by the first.
    if (started.current) return;
    started.current = true;
    acceptMutate(
      { token },
      {
        onSuccess: (tree) =>
          void navigate({ to: "/r/$treeId", params: { treeId: tree.id }, replace: true }),
        onError: (failure) => setError(errorMessage(failure)),
      },
    );
  }, [acceptMutate, navigate, settled, signedIn, token]);

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
