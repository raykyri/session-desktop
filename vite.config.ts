import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const require = createRequire(import.meta.url);

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Mirrors the `paths` entry in tsconfig.json. Only subpaths are mapped:
    // the package root (web/packages/shared/src/index.ts) re-exports the web's
    // zod schemas and markdown pipeline, which the desktop does not bundle.
    alias: [
      {
        find: /^@session\/shared\//,
        replacement: fileURLToPath(new URL("./web/packages/shared/src/", import.meta.url)),
      },
    ],
  },
  define: {
    // MathJax's version probe falls back to eval('require') when this global
    // is missing; the app's CSP has no 'unsafe-eval', so the fallback would
    // throw while the math chunk loads. Defining it turns that branch into
    // statically dead code the bundler drops.
    PACKAGE_VERSION: JSON.stringify(
      (require("mathjax-full/package.json") as { version: string }).version,
    ),
  },
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 1480,
    strictPort: true,
  },
  build: {
    chunkSizeWarningLimit: 2048,
  },
});
