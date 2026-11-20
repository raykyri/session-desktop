import { QueryClientProvider } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ReactNode } from "react";

import { TooltipProvider } from "../ui/Tooltip.js";

import { ThemeEffects } from "./ThemeEffects.js";
import { createAppQueryClient } from "./queryClient.js";

export { createAppQueryClient } from "./queryClient.js";

/**
 * Everything the tree needs above the router (07 §2).
 *
 * The fallback query client is created in state rather than at module scope so
 * each mount — every test, and a future multi-root embed — gets its own cache
 * instead of inheriting another run's. In the browser the client is passed in,
 * because the router shares it.
 */
export function AppProviders({
  children,
  queryClient,
}: {
  children: ReactNode;
  queryClient?: QueryClient;
}) {
  const [fallbackClient] = useState(createAppQueryClient);
  return (
    <QueryClientProvider client={queryClient ?? fallbackClient}>
      <TooltipProvider>
        <ThemeEffects />
        {children}
      </TooltipProvider>
    </QueryClientProvider>
  );
}
