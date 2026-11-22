// The owner's confirmation of a ban or a removal (02 W6.8, 04 §6.4): an
// `alertdialog` naming the person and the channel, with Cancel and the
// action, as thread removal asks first (W6.5). Neither write takes a reason
// (`members.ban`, `members.remove`), so the dialog has no field. Focus starts
// on Cancel (02 §10.1).

import { AlertDialog } from "@base-ui/react/alert-dialog";

export type MemberAction = "ban" | "remove";

/** The confirmation's heading. */
export function memberActionTitle(action: MemberAction, user: string, channel: string): string {
  return action === "ban" ? `Ban @${user} from #${channel}?` : `Remove @${user} from #${channel}?`;
}

/** What the action does, in one or two sentences. */
export function memberActionText(
  action: MemberAction,
  user: string,
  channel: { name: string; private: boolean },
): string {
  if (action === "remove")
    return `@${user} stops being a member of #${channel.name} and can no longer read it. A new invite link lets them join again.`;
  return channel.private
    ? `@${user} is removed from #${channel.name} and can't read it, write in it or join it again with a link. You can unban them in the member list.`
    : `@${user} can no longer write in #${channel.name} or join it. Anyone can still read an open channel. You can unban them in the member list.`;
}

export function ConfirmMemberAction({
  action,
  user,
  channel,
  open,
  onOpenChange,
  onConfirm,
}: {
  action: MemberAction;
  user: string;
  channel: { name: string; private: boolean };
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fscrim mact-scrim" />
        <AlertDialog.Popup className="fdialog mactdlg" aria-labelledby="mact-h">
          <h3 id="mact-h">{memberActionTitle(action, user, channel.name)}</h3>
          <p>{memberActionText(action, user, channel)}</p>
          <div className="dacts">
            <AlertDialog.Close className="btn2">Cancel</AlertDialog.Close>
            <button
              type="button"
              className="btn1 danger"
              onClick={() => {
                onOpenChange(false);
                onConfirm();
              }}
            >
              {action === "ban" ? "Ban" : "Remove"}
            </button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
