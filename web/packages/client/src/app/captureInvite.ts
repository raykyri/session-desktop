// Imported first by `main.tsx`, so it runs before the router module creates
// the browser history and before any request: an invitation link's token
// leaves the address bar before anything else sees the URL
// (`lib/pendingInvite.ts`).

import { captureInviteFragment } from "../lib/pendingInvite.js";

captureInviteFragment();
