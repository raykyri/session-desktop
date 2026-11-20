// The administrator view (07 §3): who has an account, what they used this
// week, and the two levers an administrator has — a person's own weekly
// allowance of included tokens (or the deployment's default) and sign-up codes
// (a code lets one new account in). There are no daily limits.
//
// The page is rendered only for an administrator. That is a courtesy, not the
// control: every route behind it (`/api/admin/*`) answers FORBIDDEN to anyone
// else, whatever the client chooses to show (`06-auth-and-users.md` §8).

import { modelsFor } from "@session/shared";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { useAdminUsers, useCreateInvites, useMe, useSetUserLimits } from "../api/account.js";
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

/**
 * What the account may launch: the registry filtered by the admin flag
 * (`04-agent-runtime.md` §1). Derived here from the row's own `isAdmin`
 * rather than sent by `admin.listUsers`, because the gate is a pure function
 * of that flag and a second copy on the wire could disagree with the one the
 * server enforces at admission.
 */
function modelAccess(user: { isAdmin: boolean }): string {
  return modelsFor(user)
    .map((model) => model.label)
    .join(", ");
}

/** A person's weekly allowance: a number of tokens, or empty for the
 * deployment's default. */
function AllowanceCell({
  login,
  value,
  fallback,
  onSave,
}: {
  login: string;
  value: number | null;
  fallback: number;
  onSave: (next: number | null) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (value === null ? "" : String(value));
  return (
    <input
      aria-label={`Weekly allowance for ${login}`}
      className="border-border-divider bg-surface-input min-h-control-sm w-28 rounded-md border px-2 text-sm"
      inputMode="numeric"
      placeholder={`default (${formatTokens(fallback)})`}
      value={shown}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={() => {
        if (draft === null) return;
        const trimmed = draft.trim().toLowerCase();
        const next = trimmed === "" || trimmed === "default" ? null : Number(trimmed);
        setDraft(null);
        // A typo must not become an allowance of `NaN`; the field reverts.
        if (next !== null && (!Number.isInteger(next) || next < 0)) return;
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
        <h1 className="text-title text-fg-heading m-0 font-semibold">Admin</h1>
        <p className="max-w-feed text-fg-muted mt-3 text-base">
          You must be an administrator to access this page.{" "}
          <Link to="/" className="text-fg-interactive">
            Back to Home
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto px-8 py-10">
      <div className="mx-auto flex w-[min(880px,100%)] flex-col gap-8">
        <h1 className="text-title text-fg-heading m-0 font-semibold">Admin</h1>

        <section className="flex flex-col gap-3">
          <h2 className="text-fg-heading m-0 text-base font-semibold">Accounts</h2>
          {users.status === "loading" ? <p className="text-fg-muted m-0 text-base">Loading…</p> : null}
          {users.data ? (
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="text-fg-muted text-left">
                  <th scope="col" className="py-1 font-medium">
                    Account
                  </th>
                  <th scope="col" className="py-1 font-medium">
                    Model access
                  </th>
                  <th scope="col" className="py-1 font-medium">
                    Runs this week
                  </th>
                  <th scope="col" className="py-1 font-medium">
                    Tokens this week
                  </th>
                  <th scope="col" className="py-1 font-medium">
                    Cost
                  </th>
                  <th scope="col" className="py-1 font-medium">
                    Included tokens this week
                  </th>
                  <th scope="col" className="py-1 font-medium">
                    Weekly allowance
                  </th>
                </tr>
              </thead>
              <tbody>
                {users.data.map((user) => {
                  // `reasoningTokens` is included in `outputTokens`; excluding it
                  // from this sum prevents double-counting.
                  const tokens = user.usage.inputTokens + user.usage.outputTokens;
                  return (
                    <tr key={user.id} className="border-border-divider border-t">
                      <td className="py-1.5">
                        {user.login}
                        {user.isAdmin ? <span className="text-fg-muted"> · admin</span> : null}
                      </td>
                      <td className="py-1.5">
                        {/* The full list is the title: five labels is wider
                            than the column, and the gated one is what an
                            administrator is looking for. */}
                        <span
                          className="text-fg-muted block max-w-60 truncate"
                          title={modelAccess(user)}
                        >
                          {modelAccess(user)}
                        </span>
                      </td>
                      <td className="py-1.5">{user.usage.runs}</td>
                      <td className="py-1.5">{formatTokens(tokens)}</td>
                      <td className="py-1.5">{formatCost(user.usage.costEstimateMicros)}</td>
                      <td className="py-1.5">
                        {formatTokens(user.allowance.used)} of{" "}
                        {formatTokens(user.allowance.weeklyTokens ?? user.allowance.defaultTokens)}
                      </td>
                      <td className="py-1.5">
                        <AllowanceCell
                          login={user.login}
                          value={user.allowance.weeklyTokens}
                          fallback={user.allowance.defaultTokens}
                          onSave={(weeklyTokens) => setLimits.mutate({ userId: user.id, weeklyTokens })}
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
          <h2 className="text-fg-heading m-0 text-base font-semibold">Sign-up codes</h2>
          <Field
            label="Number of codes"
            hint="Each code creates one account. Codes are shown once; copy them before leaving."
          >
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
                    createInvites.mutate({ count });
                  }}
                >
                  Create codes
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
