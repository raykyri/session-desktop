// Screenshot a candidate's variants in the shared shell.
// Usage: NODE_PATH=$(npm root -g) node shared/shot.mjs <id> <round> [variant|all] [light|dark|both] [--frame-only]
// Writes PNGs to shots/<id>-r<round>-<variant>-<theme>.png and prints console errors.
import { createRequire } from "module";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const here = path.dirname(fileURLToPath(import.meta.url));
const [id, round = "1", which = "all", themeArg = "light", ...rest] = process.argv.slice(2);

if (!id) { console.error("usage: shot.mjs <id> <round> [variant|all] [light|dark|both]"); process.exit(1); }
const file = path.join(here, "..", "candidates", id, `r${round}.js`);
if (!fs.existsSync(file)) { console.error("missing " + file); process.exit(1); }
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1700, height: 1200 }, deviceScaleFactor: 1 });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));
const url = "file://" + path.join(here, "dev.html") + `?load=${id}/r${round}.js#${id}.r${round}.`;
await page.goto(url);
await page.waitForTimeout(400);
const variants = await page.evaluate(([id, r]) => (SessionMocks.candidates.find((c) => c.id === id && c.round === Number(r)) || { variants: [] }).variants.map((v) => v.id), [id, round]);
if (!variants.length) { console.error("candidate did not register"); console.error(errors.join("\n")); await browser.close(); process.exit(1); }
const themes = themeArg === "both" ? ["light", "dark"] : [themeArg];
fs.mkdirSync(path.join(here, "..", "shots"), { recursive: true });
for (const theme of themes) {
  await page.evaluate((t) => { localStorage.clear(); document.documentElement.setAttribute("data-theme", t); }, theme);
  for (const v of which === "all" ? variants : [which]) {
    await page.goto(url.replace(/#.*/, "") + `#${id}.r${round}.${v}`);
    await page.evaluate((t) => { document.querySelectorAll(".sx-seg button").forEach((b) => { if (b.textContent === (t === "dark" ? "Dark" : "Light")) b.click(); }); }, theme);
    await page.evaluate(() => { const b = [...document.querySelectorAll(".sx-seg button")].find((x) => x.textContent === "100%"); b && b.click(); });
    await page.waitForTimeout(350);
    const out = path.join(here, "..", "shots", `${id}-r${round}-${v}-${theme}.png`);
    await page.locator(".sx-window").screenshot({ path: out });
    console.log("wrote " + out);
  }
}
if (errors.length) { console.log("CONSOLE ERRORS:\n" + [...new Set(errors)].join("\n")); } else console.log("no console errors");
await browser.close();
