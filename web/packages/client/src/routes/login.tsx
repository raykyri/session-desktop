import { retryWaitText } from "@session/shared";
import { useSearch } from "@tanstack/react-router";
import { useEffect } from "react";

import { AuthSteps } from "../features/auth/AuthDialog.js";
import { useAuthDialog } from "../features/auth/authDialog.js";

/**
 * The sign-in page (`/login`), outside the shell: the auth dialog's steps
 * (02 W7.2) on a page of their own. Signed-in-only routes send a signed-out
 * visitor here with `redirect`, and the OAuth callback sends its refusals
 * here as `?error=<reason>` (`server/src/auth/routes.ts:signInError`), with
 * the provider (`provider`) or the wait in seconds (`wait`) where the
 * message names them; the reasons below are the complete set that file
 * emits. A provider without credentials answers the start's fetch with 503,
 * which the explain step reports, and a page under `/auth/` with
 * `unavailable`; the `/auth/*` limit answers a page with `rate_limited`.
 */
export function signInErrorMessage(
  error: string,
  { provider, wait }: { provider?: string | undefined; wait?: number | undefined } = {},
): string | undefined {
  const name = provider === "x" ? "X" : provider === "github" ? "GitHub" : null;
  switch (error) {
    case "not_allowed":
      return "This GitHub account doesn't have access to Session. Ask whoever runs this site to add it.";
    case "too_many_accounts":
      return "Too many new accounts from your network today. Try again tomorrow.";
    case "cancelled":
      return "Sign-in was cancelled.";
    case "expired_state":
      return "Sign-in didn't finish. Try again from this page.";
    case "missing_code":
      return `${name ?? "The sign-in service"} didn't finish signing you in. Try again.`;
    case "exchange_failed":
      return "Sign-in could not be completed. Try again.";
    case "profile_failed":
      return name === null
        ? "Couldn't get your profile. Try again."
        : `Couldn't get your profile from ${name}. Try again.`;
    case "unavailable":
      return name === null
        ? "Sign-in is not available right now. Try again later."
        : `Sign-in with ${name} is not available right now. Try again later.`;
    case "rate_limited":
      return wait === undefined
        ? "Too many sign-in attempts. Try again in a few minutes."
        : `Too many sign-in attempts. Try again in ${retryWaitText(wait)}.`;
    default:
      return undefined;
  }
}

export function LoginPage() {
  const search = useSearch({ from: "/login" });
  const message = search.error ? signInErrorMessage(search.error, search) : undefined;
  const show = useAuthDialog((state) => state.set);

  useEffect(() => {
    show({ step: "landing", link: null, redeem: false });
  }, [show]);

  return (
    <div className="bg-surface-workspace h-full w-full overflow-y-auto">
      <div className="auth-page">
        <div className="flex w-full max-w-[420px] flex-col gap-4">
          {search.error ? (
            <p role="alert" className="ferr m-0">
              {message ?? "Sign-in did not complete. Try again."}
            </p>
          ) : null}
          <AuthSteps headingId="login-step-h" returnTo={search.redirect ?? "/"} />
        </div>
      </div>
    </div>
  );
}
