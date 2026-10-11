// Build the single-file compilation: dist/index.html
// Usage: node shared/build.mjs
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const read = (p) => fs.readFileSync(p, "utf8");
const esc = (s) => s.replace(/<\/script/gi, "<\\/script");
const ORDER = ["ulysses", "macos", "notes", "obsidian", "notion", "front", "tana", "heptabase"];
const candDir = path.join(root, "candidates");
const files = [];
for (const id of fs.readdirSync(candDir).sort((a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99))) {
  for (const r of ["r1.js", "r2.js"]) { const f = path.join(candDir, id, r); if (fs.existsSync(f)) files.push(f); }
}
const issues = {};
for (const k of ["ux", "eng"]) { const f = path.join(root, "review", `${k}-issues.json`); if (fs.existsSync(f)) issues[k] = JSON.parse(read(f)); }
const html = `<title>Session Redesigns</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;700&display=swap">
<style>
${read(path.join(here, "shell.css"))}
</style>
<header class="sx-top" id="sx-top"></header>
<div class="sx-body"><nav class="sx-rail" id="sx-rail" aria-label="Candidates"></nav><main class="sx-stage" id="sx-stage"></main></div>
<script>
${esc(read(path.join(here, "data.js")))}
</script>
<script>
${esc(read(path.join(here, "shell.js")))}
window.SessionMocks.order = ${JSON.stringify(ORDER)};
window.SessionMocks.issues = ${esc(JSON.stringify(issues))};
</script>
${files.map((f) => `<script>\n/* ${path.relative(root, f)} */\ntry {\n${esc(read(f))}\n} catch (e) { console.error(${JSON.stringify(path.relative(root, f))}, e); }\n</script>`).join("\n")}
<script>window.SessionMocks.start();</script>
`;
fs.mkdirSync(path.join(root, "dist"), { recursive: true });
fs.writeFileSync(path.join(root, "dist", "index.html"), html);
console.log(`dist/index.html ${(html.length / 1024).toFixed(0)} KB, ${files.length} mock files, issues: ${Object.entries(issues).map(([k, v]) => k + "=" + v.length).join(" ")}`);
