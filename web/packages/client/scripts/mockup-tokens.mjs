/* global URL, document, getComputedStyle */
// Capture the mockup's resolved :root tokens (its default variants: Beige
// tint, Inter) in dark and light, into mockup-tokens.json
// (port-mockup-css.mjs writes them to src/styles/tokens.css).
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
const b = await chromium.launch();
const out = {};
for (const theme of ["dark", "light"]) {
  const ctx = await b.newContext({ viewport: { width: 1400, height: 900 }, colorScheme: theme });
  const p = await ctx.newPage();
  await p.goto(new URL("../../../../docs/mockups/session-web-spaces.html", import.meta.url).href);
  await p.waitForTimeout(1200);
  out[theme] = await p.evaluate(() => {
    const root = document.documentElement;
    const names = new Set();
    for (const sh of document.styleSheets) {
      let rules;
      try {
        rules = sh.cssRules;
      } catch {
        continue;
      }
      const walk = (rs) => {
        for (const r of rs) {
          if (r.cssRules) walk(r.cssRules);
          if (r.style && /:root/.test(r.selectorText || ""))
            for (const p of r.style) if (p.startsWith("--")) names.add(p);
        }
      };
      walk(rules);
    }
    for (const p of root.style) if (p.startsWith("--")) names.add(p);
    const cs = getComputedStyle(root);
    const o = {};
    for (const n of [...names].sort()) o[n] = cs.getPropertyValue(n).trim();
    o.__attrs = { ...root.dataset };
    o.__inline = [...root.style].filter((p) => p.startsWith("--"));
    return o;
  });
  await ctx.close();
}
writeFileSync(new URL("./mockup-tokens.json", import.meta.url), JSON.stringify(out, null, 1));
await b.close();
