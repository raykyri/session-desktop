// The administrator view (07 §3): who has an account, what they used today,
// and the two levers an administrator has — per-account daily limits and
// invite codes.
//
// The page is rendered only for an administrator. That is a courtesy, not the
// control: every procedure behind it is an `adminProcedure`, which answers
// `FORBIDDEN` whatever the client chooses to show (`06-auth-and-users.md` §8).

import { useState } from "react";

import { useAdminUsers, useCreateInvites, useMe, useSetUserLimits } from "../api/queries.js";
import { ControlButton } from "../ui/Button.js";
import { Field, Input } from "../ui/Field.js";

function formatTokens(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}

/** `costEstimateMicros` is millionths of a dollar. */
function formatCost(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(2)}`;
}

function LimitCell({
  userId,
  label,
  value,
  onSave,
}: {
  userId: string;
  label: string;
  value: number | null;
  onSave: (next: number | null) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (value === null ? "" : String(value));
  return (
    <input
      aria-label={`${label} for ${userId}`}
      className="border-border-divider bg-surface-input min-h-control-sm w-24 rounded-md border px-2 text-sm"
      inputMode="numeric"
      value={shown}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={() => {
        if (draft === null) return;
        const trimmed = draft.trim();
        const next = trimmed === "" ? null : Number(trimmed);
        setDraft(null);
        // A typo must not become a limit of `NaN`; the field simply reverts.
        if (next !== null && !Number.isInteger(next)) return;
        if (next === value) return;
        onSave(next);
      }}
    />
  );
}

export function AdminPage() {
  const me = useMe();
  const isAdmin = me.data?.isAdmin === true;
  const users = useAdminUsers(isAdmin);
  const setLimits = useSetUserLimits();
  const createInvites = useCreateInvites();
  const [inviteCount, setInviteCount] = useState("5");

  if (!isAdmin) {
    return (
      <div className="research-reading-surface h-full overflow-y-auto px-8 py-10">
        <h1 className="text-input text-fg-heading m-0 font-semibold">Admin</h1>
        <p className="max-w-feed text-fg-muted mt-3 text-base">This page is for administrators.</p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto px-8 py-10">
      <div className="mx-auto flex w-[min(880px,100%)] flex-col gap-8">
        <h1 className="text-input text-fg-heading m-0 font-semibold">Admin</h1>

        <section className="flex flex-col gap-3">
          <h2 className="text-fg-heading m-0 text-base font-semibold">Accounts</h2>
          {users.isLoading ? <p className="text-fg-muted m-0 text-base">Loading…</p> : null}
          {users.data ? (
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="text-fg-muted text-left">
                  <th scope="col" className="py-1 font-medium">
                    Account
                  </th>
                  <th scope="col" className="py-1 font-medium">
                    Runs today
                  </th>
                  <th scope="col" className="py-1 font-medium">
                    Tokens today
                  </th>
                  <th scope="col" className="py-1 font-medium">
                    Cost
                  </th>
                  <th scope="col" className="py-1 font-medium">
                    Daily tokens
                  </th>
                  <th scope="col" className="py-1 font-medium">
                    Daily runs
                  </th>
                </tr>
              </thead>
              <tbody>
                {users.data.map((user) => {
                  const tokens =
                    user.usage.inputTokens + user.usage.outputTokens + user.usage.reasoningTokens;
                  return (
                    <tr key={user.id} className="border-border-divider border-t">
                      <td className="py-1.5">
                        {user.login}
                        {user.isAdmin ? <span className="text-fg-muted"> · admin</span> : null}
                      </td>
                      <td className="py-1.5">{user.usage.runs}</td>
                      <td className="py-1.5">{formatTokens(tokens)}</td>
                      <td className="py-1.5">{formatCost(user.usage.costEstimateMicros)}</td>
                      <td className="py-1.5">
                        <LimitCell
                          userId={user.login}
                          label="Daily tokens"
                          value={user.limits.dailyTokens}
                          onSave={(dailyTokens) =>
                            setLimits.mutate({ userId: user.id, dailyTokens })
                          }
                        />
                      </td>
                      <td className="py-1.5">
                        <LimitCell
                          userId={user.login}
                          label="Daily runs"
                          value={user.limits.dailyRuns}
                          onSave={(dailyRuns) => setLimits.mutate({ userId: user.id, dailyRuns })}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : null}
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-fg-heading m-0 text-base font-semibold">Invites</h2>
          <Field label="How many" hint="Codes are shown once; copy them before leaving.">
            {({ id, describedBy }) => (
              <div className="flex items-center gap-2">
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  inputMode="numeric"
                  className="w-24"
                  value={inviteCount}
                  onChange={(event) => setInviteCount(event.currentTarget.value)}
                />
                <ControlButton
                  disabled={createInvites.isPending}
                  onClick={() => {
                    const count = Number(inviteCount.trim());
                    if (!Number.isInteger(count) || count < 1) return;
                    createInvites.mutate(count);
                  }}
                >
                  Create invites
                </ControlButton>
              </div>
            )}
          </Field>
          {createInvites.data ? (
            <ul className="text-fg-secondary m-0 flex list-none flex-col gap-1 p-0 font-mono text-sm">
              {createInvites.data.codes.map((code) => (
                <li key={code}>{code}</li>
              ))}
            </ul>
          ) : null}
        </section>
      </div>
    </div>
  );
}
