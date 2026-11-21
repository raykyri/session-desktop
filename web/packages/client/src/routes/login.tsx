import { useSearch } from "@tanstack/react-router";
import { useEffect } from "react";

import { AuthSteps } from "../features/auth/AuthDialog.js";
import { useAuthDialog } from "../features/auth/authDialog.js";

/**
 * The sign-in page (`/login`), outside the shell: the auth dialog's steps
 * (02 W7.2) on a page of their own. Signed-in-only routes send a signed-out
 * visitor here with `redirect`, and the OAuth callback sends its refusals
 * here as `?error=<reason>` (`server/src/auth/routes.ts:signInError`); the
 * reasons below are the complete set that file emits. A provider without
 * credentials answers the start with 503, which the explain step reports.
 */
const SIGN_IN_ERRORS: Readonly<Record<string, string>> = {
  not_allowed: "This GitHub account is not authorized to access this Session instance.",
  too_many_accounts: "Too many new accounts were made from your network today. Try again tomorrow.",
  cancelled: "Sign-in was cancelled.",
  expired_state: "The sign-in attempt timed out. Try again.",
  missing_code: "The provider did not complete the sign-in. Try again.",
  exchange_failed: "Sign-in could not be completed. Please try again.",
  profile_failed: "Could not retrieve your account profile. Please try again.",
};

export function LoginPage() {
  const search = useSearch({ from: "/login" });
  const message = search.error ? SIGN_IN_ERRORS[search.error] : undefined;
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
