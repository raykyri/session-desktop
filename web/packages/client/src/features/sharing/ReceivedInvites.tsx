// The invitations addressed to the reader's GitHub login (web only), at the
// top of Shared with me. Accept joins the thread and opens it.

import type { ReceivedInvite } from "@session/shared";
import { useNavigate } from "@tanstack/react-router";

import { useAcceptThreadInvite, useReceivedInvites } from "../../api/queries.js";
import { pushErrorToast } from "../../lib/toast.js";
import { ControlButton } from "../../ui/Button.js";

import { ROLE_LABELS } from "./ShareDialog.js";

function InviteRow({ invite }: { invite: ReceivedInvite }) {
  const accept = useAcceptThreadInvite();
  const navigate = useNavigate();
  const from = invite.invitedByLogin ? `From @${invite.invitedByLogin}` : "Invitation";
  return (
    <li
      className="flex min-h-11 items-center gap-2.5 rounded-lg py-1.5 pr-1 pl-3"
      data-received-invite={invite.id}
    >
      <span className="flex min-w-0 flex-1 flex-col gap-px">
        <span className="text-fg-primary text-base leading-[1.35] [overflow-wrap:anywhere]">
          {invite.treeTitle}
        </span>
        <span className="text-fg-faint text-xs">
          {from} · {ROLE_LABELS[invite.role]}
        </span>
      </span>
      <ControlButton
        size="sm"
        aria-label={`Accept the invitation to ${invite.treeTitle}`}
        disabled={accept.isPending}
        onClick={() =>
          accept.mutate(
            { inviteId: invite.id },
            {
              onSuccess: (tree) => void navigate({ to: "/r/$treeId", params: { treeId: tree.id } }),
              onError: (error) => pushErrorToast("Couldn’t accept the invitation", error),
            },
          )
        }
      >
        Accept
      </ControlButton>
    </li>
  );
}

/** Nothing while there are no invitations. */
export function ReceivedInvites() {
  const invites = useReceivedInvites().data ?? [];
  if (invites.length === 0) return null;
  return (
    <section className="mx-2 mb-2.5" aria-label="Invitations">
      <h2 className="text-fg-secondary m-0 px-3 pt-2 pb-1 text-xs font-semibold tracking-wide uppercase">
        Invitations
      </h2>
      <ul className="m-0 list-none p-0">
        {invites.map((invite) => (
          <InviteRow key={invite.id} invite={invite} />
        ))}
      </ul>
    </section>
  );
}
