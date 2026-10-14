// The Share dialog of a thread (web only), opened from the thread menu. The
// owner sets who may read the thread (Private: the people it is shared with;
// Public: anyone with the link, listed in All Users), changes members' roles
// or removes them, invites by GitHub username or by link, and revokes pending
// invitations. Anyone else sees the people it is shared with, and a member
// can leave it.

import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import type { MemberRole, ResearchTree, ThreadInvite, ThreadMember } from "@session/shared";
import { Link as LinkIcon } from "lucide-react";
import { useId, useState, type FormEvent } from "react";

import {
  useCreateThreadInvite,
  useLeaveThread,
  useRemoveThreadMember,
  useRevokeThreadInvite,
  useSetThreadMemberRole,
  useSetTreeVisibility,
  useThreadInvites,
  useThreadMembers,
} from "../../api/queries.js";
import { writeClipboardText } from "../../lib/clipboard.js";
import { cn } from "../../lib/cn.js";
import { pushErrorToast, pushToast } from "../../lib/toast.js";
import { ControlButton } from "../../ui/Button.js";
import { Dialog } from "../../ui/Dialog.js";
import { Select } from "../../ui/Select.js";
import { CONTROL_BUTTON, CONTROL_BUTTON_SIZE, INPUT_FIELD } from "../../ui/surfaces.js";

import { Avatar } from "./AuthorChip.js";
import { participantName } from "./context.js";

export const ROLE_LABELS: Record<ThreadMember["role"], string> = {
  owner: "Owner",
  commenter: "Commenter",
  viewer: "Viewer",
};

const ROLE_OPTIONS = [
  { value: "commenter", label: "Commenter", detail: "Can ask and add notes" },
  { value: "viewer", label: "Viewer", detail: "Can read" },
] as const;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

function expiryText(expiresAt: number): string {
  return `Expires ${new Date(expiresAt).toLocaleDateString(undefined, { dateStyle: "medium" })}`;
}

function SectionHeading({ children }: { children: string }) {
  return (
    <h3 className="text-fg-secondary m-0 mb-1.5 text-xs font-semibold tracking-wide uppercase">
      {children}
    </h3>
  );
}

function Visibility({
  tree,
  editable,
}: {
  tree: Pick<ResearchTree, "id" | "visibility">;
  editable: boolean;
}) {
  const setVisibility = useSetTreeVisibility();
  const name = useId();
  const current = tree.visibility ?? "private";
  const options = [
    {
      value: "private" as const,
      label: "Private",
      detail: "Only you and the people you share it with.",
    },
    {
      value: "public" as const,
      label: "Public",
      detail: "Anyone with the link can read it. It is listed in All Users.",
    },
  ];
  if (!editable) {
    const shown = options.find((option) => option.value === current) ?? options[0];
    return (
      <p className="text-fg-secondary m-0 text-sm" data-share-visibility={current}>
        <b className="text-fg-primary font-medium">{shown?.label}.</b> {shown?.detail}
      </p>
    );
  }
  return (
    <div role="radiogroup" aria-label="Who can read it" className="flex flex-col gap-1">
      {options.map((option) => (
        <label
          key={option.value}
          className={cn(
            "grid cursor-pointer grid-cols-[auto_1fr] items-start gap-x-2 rounded-md px-2 py-1.5",
            "hover:bg-surface-fill-hover",
          )}
        >
          <input
            type="radio"
            name={name}
            className="row-span-2 mt-[3px]"
            value={option.value}
            checked={current === option.value}
            disabled={setVisibility.isPending}
            onChange={() =>
              setVisibility.mutate(
                { treeId: tree.id, visibility: option.value },
                { onError: (error) => pushErrorToast("Couldn’t change who can read it", error) },
              )
            }
          />
          <span className="text-fg-primary text-sm font-medium">{option.label}</span>
          <span className="text-fg-muted col-start-2 text-xs">{option.detail}</span>
        </label>
      ))}
    </div>
  );
}

