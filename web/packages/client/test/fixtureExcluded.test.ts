// 02 §9.6: a production build contains no fixture text. The fixture replica
// is a chunk imported behind a build-time constant; a build without
// `VITE_SESSION_FIXTURES=1` must not emit it.

import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import test from "ava";
import { build } from "vite";

const clientDirectory = join(import.meta.dirname, "..");

/** Strings that only the fixtures and the mockup's seeds contain. */
const FIXTURE_STRINGS = [
  "Intention marketplaces in science fiction",
  "SessionFixtures",
  "Sales posts are off topic here.",
  "scan sci-fi + adjacent writing",
];

test("a build without the fixtures has no fixture strings", async (t) => {
  const out = mkdtempSync(join(tmpdir(), "session-client-build-"));
  const previous = process.env["VITE_SESSION_FIXTURES"];
  // unset, as in a production build, not "0"
  delete process.env["VITE_SESSION_FIXTURES"];
  try {
    await build({
      root: clientDirectory,
      configFile: join(clientDirectory, "vite.config.ts"),
      logLevel: "silent",
      build: { outDir: out, emptyOutDir: true, sourcemap: false },
    });
    const files = readdirSync(join(out, "assets")).filter((f) => f.endsWith(".js"));
    t.false(
      files.some((f) => f.startsWith("fixtureReplica")),
      "no fixture chunk",
    );
    const offenders = files.flatMap((f) => {
      const text = readFileSync(join(out, "assets", f), "utf8");
      return FIXTURE_STRINGS.filter((s) => text.includes(s)).map((s) => `${f}: ${s}`);
    });
    t.deepEqual(offenders, []);
  } finally {
    if (previous === undefined) delete process.env["VITE_SESSION_FIXTURES"];
    else process.env["VITE_SESSION_FIXTURES"] = previous;
    rmSync(out, { recursive: true, force: true });
  }
});
