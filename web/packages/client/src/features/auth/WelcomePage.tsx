// "Invite required" (02 W7.3, the mockup's `statusPage`): the screen of a
// signed-in account without an invite. It reads like a signed-out reader;
// this page takes a code or link, and a code that checks open goes on to the
// profile step in the auth dialog, which redeems it.

import { UNUSABLE_INVITE_MESSAGE, parseInviteCode } from "@session/shared";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { FormEvent } from "react";
import { useEffect, useState } from "react";

import { useMe } from "../../api/account.js";
import { redeemInvite } from "../../api/membership.js";
import { trpcErrorCode } from "../../lib/toast.js";
import { PageFrame } from "../shell/Frames.js";
import { CheckIcon } from "../shell/icons.js";

import { EMPTY_CODE_MESSAGE } from "./AuthDialog.js";
import { openAuthDialog } from "./authDialog.js";

export function WelcomePage() {
  const me = useMe().data ?? null;
  const navigate = useNavigate();
  const search = useSearch({ from: "/_shell/welcome" });
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // Arriving from a sign-in that made a waiting account: the "No Session
  // account" step, once; the marker leaves the address.
  useEffect(() => {
    if (search.new !== true) return;
    openAuthDialog({ step: "noaccount", origin: "welcome" });
    void navigate({ to: "/welcome", search: {}, replace: true });
  }, [search.new, navigate]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    const typed = value.trim();
    if (typed === "") return setError(EMPTY_CODE_MESSAGE);
    setPending(true);
    setError(null);
    try {
      const check = await redeemInvite(parseInviteCode(typed) ?? typed);
      if (check.status === "open") {
        setValue("");
        openAuthDialog({ step: "profile", profileInviter: check.inviter, origin: "welcome" });
      } else {
        setError(UNUSABLE_INVITE_MESSAGE);
      }
    } catch (failure) {
      setError(
        trpcErrorCode(failure) === "TOO_MANY_REQUESTS"
          ? "Too many attempts. Wait a while and try again."
          : UNUSABLE_INVITE_MESSAGE,
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <PageFrame title="Invite required" narrow>
      <div className="pend-a">
        <p className="lede">
          You&apos;re signed in as @{me?.handle ?? me?.login ?? ""}, but Session is invite-only.
          Enter a code or link from a member to start asking and posting.
        </p>
        <form className="code-f" onSubmit={(event) => void submit(event)} noValidate>
          <input
            value={value}
            onChange={(event) => setValue(event.currentTarget.value)}
            placeholder="SESS-XXXX-XX"
            autoComplete="off"
            spellCheck={false}
            aria-label="Invite code"
            aria-invalid={error ? true : undefined}
          />
          <button type="submit" className="btn1" disabled={pending}>
            Use code
          </button>
        </form>
        {error ? (
          <p className="ferr" role="alert">
            {error}
          </p>
        ) : null}
        <div className="pcard">
          <ul className="checks">
            <li className="ok">
              <CheckIcon />
              Read every open channel and its branches
            </li>
            <li>
              <span className="ring" />
              Ask, post, branch and reply
            </li>
            <li>
              <span className="ring" />
              Invite people
            </li>
          </ul>
        </div>
        <div className="auth-acts">
          <button type="button" className="btn2" onClick={() => void navigate({ to: "/" })}>
            Browse the network
          </button>
        </div>
      </div>
    </PageFrame>
  );
}
