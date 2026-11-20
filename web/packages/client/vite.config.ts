import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

/** Where the API server listens in development (`web/.env` `PORT`). */
const serverOrigin = `http://127.0.0.1:${process.env["PORT"] ?? "8787"}`;

/** Everything the server owns. Vite answers for the SPA and proxies the rest,
 * so the browser sees one origin and the session cookie, the CSRF origin check
 * and the event stream all behave as they do in production. */
const proxied = ["/api", "/auth", "/embeds", "/images", "/healthz", "/metrics"];

/** `web/`, which holds the server's `.env`. */
const webDirectory = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  // The public origin, for the site footer's abuse address (02 W2.7). Read at
  // build time from the environment or `web/.env`; a build without it uses
  // the production origin (`src/lib/publicOrigin.ts`). `loadEnv` filters by
  // prefix, so no other variable of `.env` is read into the bundle.
  define: {
    __SESSION_PUBLIC_ORIGIN__: JSON.stringify(
      process.env["SESSION_PUBLIC_ORIGIN"] ??
        loadEnv(mode, webDirectory, "SESSION_PUBLIC_ORIGIN")["SESSION_PUBLIC_ORIGIN"] ??
        "",
    ),
  },
  server: {
    host: "127.0.0.1",
    port: 1480,
    proxy: Object.fromEntries(
      proxied.map((path) => [
        path,
        // The event stream is a long-lived response; the proxy must not buffer
        // it or the client sees nothing until the run ends.
        { target: serverOrigin, changeOrigin: false, ws: false },
      ]),
    ),
  },
  // `dist` also holds the declaration output of `tsc -b`, so the bundle gets a
  // subdirectory Vite is free to empty.
  build: { outDir: "dist/app", sourcemap: true },
}));
