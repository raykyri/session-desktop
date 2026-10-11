// Builds manifest.json and thumbs/ for the redesign compilation (index.html).
// Loads each candidate file in headless Chromium, reads its MOCK object, and
// takes a 1400x860 screenshot. Run: node docs/mockups/redesign/build-manifest.mjs [r1/slug ...]
// With arguments, only the listed files are included (to skip files still being written).
import { createRequire } from "node:module";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require("playwright");
} catch {
  playwright = require("/opt/node22/lib/node_modules/playwright");
}

const root = dirname(fileURLToPath(import.meta.url));
const slugs = ["ulysses", "macos", "notes", "obsidian", "notion", "inbox", "tana", "linear"];
const only = new Set(process.argv.slice(2));
const manifest = { generated: new Date().toISOString(), rounds: { 1: {}, 2: {} } };
mkdirSync(join(root, "thumbs"), { recursive: true });

const browser = await playwright.chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 860 } });
for (const round of [1, 2]) {
  for (const slug of slugs) {
    const file = join(root, `r${round}`, `${slug}.html`);
    if (!existsSync(file)) continue;
    if (only.size && !only.has(`r${round}/${slug}`)) continue;
    const errors = [];
    const onError = (e) => errors.push(String(e));
    const onConsole = (m) => m.type() === "error" && errors.push(m.text());
    page.on("pageerror", onError);
    page.on("console", onConsole);
    await page.goto(pathToFileURL(file).href);
    await page.waitForTimeout(1200);
    const mock = await page.evaluate(() => (typeof MOCK === "undefined" ? null : MOCK));
    // Hide a standalone variant switcher, if any, for the thumbnail.
    const thumb = `thumbs/r${round}-${slug}.jpg`;
    await page.screenshot({ path: join(root, thumb), type: "jpeg", quality: 62 });
    page.off("pageerror", onError);
    page.off("console", onConsole);
    if (!mock) {
      console.warn(`r${round}/${slug}: no MOCK object`);
      continue;
    }
    manifest.rounds[round][slug] = { ...mock, file: `r${round}/${slug}.html`, thumb };
    console.log(`r${round}/${slug}: ${mock.variants?.length ?? 0} variants${errors.length ? `, errors: ${errors.join(" | ")}` : ""}`);
  }
}
await browser.close();
writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
