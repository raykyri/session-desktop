import type { ReactNode } from "react";

import { TooltipProvider } from "../ui/Tooltip.js";

import { ThemeEffects } from "./ThemeEffects.js";

/** Everything the tree needs above the router (07 §2). The spaces session is
 * the router root's (`SpacesRoot`). */
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <TooltipProvider>
      <ThemeEffects />
      {children}
    </TooltipProvider>
  );
}
