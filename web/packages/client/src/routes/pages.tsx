// The page screens of 02 §2.1. Notifications (W2.6, the user log) still
// needs a procedure the server does not have yet: it is its heading, a
// placeholder line and the site footer. Usage and API keys (W8.1) is
// `features/usage/UsagePage.tsx`; Invites (W7.1) and Invite required (W7.3)
// are the account screens of `features/auth`.

import { NotBuiltYet, PageFrame } from "../features/shell/Frames.js";

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
export { UsagePage } from "../features/usage/UsagePage.js";
