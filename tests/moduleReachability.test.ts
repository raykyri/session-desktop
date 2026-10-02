import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { unreachableModules, unusedExports } from "../scripts/check-unused-modules.mjs";

function fixture(files: Record<string, string>) {
  const directory = mkdtempSync(join(tmpdir(), "session-reachability-"));
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(directory, name), contents);
  }
  return {
    file: (name: string) => join(directory, name),
    sources: Object.keys(files).map((name) => join(directory, name)),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

test("reachability follows lazy imports, type imports, re-exports, and cycles", () => {
  const files = fixture({
    "main.ts": 'import type { Model } from "./model"; export * from "./barrel"; void import("./lazy");',
    "model.ts": "export interface Model { id: string }",
    "barrel.ts": 'export * from "./leaf";',
    "leaf.ts": 'export * from "./barrel";',
    "lazy.ts": 'type Imported = import("./inline-type").Inline;',
    "inline-type.ts": "export type Inline = string;",
    "unused.ts": "export const unused = true;",
  });
  try {
    assert.deepEqual(unreachableModules(files.sources, [files.file("main.ts")]), [files.file("unused.ts")]);
  } finally {
    files.cleanup();
  }
});

test("server and test entrypoints retain their own dependency trees", () => {
  const files = fixture({
    "app.ts": "export {};",
    "server.ts": 'import "./server-helper";',
    "server-helper.ts": "export {};",
    "helper.test.ts": 'import "./test-helper";',
    "test-helper.ts": "export {};",
  });
  try {
    assert.deepEqual(unreachableModules(files.sources, [
      files.file("app.ts"), files.file("server.ts"), files.file("helper.test.ts"),
    ]), []);
  } finally {
    files.cleanup();
  }
});

test("a cycle without an entrypoint does not keep itself alive", () => {
  const files = fixture({
    "app.ts": "export {};",
    "a.ts": 'import "./b";',
    "b.ts": 'import "./a";',
  });
  try {
    assert.deepEqual(unreachableModules(files.sources, [files.file("app.ts")]), [files.file("a.ts"), files.file("b.ts")]);
  } finally {
    files.cleanup();
  }
});

test("test roots do not hide app-only unreachable modules", () => {
  const files = fixture({
    "app.ts": "export {};",
    "contract.test.ts": 'import { contract } from "./contract"; contract();',
    "contract.ts": "export function contract() {}",
  });
  try {
    assert.deepEqual(unreachableModules(files.sources, [files.file("app.ts")]), [
      files.file("contract.test.ts"), files.file("contract.ts"),
    ]);
    assert.deepEqual(unreachableModules(files.sources, [files.file("app.ts"), files.file("contract.test.ts")]), []);
  } finally {
    files.cleanup();
  }
});

test("exports require consumers beyond a barrel, with aliases and type uses preserved", () => {
  const files = fixture({
    "main.ts": 'import { used as call, type Model as Shape } from "./barrel"; const model: Shape = { id: "1" }; call(model);',
    "barrel.ts": 'export * from "./leaf";',
    "leaf.ts": 'export interface Model { id: string }; export function used(model: Model) { return model.id }; export function dead() {};',
  });
  try {
    assert.deepEqual(unusedExports(files.sources).map((item) => item.exportName), ["dead"]);
  } finally {
    files.cleanup();
  }
});

test("namespace property uses and dynamic destructuring retain the selected exports", () => {
  const files = fixture({
    "main.ts": 'import * as ns from "./leaf"; ns.staticUse(); const { dynamicUse: call } = await import("./leaf"); call();',
    "leaf.ts": 'export function staticUse() {}; export function dynamicUse() {}; export function dead() {};',
  });
  try {
    assert.deepEqual(unusedExports(files.sources).map((item) => item.exportName), ["dead"]);
  } finally {
    files.cleanup();
  }
});

test("escaping namespaces conservatively retain their public exports", () => {
  const files = fixture({
    "main.ts": 'import * as ns from "./leaf"; console.log(ns);',
    "leaf.ts": 'export const value = 1;',
  });
  try {
    assert.deepEqual(unusedExports(files.sources), []);
  } finally {
    files.cleanup();
  }
});
