import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { host: "127.0.0.1", port: 1480 },
  // `dist` also holds the declaration output of `tsc -b`, so the bundle gets a
  // subdirectory Vite is free to empty.
  build: { outDir: "dist/app", sourcemap: true },
});
