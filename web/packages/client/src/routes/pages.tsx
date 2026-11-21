// The page screens of 02 §2.1 whose content needs a procedure the server
// does not have yet: Invites (W7.1, `members.tree` and account invites),
// Notifications (W2.6, the user log) and Invite required (W7.3, the redeem
// call). Each is its heading, a placeholder line and the site footer. Usage
// and API keys (W8.1) is `features/usage/UsagePage.tsx`.

import { NotBuiltYet, PageFrame } from "../features/shell/Frames.js";

export function InvitesPage() {
  return (
    <PageFrame title="Invites">
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

export function WelcomePage() {
  return (
    <PageFrame title="Invite required" narrow>
      <NotBuiltYet />
    </PageFrame>
  );
}

export { BrowsePage } from "../features/channels/BrowsePage.js";
export { UsagePage } from "../features/usage/UsagePage.js";
