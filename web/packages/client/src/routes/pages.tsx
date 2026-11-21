// The page screens of 02 §2.1. Usage (W8.1, `usage.get`) and Notifications
// (W2.6, the user log) still need a procedure the server does not have yet:
// each is its heading, a placeholder line and the site footer. Invites
// (W7.1) and Invite required (W7.3) are the account screens of
// `features/auth`.

import { NotBuiltYet, PageFrame } from "../features/shell/Frames.js";

export function UsagePage() {
  return (
    <PageFrame title="Usage and API keys" narrow>
      <NotBuiltYet />
    </PageFrame>
  );
}

export function NotificationsPage() {
  return (
    <PageFrame title="Notifications" narrow>
      <NotBuiltYet />
    </PageFrame>
  );
}

export { BrowsePage } from "../features/channels/BrowsePage.js";
export { InvitesPage } from "../features/auth/InvitesPage.js";
export { WelcomePage } from "../features/auth/WelcomePage.js";
