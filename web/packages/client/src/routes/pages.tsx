// The page screens of 02 §2.1 whose content needs the replica or a
// procedure the server does not have yet: Browse (W6.6, `spaces.directory`),
// Invites (W7.1, `members.tree` and account invites), Usage (W8.1,
// `usage.get`), Notifications (W2.6, the user log) and Invite required
// (W7.3, the redeem call). Each is its heading, a placeholder line and the
// site footer.

import { NotBuiltYet, PageFrame } from "../features/shell/Frames.js";

export function BrowsePage() {
  return (
    <PageFrame title="Browse channels">
      <NotBuiltYet />
    </PageFrame>
  );
}

export function InvitesPage() {
  return (
    <PageFrame title="Invites">
      <NotBuiltYet />
    </PageFrame>
  );
}

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

export function WelcomePage() {
  return (
    <PageFrame title="Invite required" narrow>
      <NotBuiltYet />
    </PageFrame>
  );
}
