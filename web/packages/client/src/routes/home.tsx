// Home, a placeholder (phase 2a): the spaces client (phase 2b) replaces it.

import { Link } from "@tanstack/react-router";

import { useMe } from "../api/account.js";

export function HomePage() {
  const me = useMe();
  const user = me.data ?? null;
  return (
    <div className="mx-auto flex max-w-xl flex-col gap-3 px-6 py-12">
      <h1 className="text-title text-fg-heading m-0 font-semibold">Session</h1>
      {user ? (
        <p className="text-fg-secondary m-0">
          Signed in as {user.handle}. Spaces open here in the next version of the web app.
        </p>
      ) : (
        <p className="text-fg-secondary m-0">
          <Link to="/login" className="text-fg-interactive">
            Sign in
          </Link>{" "}
          to use Session.
        </p>
      )}
    </div>
  );
}
