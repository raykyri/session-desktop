// New channel (02 W6.7; the mock's `newSpaceDlg`, `createSpace`): "Name"
// with a `#` prefix, checked against the shared validator; "What is it
// for?"; Open or Private; Cancel and "Create channel". Creating a space is
// online-only: the button is busy until the server answers; CONFLICT shows
// "#name already exists." and keeps the typed values; success goes to the
// new channel with the toast "#name is ready. Invite people by sharing its
// link."

import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { create } from "zustand";

import { useWrites } from "../../replica/writes.js";
import { FeedDialog } from "../feed/FeedDialog.js";
import { showToast } from "../shell/Toast.js";
import { CHANNEL_NAME } from "../shell/screens.js";

interface NewChannelState {
  open: boolean;
  setOpen: (open: boolean) => void;
}

/** Opened from the strip's New channel button and from Browse. */
export const useNewChannelDialog = create<NewChannelState>()((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

export const NAME_ERROR = "Use 2 to 30 lowercase letters, numbers or dashes.";

/** The name as typed, without `#`, lower-cased; or the validator's error. */
export function checkChannelName(raw: string): { name: string; error: string | null } {
  const name = raw.trim().toLowerCase().replace(/^#/, "");
  return { name, error: CHANNEL_NAME.test(name) ? null : NAME_ERROR };
}

export function NewChannelDialog({ online = true }: { online?: boolean }) {
  const { open, setOpen } = useNewChannelDialog();
  const writes = useWrites();
  const navigate = useNavigate();
  const nameField = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [vis, setVis] = useState<"open" | "private">("open");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setName("");
    setDesc("");
    setVis("open");
    setError("");
  };

  const submit = async () => {
    const checked = checkChannelName(name);
    setName(checked.name);
    if (checked.error) {
      setError(checked.error);
      nameField.current?.focus();
      return;
    }
    setBusy(true);
    const outcome = await writes.createChannel({ name: checked.name, desc: desc.trim(), vis });
    setBusy(false);
    if (!outcome.ok) {
      // the server's message for a refusal with a cause (a limit); a
      // request that got no answer says the channel was not created
      setError(
        outcome.error.code === "CONFLICT"
          ? `#${checked.name} already exists.`
          : outcome.error.code === "SERVICE_UNAVAILABLE"
            ? `Couldn't create #${checked.name}. Check your connection and try again.`
            : outcome.error.message,
      );
      nameField.current?.focus();
      return;
    }
    setOpen(false);
    reset();
    showToast(`#${checked.name} is ready. Invite people by sharing its link.`);
    void navigate({ to: "/c/$name", params: { name: checked.name }, search: {} });
  };

  return (
    <FeedDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
      labelledBy="ns-h"
      className="nsdlg"
      initialFocus={nameField}
    >
      <h3 id="ns-h">New channel</h3>
      <form
        className="pform"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label>
          Name
          <span className="hwrap">
            <span>#</span>
            <input
              ref={nameField}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "ns-err" : undefined}
              value={name}
              placeholder="reading-group"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setName(event.target.value)}
            />
          </span>
          <small>Lowercase letters, numbers and dashes.</small>
        </label>
        <label>
          What is it for?
          <textarea
            rows={2}
            value={desc}
            placeholder="One or two sentences shown at the top of the channel"
            onChange={(event) => setDesc(event.target.value)}
          />
        </label>
        <div className="nsvis" role="radiogroup" aria-label="Visibility">
          {(
            [
              ["open", "Open", "Anyone can read and join."],
              ["private", "Private", "Only people invited with a link can read or post."],
            ] as const
          ).map(([value, label, hint]) => (
            <label key={value} className="radio">
              <input
                type="radio"
                name="nsvis"
                value={value}
                checked={vis === value}
                onChange={() => setVis(value)}
              />{" "}
              <span>
                <b>{label}</b>
                <small>{hint}</small>
              </span>
            </label>
          ))}
        </div>
        {error ? (
          <p className="ferr" id="ns-err" role="alert">
            {error}
          </p>
        ) : null}
        {!online ? (
          <p className="ferr" role="status">
            Creating a channel needs a connection.
          </p>
        ) : null}
        <div className="dacts">
          <button type="button" className="btn2" onClick={() => setOpen(false)}>
            Cancel
          </button>
          <button type="submit" className="btn1" disabled={busy || !online} aria-busy={busy}>
            Create channel
          </button>
        </div>
      </form>
    </FeedDialog>
  );
}
