import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The Desktop app's frontend: the client's screens behind the app's entry
// (`src/main.tsx`). Tauri loads `dist/app` (`src-tauri/tauri.conf.json`; `dist` also holds
// the declarations of `tsc -b`); in
// development it loads the dev server. The server it talks to is set at
// build time with `VITE_SESSION_SERVER` (default: the production server).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // absolute: a reload on a deep route (/s/<space>/t/<thread>) finds them
  base: "/",
  server: { host: "127.0.0.1", port: 1490, strictPort: true },
  clearScreen: false,
  build: { outDir: "dist/app", sourcemap: true, target: "safari16" },
});
