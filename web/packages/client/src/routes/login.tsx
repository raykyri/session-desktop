import { useSearch } from "@tanstack/react-router";

import { startGitHubSignIn } from "../api/api.js";
import { ControlButton } from "../ui/Button.js";
import { GitHubMark } from "../ui/GitHubMark.js";

/**
 * The sign-in shell (07 §3). GitHub OAuth is the only way in (ADR-5), so the
 * page is one button plus the refusals the server can report.
 *
 * Those refusals arrive as `?error=<reason>` on a redirect back to this route
 * (`server/src/auth/github.ts:signInError`); the reasons below are the
 * complete set that file emits. A deployment with no GitHub credentials
 * answers `/auth/github` with a 503 page rather than a redirect, so "signups
 * are closed" has no query parameter to read and is not rendered here.
 *
 * It renders outside `AppShell`: there is no sidebar, no stage header and no
 * subscription before a session exists.
 */
const SIGN_IN_ERRORS: Readonly<Record<string, string>> = {
  not_allowed: "This GitHub account is not authorized to access this Session instance.",
  invite_required:
    "An invite code is required to create an account. Please use the invitation link you received.",
  invite_invalid: "This invite code is invalid or has already been used.",
  expired_state: "The sign-in attempt timed out. Try again.",
  missing_code: "GitHub did not complete the sign-in. Try again.",
  exchange_failed: "GitHub sign-in could not be completed. Please try again.",
  profile_failed: "Could not retrieve your GitHub account profile. Please try again.",
};

export function LoginPage() {
  const search = useSearch({ from: "/login" });
  const message = search.error ? SIGN_IN_ERRORS[search.error] : undefined;

  return (
    <div className="bg-surface-workspace flex h-full w-full items-center justify-center px-6">
      <div className="flex w-[min(360px,100%)] flex-col items-center gap-6 text-center">
        <div className="flex flex-col gap-2">
          <h1 className="text-title text-fg-heading m-0 font-semibold">Session</h1>
          <p className="text-fg-secondary m-0 text-base">
            A research workspace. Sign in to get started.
          </p>
        </div>

        {search.error ? (
          <p role="alert" className="text-danger-muted m-0 text-base">
            {message ?? "Sign-in did not complete. Try again."}
          </p>
        ) : null}

        <ControlButton
          size="lg"
          className="w-full gap-2"
          onClick={() => startGitHubSignIn(search.redirect, search.invite)}
        >
          <GitHubMark />
          Continue with GitHub
        </ControlButton>
      </div>
    </div>
  );
}
