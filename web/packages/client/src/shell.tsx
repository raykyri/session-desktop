// What a shell around the client uses of it (`@session/client/shell`): the
// web's entry (`main.tsx`) and the Desktop app's (`web/desktop/src/main.tsx`,
// phase 3), which installs its platform first and draws its own sign-in
// and storage problem with the client's atoms. Nothing here is desktop
// code.

import type { OutboxEntry } from "@session/sync/client";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";

import { AppProviders } from "./app/providers.js";
import { router } from "./app/router.js";
import { describe } from "./spaces/outbox.js";
import { Reader } from "./sync/reader.js";

export { meResource } from "./api/account.js";
export { HttpError, NetworkError, setFetch } from "./api/http.js";
export { writeClipboardText } from "./lib/clipboard.js";
export { platform, setPlatform, webPlatform, type Platform } from "./platform.js";
export { Svg } from "./spaces/Svg.js";
export { Logo } from "./spaces/atoms.js";
export { CI, I, SXI } from "./spaces/icons.js";
export { Toasts, toast } from "./spaces/writes.js";
export { router };

/** The client's screens, with the providers they need. */
export function ClientApp() {
  return (
    <StrictMode>
      <AppProviders>
        <RouterProvider router={router} />
      </AppProviders>
    </StrictMode>
  );
}

const NO_RECORDS = new Reader(
  { get: () => undefined, keys: () => new Set<string>(), pendingAt: () => false },
  null,
);

/** A write of an outbox whose replica could not be opened (the desktop's
 * storage problem): its row title and the person's text, as Unsent
 * changes shows them, without the replica's records (so no space names). */
export function describeStoredWrite(
  e: OutboxEntry,
  now: number,
): { local: string; title: string; text: string } {
  const o = describe(e, NO_RECORDS, () => null, now);
  return { local: o.local, title: o.title, text: o.text };
}
