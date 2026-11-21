// Imported first by `main.tsx`, so it runs before the router module creates
// the browser history and before any request: an invitation link's token
// leaves the address bar before anything else sees the URL
// (`lib/pendingInvite.ts`). Without one, a channel invite kept across a
// sign-in comes back from this tab's `sessionStorage`.

import { captureInviteFragment, restoreChannelInvite } from "../lib/pendingInvite.js";

captureInviteFragment();
restoreChannelInvite();
