import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { AppProviders } from "./app/providers.js";
import { appQueryClient } from "./app/queryClient.js";
import { router } from "./app/router.js";
import "./styles/app.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");

createRoot(root).render(
  <StrictMode>
    <AppProviders queryClient={appQueryClient}>
      <RouterProvider router={router} />
    </AppProviders>
  </StrictMode>,
);
