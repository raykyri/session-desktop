// The application frame of the shell (phase 2a): a header with the signed-in
// account's places (Home, Settings, Admin for an administrator) and Sign out,
// the routed view, and the toast region. Phase 2b replaces Home with the
// spaces client.

import { Link, Outlet, useNavigate } from "@tanstack/react-router";

import { useLogout, useMe } from "../../api/account.js";
import { ControlButton } from "../../ui/Button.js";
import { NotificationStack } from "../../ui/NotificationStack.js";
import { useUserNotifications } from "../../ui/useUserNotifications.js";
import { SessionBoot } from "../SessionBoot.js";

export function AppShell() {
  const me = useMe();
  const logout = useLogout();
  const navigate = useNavigate();
  const { notifications, dismiss } = useUserNotifications();
  const user = me.data ?? null;
  return (
    <div className="bg-bg text-fg flex min-h-screen flex-col">
      <SessionBoot />
      <header className="border-border flex items-center gap-4 border-b px-4 py-2">
        <Link to="/" className="font-semibold">
          Session
        </Link>
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
      <NotificationStack notifications={notifications} onDismiss={dismiss} />
    </div>
  );
}
