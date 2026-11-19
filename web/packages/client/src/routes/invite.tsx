// A sign-up invite (phase 2a): `/invite?code=<code>` signs in with GitHub with
// the code, which the server redeems when it creates the account
// (`SESSION_REQUIRE_INVITE`). A signed-in account has no use for it.

import { Link, useSearch } from "@tanstack/react-router";

import { startGitHubSignIn, useMe } from "../api/account.js";
import { ControlButton } from "../ui/Button.js";

export function InvitePage() {
  const { code } = useSearch({ from: "/shell/invite" });
  const me = useMe();
  if (me.data)
    return (
      <div className="mx-auto max-w-xl px-6 py-12">
        <p className="m-0">
          You are signed in already.{" "}
          <Link to="/" className="text-fg-interactive">
            Go to Home
          </Link>
          .
        </p>
      </div>
    );
  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4 px-6 py-12">
      <h1 className="text-title text-fg-heading m-0 font-semibold">You are invited to Session</h1>
      {code ? (
        <ControlButton size="lg" onClick={() => startGitHubSignIn("/", code)}>
          Sign up with GitHub
        </ControlButton>
      ) : (
        <p role="alert" className="text-danger-muted m-0">
          This link has no sign-up code. Open the link you received.
        </p>
      )}
    </div>
  );
}