function MemberRow({
  treeId,
  member,
  meId,
  editable,
  onRemoved,
}: {
  treeId: string;
  member: ThreadMember;
  meId: string | null;
  editable: boolean;
  onRemoved: () => void;
}) {
  const setRole = useSetThreadMemberRole();
  const remove = useRemoveThreadMember();
  const name = participantName(member);
  const you = member.userId === meId;
  return (
    <li className="flex min-h-9 items-center gap-2 py-1" data-share-member={member.login}>
      <Avatar person={member} size={22} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-fg-primary truncate text-sm">
          {name}
          {you ? <span className="text-fg-muted"> (you)</span> : null}
        </span>
        {member.name ? (
          <span className="text-fg-muted truncate text-xs">@{member.login}</span>
        ) : null}
      </span>
      {editable && member.role !== "owner" ? (
        <>
          <Select
            size="sm"
            label={`Role of ${name}`}
            value={member.role}
            options={ROLE_OPTIONS}
            disabled={setRole.isPending}
            onChange={(role) =>
              setRole.mutate(
                { treeId, userId: member.userId, role: role as MemberRole },
                { onError: (error) => pushErrorToast("Couldn’t change the role", error) },
              )
            }
          />
          <ControlButton
            size="sm"
            aria-label={`Remove ${name}`}
            disabled={remove.isPending}
            onClick={() =>
              remove.mutate(
                { treeId, userId: member.userId },
                {
                  onSuccess: onRemoved,
                  onError: (error) => pushErrorToast("Couldn’t remove them", error),
                },
              )
            }
          >
            Remove
          </ControlButton>
        </>
      ) : (
        <span className="text-fg-muted shrink-0 text-sm" data-share-role={member.role}>
          {ROLE_LABELS[member.role]}
        </span>
      )}
    </li>
  );
}

