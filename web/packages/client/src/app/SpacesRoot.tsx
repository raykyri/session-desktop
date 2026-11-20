// The root of every screen: the spaces session, the app element the
// mockup's styles hang off (`#app`), the first load (skeleton rows, or the
// load's error with Retry), Update Session, and the toasts.

import { Outlet } from "@tanstack/react-router";
import { useState } from "react";

import { meResource, useMe } from "../api/account.js";
import { LoadFailed, Skeleton, UpdateDialog } from "../spaces/Page.js";
import { Toasts } from "../spaces/writes.js";
import { SpacesProvider, useSession, useStatus } from "../sync/react.js";
import { NotificationStack } from "../ui/NotificationStack.js";
import { useUserNotifications } from "../ui/useUserNotifications.js";

import { SessionBoot } from "./SessionBoot.js";

function UpdateGate() {
  const status = useStatus();
  // Later hides it for this page; a reload is the update
  const [later, setLater] = useState(false);
  if (!status.updateRequired || later) return null;
  return <UpdateDialog onLater={() => setLater(true)} />;
}

/** While `/api/me` and the person's first reads are loading: the skeleton.
 * A load that failed: its error and Retry. */
function FirstLoad({ children }: { children: React.ReactNode }) {
  const me = useMe();
  const session = useSession();
  const status = useStatus();
  if (me.status === "error" && !me.data)
    return (
      <LoadFailed
        message="Session couldn’t load your spaces. Check the connection and try again."
        onRetry={() => void meResource.load(true).catch(() => undefined)}
      />
    );
  if (status.signedOut)
    return (
      <LoadFailed
        message="Your sign-in expired. Sign in again to load your spaces."
        onRetry={() =>
          void meResource
            .load(true)
            .then(() => session?.retry())
            .catch(() => undefined)
        }
      />
    );
  if (!session || (me.data && !status.ready)) return <Skeleton />;
  return <>{children}</>;
}

export function SpacesRoot() {
  const { notifications, dismiss } = useUserNotifications();
  return (
    <SpacesProvider>
      <SessionBoot />
      <div id="app" className="app">
        <FirstLoad>
          <Outlet />
        </FirstLoad>
        <Toasts />
      </div>
      <UpdateGate />
      <NotificationStack notifications={notifications} onDismiss={dismiss} />
    </SpacesProvider>
  );
}
