import { useSearch } from "@tanstack/react-router";

import { startGitHubSignIn } from "../api/api.js";
import { ControlButton } from "../ui/Button.js";

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

/** lucide-react dropped its brand icons in v1, so the GitHub mark is inlined
 * here rather than pulled from a second icon package for one glyph. */
function GitHubMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

export function LoginPage() {
  const search = useSearch({ from: "/login" });
  const message = search.error ? SIGN_IN_ERRORS[search.error] : undefined;

  return (
    <div className="bg-surface-workspace flex h-full w-full items-center justify-center px-6">
      <div className="flex w-[min(360px,100%)] flex-col items-center gap-6 text-center">
        <div className="flex flex-col gap-2">
          <h1 className="text-input text-fg-heading m-0 font-semibold">Session</h1>
          <p className="text-fg-secondary m-0 text-base">
            A research workspace. Sign in to start an investigation.
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
