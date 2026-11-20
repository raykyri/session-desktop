// The shell's pages from phase 2a (settings, admin, a sign-up invite) under
// the spaces header, in the older design (`.shell-legacy` scopes its tokens)
// until the Account slice replaces them.

import { Link, Outlet, useNavigate } from "@tanstack/react-router";

import { useLogout, useMe } from "../../api/account.js";
import { Page } from "../../spaces/Page.js";
import { ControlButton } from "../../ui/Button.js";

export function AppShell() {
  const me = useMe();
  const logout = useLogout();
  const navigate = useNavigate();
  const user = me.data ?? null;
  return (
    <Page place={{ kind: "other", label: "Account" }}>
      <div className="shell-legacy bg-bg text-fg flex min-h-screen flex-col">
        <header className="border-border flex items-center gap-4 border-b px-4 py-2">
          <nav className="flex flex-1 items-center gap-3 text-sm">
            {user ? (
              <>
                <Link to="/settings" className="text-fg-interactive">
                  Settings
                </Link>
                {user.isAdmin ? (
                  <Link to="/admin" className="text-fg-interactive">
                    Admin
                  </Link>
                ) : null}
              </>
            ) : null}
          </nav>
          {user ? (
            <ControlButton
              onClick={() =>
                logout.mutate(undefined, { onSuccess: () => void navigate({ to: "/login" }) })
              }
            >
              Sign out
            </ControlButton>
          ) : (
            <Link to="/login" className="text-fg-interactive">
              Sign in
            </Link>
          )}
        </header>
        <main className="flex-1">
          <Outlet />
        </main>
      </div>
    </Page>
  );
}
