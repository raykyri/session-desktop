// Site Admin's Invites section (02 W8.2; 04 I2): a site admin looks up a
// member's account invites by handle and gives them more. Each member's total
// is `SESSION_INVITES_PER_MEMBER` plus what admins gave them; the line after
// a lookup shows that total, extras included. Online-only
// (`admin.invites.lookup`, `admin.invites.grant`); a refusal shows the
// server's message under its form.

import { INVITE_GRANT_MAX, inviteAllowanceLine, inviteGrantToast } from "@session/shared";
import { useState, type FormEvent } from "react";

import { useGrantInvites, useLookupInvites, type InviteLookup } from "../../api/account.js";
import { refusalMessage } from "../../lib/toast.js";
import { showToast } from "../shell/Toast.js";

const COUNT_RANGE = `Enter a whole number from 1 to ${INVITE_GRANT_MAX}.`;

export function InviteGrants() {
  const lookup = useLookupInvites();
  const grant = useGrantInvites();
  const [handle, setHandle] = useState("");
  const [count, setCount] = useState("1");
  const [member, setMember] = useState<InviteLookup | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [grantError, setGrantError] = useState<string | null>(null);

  const submitLookup = (event: FormEvent) => {
    event.preventDefault();
    setLookupError(null);
    setGrantError(null);
    lookup.mutate(handle, {
      onSuccess: (found) => setMember(found),
      onError: (error) => {
        setMember(null);
        setLookupError(refusalMessage(error));
      },
    });
  };

  const submitGrant = (event: FormEvent) => {
    event.preventDefault();
    // one grant at a time: a second press while one is in flight would give twice
    if (member === null || grant.isPending) return;
    const value = Number(count);
    if (!/^\d+$/.test(count.trim()) || value < 1 || value > INVITE_GRANT_MAX) {
      setGrantError(COUNT_RANGE);
      return;
    }
    setGrantError(null);
    grant.mutate(
      { handle: member.handle, count: value },
      {
        onSuccess: (after) => {
          setMember(after);
          showToast(inviteGrantToast(after.handle, value));
        },
        onError: (error) => setGrantError(refusalMessage(error)),
      },
    );
  };

  return (
    <section className="box adm" aria-labelledby="adm-invites">
      <h3 id="adm-invites">Invites</h3>
      <form className="kform" onSubmit={submitLookup} noValidate>
        <input
          value={handle}
          onChange={(event) => setHandle(event.currentTarget.value)}
          placeholder="Handle"
          aria-label="Handle"
          autoComplete="off"
          spellCheck={false}
          maxLength={64}
          aria-invalid={lookupError ? true : undefined}
        />
        <button type="submit" className="btn2 sm" aria-busy={lookup.isPending || undefined}>
          Look up
        </button>
      </form>
      {lookupError ? (
        <p className="ferr mt-2" role="alert">
          {lookupError}
        </p>
      ) : null}
      {member ? (
        <>
          <p className="ainv" role="status">
            {inviteAllowanceLine(member)}
          </p>
          <form className="kform" onSubmit={submitGrant} noValidate>
            <input
              type="number"
              min={1}
              max={INVITE_GRANT_MAX}
              step={1}
              value={count}
              onChange={(event) => setCount(event.currentTarget.value)}
              aria-label="Number of invites"
              aria-invalid={grantError ? true : undefined}
            />
            <button type="submit" className="btn1 sm" aria-busy={grant.isPending || undefined}>
              Give invites
            </button>
          </form>
          {grantError ? (
            <p className="ferr mt-2" role="alert">
              {grantError}
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
