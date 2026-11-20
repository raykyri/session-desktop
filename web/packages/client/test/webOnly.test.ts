// 02 W1.2's replacement check: there is no desktop client, so nothing in the
// client package refers to Tauri's npm scope (the plan's `rg` over
// packages/client finds nothing).

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import test from "ava";

const packageDirectory = join(import.meta.dirname, "..");

function files(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...files(path));
    else if (/\.(ts|tsx|js|mjs|json|html|css)$/.test(entry.name)) found.push(path);
  }
  return found;
}

test("no reference to Tauri packages anywhere in the client package", (t) => {
  // Spelled in two parts so this file does not match itself.
  const needle = ["@tauri", "apps"].join("-");
  const offenders = files(packageDirectory).filter((file) =>
    readFileSync(file, "utf8").includes(needle),
  );
  t.deepEqual(offenders, []);
});

test("no request for the browser's fullscreen in the client (W2.4)", (t) => {
  const needle = ["request", "Fullscreen"].join("");
  const offenders = files(join(packageDirectory, "src")).filter((file) =>
    readFileSync(file, "utf8").includes(needle),
  );
  t.deepEqual(offenders, []);
});
