import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** Where the API server listens in development (`web/.env` `PORT`). */
const serverOrigin = `http://127.0.0.1:${process.env["PORT"] ?? "8787"}`;

/** Everything the server owns. Vite answers for the SPA and proxies the rest,
 * so the browser sees one origin and the session cookie, the CSRF origin check
 * and the event stream all behave as they do in production. */
const proxied = ["/api", "/auth", "/uploads", "/a", "/__session", "/healthz", "/metrics"];

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
});
