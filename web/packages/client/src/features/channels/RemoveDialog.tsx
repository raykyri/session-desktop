// Remove a thread, for the channel's owner (02 W6.5; the mock's `rmDlg`):
// "Remove @x's ask" (or "post") with Close; the title in quotes, clipped at
// 120; an optional reason shown with the removal (at most 300 characters);
// what removal does; Cancel and Remove. Remove writes `moderation.decide`
// and shows "Removed."; focus starts in the reason field.

import { Dialog } from "@base-ui/react/dialog";
import type { ThreadRec } from "@session/mutators";
import { useRef, useState } from "react";

import { useWrites } from "../../replica/writes.js";
import { FeedDialog } from "../feed/FeedDialog.js";
import { clip } from "../feed/format.js";
import { CloseIcon } from "../feed/icons.js";
import { showToast } from "../shell/Toast.js";

export const NOTE_MAX = 300;

export function RemoveDialog({
  thread,
  open,
  onOpenChange,
}: {
  thread: ThreadRec;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const writes = useWrites();
  const field = useRef<HTMLTextAreaElement>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const what = thread.k === "post" ? "post" : "ask";
  const author = thread.u ?? "";

  const busy = useRef(false);
  const [sending, setSending] = useState(false);
  const remove = async () => {
    const reason = note.trim();
    if (reason.length > NOTE_MAX) {
      // as the app's other forms: the error is announced and focus goes back
      // to the field it is about
      setError(`Keep the reason under ${NOTE_MAX} characters.`);
      field.current?.focus();
      return;
    }
    if (busy.current) return;
    busy.current = true;
    setSending(true);
    const outcome = await writes.send("moderation.decide", {
      item: `${thread.k === "post" ? "p" : "a"}:${thread.id}`,
      decision: "removed",
      ...(reason ? { note: reason } : {}),
    });
    busy.current = false;
    setSending(false);
    if (!outcome.ok) return;
    onOpenChange(false);
    setNote("");
    showToast("Removed.");
  };

  return (
    <FeedDialog
      open={open}
      onOpenChange={onOpenChange}
      labelledBy="rm-h"
      className="chdlg rmdlg"
      initialFocus={field}
    >
      <div className="chdlg-h">
        <h3 id="rm-h">
          Remove @{author}&apos;s {what}
        </h3>
        <Dialog.Close className="ibtn" aria-label="Close">
          <CloseIcon />
        </Dialog.Close>
      </div>
      <p>“{clip(thread.q, 120)}”</p>
      <form
        className="pform"
        onSubmit={(event) => {
          event.preventDefault();
          void remove();
        }}
      >
        <label>
          Reason, shown with the removal{" "}
          <textarea
            ref={field}
            rows={2}
            placeholder="Optional"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "rm-note-err" : undefined}
            value={note}
            onChange={(event) => {
              setNote(event.target.value);
              setError("");
            }}
          />
        </label>
        <p className="cefine">
          Readers see that it was removed. Branches and replies under it go with it. @{author} is
          notified, with the reason.
        </p>
        {error ? (
          <p id="rm-note-err" className="ferr" role="alert">
            {error}
          </p>
        ) : null}
        <div className="dacts">
          <button type="button" className="btn2" onClick={() => onOpenChange(false)}>
            Cancel
          </button>
          <button type="submit" className="btn1 danger" disabled={sending} aria-busy={sending}>
            Remove
          </button>
        </div>
      </form>
    </FeedDialog>
  );
}
