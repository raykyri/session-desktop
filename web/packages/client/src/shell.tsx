// What a shell around the client uses of it (`@session/client/shell`): the
// web's entry (`main.tsx`) and the Desktop app's (`web/desktop/src/main.tsx`,
// phase 3), which installs its platform first and draws its own sign-in
// with the client's atoms. Nothing here is desktop code.

import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";

import { AppProviders } from "./app/providers.js";
import { router } from "./app/router.js";

export { meResource } from "./api/account.js";
export { HttpError, NetworkError, setFetch } from "./api/http.js";
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
