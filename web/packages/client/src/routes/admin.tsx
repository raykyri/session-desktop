// The Site Admin page (02 W8.2; 03 K15, decision P11; the mock's
// `adminPage`): "Site Admin", "Settings for everyone on Session.", and
// exactly two boxes, the default model and the default effort
// (`features/admin/SiteAdminSettings.tsx`). The site admins' invite tree
// comes with M6.
//
// The route answers not found to anyone but a site admin (`app/router.tsx`).
// That is a courtesy, not the control: every procedure behind the page is an
// `adminProcedure`, which answers `FORBIDDEN` whatever the client shows
// (`06-auth-and-users.md` §8).

import { SiteAdminSettings } from "../features/admin/SiteAdminSettings.js";
import { PageFrame } from "../features/shell/Frames.js";

export function AdminPage() {
  return (
    <PageFrame title="Site Admin" narrow>
      <p className="lede">Settings for everyone on Session.</p>
      <SiteAdminSettings />
    </PageFrame>
  );
}
