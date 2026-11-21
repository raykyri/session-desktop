// First: removes an invitation token from the address bar before the router
// and the first request start.
import "./app/captureInvite.js";

import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { AppProviders } from "./app/providers.js";
import { appQueryClient } from "./app/queryClient.js";
import { router } from "./app/router.js";
import { loadReplicaConfig } from "./replica/config.js";
import "./styles/app.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");

// The fixture build loads its replica chunk before the first render, so the
// feed's first paint is the fixtures rather than the loading row.
void loadReplicaConfig()
  .catch((error: unknown) => console.error("replica failed to load", error))
  .finally(() =>
    createRoot(root).render(
      <StrictMode>
        <AppProviders queryClient={appQueryClient}>
          <RouterProvider router={router} />
        </AppProviders>
      </StrictMode>,
    ),
  );