function InviteForm({ treeId }: { treeId: string }) {
  const create = useCreateThreadInvite();
  const [login, setLogin] = useState("");
  const [role, setRole] = useState<MemberRole>("commenter");
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const inputId = useId();

  const invite = (event: FormEvent) => {
    event.preventDefault();
    const githubLogin = login.trim().replace(/^@/, "");
    if (!githubLogin || create.isPending) return;
    setError(null);
    create.mutate(
      { treeId, role, githubLogin },
      {
        onSuccess: () => {
          setLogin("");
          pushToast({ title: `Invited @${githubLogin}.`, tone: "success" });
        },
        onError: (failure) => setError(errorText(failure)),
      },
    );
  };

  const copyLink = () => {
    if (create.isPending) return;
    setError(null);
    create.mutate(
      { treeId, role },
      {
        onSuccess: (created) => {
          setLink(created.url);
          writeClipboardText(created.url)
            .then(() => pushToast({ title: "Invite link copied.", tone: "success" }))
            .catch(() => pushToast({ title: "Couldn't copy. Copy the link below.", tone: "info" }));
        },
        onError: (failure) => setError(errorText(failure)),
      },
    );
  };

  return (
    <div className="flex flex-col gap-2">
      <form className="flex items-center gap-2" onSubmit={invite}>
        <label htmlFor={inputId} className="sr-only">
          GitHub username
        </label>
        <input
          id={inputId}
          className={cn(INPUT_FIELD, "min-w-0 flex-1")}
          placeholder="GitHub username"
          autoComplete="off"
          spellCheck={false}
          value={login}
          onChange={(event) => setLogin(event.target.value)}
        />
        <Select
          label="Role for the invitation"
          value={role}
          options={ROLE_OPTIONS}
          onChange={(value) => setRole(value as MemberRole)}
        />
        <ControlButton type="submit" disabled={!login.trim() || create.isPending}>
          Invite
        </ControlButton>
      </form>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className={cn(CONTROL_BUTTON, CONTROL_BUTTON_SIZE.sm, "gap-1.5")}
          disabled={create.isPending}
          onClick={copyLink}
        >
          <LinkIcon size={13} aria-hidden="true" />
          Copy invite link
        </button>
        <span className="text-fg-muted text-xs">
          Anyone with the link can join as {role === "commenter" ? "a commenter" : "a viewer"}.
        </span>
      </div>
      {link ? (
        <input
          className={cn(INPUT_FIELD, "text-fg-secondary text-xs")}
          aria-label="Invite link"
          readOnly
          value={link}
          onFocus={(event) => event.currentTarget.select()}
        />
      ) : null}
      {error ? (
        <p className="text-status-failed m-0 text-sm" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function InviteRow({ invite }: { invite: ThreadInvite }) {
  const revoke = useRevokeThreadInvite();
  const label = invite.githubLogin ? `@${invite.githubLogin}` : "Invite link";
  return (
    <li className="flex min-h-9 items-center gap-2 py-1" data-share-invite={invite.id}>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-fg-primary truncate text-sm">{label}</span>
        <span className="text-fg-muted text-xs">
          {ROLE_LABELS[invite.role]} · {expiryText(invite.expiresAt)}
        </span>
      </span>
      <ControlButton
        size="sm"
        aria-label={`Revoke ${label}`}
        disabled={revoke.isPending}
        onClick={() =>
          revoke.mutate(invite, {
            onError: (error) => pushErrorToast("Couldn’t revoke the invitation", error),
          })
        }
      >
        Revoke
      </ControlButton>
    </li>
  );
}

export function ShareDialog({
  tree,
  meId,
  onClose,
  onLeft,
}: {
  tree: Pick<ResearchTree, "id" | "title" | "visibility" | "role">;
  meId: string | null;
  onClose: () => void;
  /** After the reader left the thread. */
  onLeft: () => void;
}) {
  const owner = (tree.role ?? "owner") === "owner";
  const members = useThreadMembers(tree.id);
  const invites = useThreadInvites(tree.id, owner);
  const leave = useLeaveThread();
  const [confirmingLeave, setConfirmingLeave] = useState(false);
  const list = members.data ?? [];
  const member = !owner && list.some((entry) => entry.userId === meId && entry.role !== "owner");
  const pending = invites.data ?? [];
  // A removed member cannot rejoin through a link created before the
  // removal, but anyone else holding it still can.
  const pendingLinks = pending.some((invite) => invite.githubLogin === null);
  const [removedWithLinks, setRemovedWithLinks] = useState(false);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Share “${tree.title}”`}
      className="w-[min(520px,calc(100vw-32px))]"
      footer={
        confirmingLeave ? (
          <>
            <span className="text-fg-secondary mr-auto self-center text-sm">
              Leave this thread? You can come back only with a new invitation.
            </span>
            <ControlButton onClick={() => setConfirmingLeave(false)}>Cancel</ControlButton>
            <ControlButton
              tone="danger"
              disabled={leave.isPending}
              onClick={() =>
                leave.mutate(tree.id, {
                  onSuccess: () => {
                    onClose();
                    onLeft();
                  },
                  onError: (error) => pushErrorToast("Couldn’t leave the thread", error),
                })
              }
            >
              Leave
            </ControlButton>
          </>
        ) : (
          <>
            {member ? (
              <ControlButton
                tone="danger"
                className="mr-auto"
                onClick={() => setConfirmingLeave(true)}
              >
                Leave…
              </ControlButton>
            ) : null}
            <BaseDialog.Close className={cn(CONTROL_BUTTON, CONTROL_BUTTON_SIZE.md)}>
              Done
            </BaseDialog.Close>
          </>
        )
      }
    >
      <div className="flex flex-col gap-5" data-share-dialog="">
        <section aria-label="Who can read it">
          <SectionHeading>Who can read it</SectionHeading>
          <Visibility tree={tree} editable={owner} />
        </section>
        <section aria-label="People">
          <SectionHeading>People</SectionHeading>
          {members.isError ? (
            <p className="text-fg-muted m-0 text-sm" role="alert">
              The people couldn’t be loaded.
            </p>
          ) : (
            <ul className="m-0 list-none p-0" aria-label="People with access">
              {list.map((entry) => (
                <MemberRow
                  key={entry.userId}
                  treeId={tree.id}
                  member={entry}
                  meId={meId}
                  editable={owner}
                  onRemoved={() => setRemovedWithLinks(pendingLinks)}
                />
              ))}
            </ul>
          )}
          {removedWithLinks && pendingLinks ? (
            <p className="text-fg-muted m-0 mt-1.5 text-xs" role="status" data-share-link-notice="">
              Links you’ve shared still let new people join; revoke them to stop that.
            </p>
          ) : null}
        </section>
        {owner ? (
          <section aria-label="Invite">
            <SectionHeading>Invite</SectionHeading>
            <InviteForm treeId={tree.id} />
          </section>
        ) : null}
        {owner && pending.length > 0 ? (
          <section aria-label="Pending invitations">
            <SectionHeading>Pending invitations</SectionHeading>
            <ul className="m-0 list-none p-0">
              {pending.map((invite) => (
                <InviteRow key={invite.id} invite={invite} />
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </Dialog>
  );
}
