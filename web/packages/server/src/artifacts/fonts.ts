// `GET /__session/fonts/<file>.woff2` on the artifact origin
// (`11-artifacts-and-browser.md` §2, `file_server.rs:627`).
//
// Rendered pages load their body face from their own origin, so the page needs
// no network and its CSP can stay at `font-src 'self'`. Only the files the
// page CSS names are reachable: the handler matches the request against a
// literal allowlist rather than resolving a path under a directory, so there is
// no traversal to defend against.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The faces `?session-body-font=` can select. */
export const FONT_FILES: readonly string[] = [
  "DMSans-Variable-Latin.woff2",
  "DMSans-Variable-LatinExt.woff2",
  "DMSans-VariableItalic-Latin.woff2",
  "DMSans-VariableItalic-LatinExt.woff2",
  "Inter-Variable-Latin.woff2",
  "Inter-Variable-LatinExt.woff2",
  "Inter-VariableItalic-Latin.woff2",
  "Inter-VariableItalic-LatinExt.woff2",
  "ValleySans-Variable.woff2",
  "ValleySans-VariableItalic.woff2",
];

const ALLOWED = new Set(FONT_FILES);

/**
 * `packages/server/assets`, whether this module is the TypeScript source under
 * `src/` or the bundle at `dist/server.mjs`. `SESSION_ASSETS_DIR` overrides it
 * for an image that puts the assets somewhere else.
 */
export function assetsDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["SESSION_ASSETS_DIR"];
  if (override !== undefined && override !== "") {
    return override;
  }
  const candidates = [
    fileURLToPath(new URL("../../assets", import.meta.url)),
    fileURLToPath(new URL("../assets", import.meta.url)),
  ];
  return candidates.find((candidate) => existsSync(join(candidate, "fonts"))) ?? candidates[0]!;
}

const cache = new Map<string, Uint8Array<ArrayBuffer>>();

/** Caches allowlisted font assets in memory to optimize rendered page delivery. */
export function readFont(
  file: string,
  directory = assetsDirectory(),
): Uint8Array<ArrayBuffer> | null {
  if (!ALLOWED.has(file)) {
    return null;
  }
  const cached = cache.get(file);
  if (cached) {
    return cached;
  }
  try {
    const bytes = new Uint8Array(readFileSync(join(directory, "fonts", file)));
    cache.set(file, bytes);
    return bytes;
  } catch {
    return null;
  }
}
