/* global URL, console */
// Port the mockup's stylesheet (docs/mockups/session-web-spaces.html) to
// src/styles/spaces.css, and its resolved tokens (mockup-tokens.json, written
// by mockup-tokens.mjs) to src/styles/tokens.css:
//   node scripts/mockup-tokens.mjs && node scripts/port-mockup-css.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postcss from "postcss";

const ROOT = fileURLToPath(new URL("../../../..", import.meta.url)).replace(/\/$/, "");
const html = readFileSync(`${ROOT}/docs/mockups/session-web-spaces.html`, "utf8").split("\n");
const start = html.findIndex((l) => l.startsWith("/* Layout: a mock-control bar"));
const end = html.findIndex((l, i) => i > start && l.startsWith("</style>"));
const css = html.slice(start, end).join("\n");

const MOCK =
  /(^|[\s>+~(,])(\.shell|\.ctl|\.opt\b|\.knob|\.frame|\.dots|\.url\b|\.note\b|\.k-|\.jd\b|\.jd-|\.cs-jump|\.cs-jk|\.cs-kt|\.cs-knobs|\.mock-title|\.kw-)/;
const NATIVE =
  /(^|[^a-zA-Z0-9_-])\.n-[a-z]|\[data-device="native"\]|\[data-client="app"\]|\.phone-|\.ph-frame/;
const split = (sel) => {
  const parts = [];
  let depth = 0;
  let cur = "";
  for (const ch of sel) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && !depth) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  return parts.map((x) => x.trim()).filter(Boolean);
};

/** A selector as the client needs it, or null to drop it; `media` says where it goes. */
function mapSelector(s) {
  if (MOCK.test(s) || NATIVE.test(s)) return null;
  let media = null;
  // the root's attribute chain (html, :root, or a bare leading [data-…]):
  // the Variants bar's defaults are kept and dropped from the selector, the
  // other options drop the selector; a phone device becomes a media query
  const lead = /^(html|:root)?((?:\[data-(?:mnav|sh|device|font)[^\]]*\])+)(\s+|$)/.exec(s);
  if (lead && !/data-theme/.test(lead[0])) {
    for (const a of lead[2].match(/\[[^\]]+\]/g)) {
      const m = /^\[data-([a-z]+)(?:="([^"]*)")?\]$/.exec(a);
      if (!m) return null;
      const [, k, v] = m;
      if (k === "mnav" && v !== "chips") return null;
      if (k === "sh" && v !== "d") return null;
      if (k === "font" && v !== "inter") return null;
      if (k === "device" && v === "native") return null;
      if (k === "device" && v === "phone") media = "(max-width: 640px)";
    }
    s = s.slice(lead[0].length) || ":root";
    return { s, media };
  }
  // variant attributes: the defaults (Beige tint, Inter, chips, sh d) are kept, the others dropped
  if (/\[data-tint/.test(s)) {
    if (/\[data-tint="warmwc"\]/.test(s))
      s = s.replace(/:root:is\([^)]*\)\s*/, "").replace(/:root\[data-tint="warmwc"\]\s*/, "");
    else return null;
  }
  if (/\[data-mnav="(?!chips)/.test(s) || /\[data-sh="(?!d)/.test(s)) return null;
  s = s
    .replace(/:root\[data-mnav="chips"\]\s*|html\[data-mnav="chips"\]\s*/, "")
    .replace(/(:root|html)\[data-sh="d"\]\s*/, "");
  s = s.replace(/:root\[data-font="inter"\]\s*/, "");
  if (/html\[data-device="phone"\]/.test(s)) {
    media = "(max-width: 640px)";
    s = s.replace(/html\[data-device="phone"\]\s*/, "");
  } else if (/html:not\(\[data-device="phone"\]\)/.test(s)) {
    media = "(min-width: 641px)";
    s = s.replace(/html:not\(\[data-device="phone"\]\)\s*/, "");
  } else if (/html\[data-device\]/.test(s)) {
    s = s.replace(/html\[data-device\]\s*/, "");
  }
  if (s === "") s = ":root";
  return { s, media };
}

const root = postcss.parse(css);
const out = postcss.root();
let dropped = 0;
let tokensDropped = 0;

function isTokenRule(rule) {
  return rule.nodes.every(
    (n) => n.type !== "decl" || n.prop.startsWith("--") || n.prop === "color-scheme",
  );
}

function handleRule(rule, parentMedia) {
  if (
    /^(:root|html)(\[data-theme="(light|dark)"\]|:not\(\[data-theme="dark"\]\))?$/.test(
      rule.selector.trim(),
    ) &&
    isTokenRule(rule)
  ) {
    tokensDropped++;
    return [];
  }
  const groups = new Map();
  for (const sel of split(rule.selector)) {
    const m = mapSelector(sel);
    if (!m) {
      dropped++;
      continue;
    }
    const key = m.media ?? "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m.s);
  }
  const res = [];
  for (const [media, sels] of groups) {
    const r = rule.clone({ selector: sels.join(",\n") });
    if (media) {
      const m = postcss.atRule({
        name: "media",
        params: parentMedia ? `${parentMedia} and ${media}` : media,
      });
      m.append(r);
      res.push({ node: m, wrapped: true });
    } else res.push({ node: r, wrapped: false });
  }
  return res;
}

for (const node of root.nodes) {
  if (node.type === "comment") {
    out.append(node.clone());
    continue;
  }
  if (node.type === "rule") {
    for (const { node: n } of handleRule(node, null)) out.append(n);
    continue;
  }
  if (node.type === "atrule" && node.name === "media") {
    const m = node.clone();
    m.removeAll();
    const extra = [];
    for (const child of node.nodes) {
      if (child.type !== "rule") {
        m.append(child.clone());
        continue;
      }
      for (const { node: n, wrapped } of handleRule(child, node.params)) {
        if (wrapped) extra.push(n);
        else m.append(n);
      }
    }
    if (m.nodes.length) out.append(m);
    for (const e of extra) out.append(e);
    continue;
  }
  if (node.type === "atrule" && node.name === "font-face") continue;
  out.append(node.clone());
}

// The mockup's Mobile Web is a 390px frame on a wide page: its phone rules
// (@media max-width) are copied under html[data-device="phone"], which also
// lifts their specificity over the base rules (buildPhoneSim). A real phone
// gets the media rules alone; to keep the mockup's cascade, the selectors of
// the phone-width blocks (640px and 760px) get the same lift: html:root.
const lift = (sel) =>
  /^(html|:root)/.test(sel) ? sel.replace(/^html|^:root/, "html:root") : `html:root ${sel}`;
out.walkAtRules("media", (m) => {
  const w = /\(max-width: (\d+)px\)/.exec(m.params);
  if (!w || Number(w[1]) > 760) return;
  m.walkRules((r) => {
    if (r.parent && r.parent.type === "atrule" && r.parent.name === "keyframes") return;
    r.selector = split(r.selector).map(lift).join(",\n");
  });
});

const header = `/* The spaces client's styles, ported from the mockup (docs/mockups/session-web-spaces.html,
   its <style id="app-css">) by a script: the mock's own controls, its browser frame and the Phone
   app's rules (.n-*, data-device="native") are left out; rules the mock scopes to
   html[data-device="phone"] (Mobile Web in its framed phone) are under @media (max-width: 640px);
   the Variants bar's attributes keep their defaults (Beige tint, Inter, chips) and drop the other
   options. The resolved colour tokens are in tokens.css. Generated: do not edit by hand without
   noting it here. */\n`;
writeFileSync(`${ROOT}/web/packages/client/src/styles/spaces.css`, header + out.toString() + "\n");
console.log("selectors dropped", dropped, "token rules dropped", tokensDropped);

// tokens
const tok = JSON.parse(readFileSync(new URL("./mockup-tokens.json", import.meta.url), "utf8"));
const skip = /^--(mock|frame|n-)/;
const lines = (o, filter) =>
  Object.entries(o)
    .filter(([k]) => !k.startsWith("__") && !skip.test(k) && filter(k))
    .map(([k, v]) => `  ${k}: ${v};`)
    .join("\n");
const dark = tok.dark;
const light = tok.light;
const differs = (k) => dark[k] !== light[k];
const tokensCss = `/* Design tokens: the mockup's (docs/mockups/session-web-spaces.html) as it resolves them with
   its default variants (Beige tint at 80%, Inter), dark and light. Dark is the default; light
   applies with the system's light appearance unless data-theme="dark", or with
   data-theme="light". The names the shell's older components use are aliases at the end. */

:root {
  color-scheme: dark;
${lines(dark, () => true).replace(/--font-ui: [^;]*;/, '--font-ui: "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;')}
  --font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]) {
    color-scheme: light;
${lines(light, differs).replace(/^ {2}/gm, "    ")}
  }
}

:root[data-theme="light"] {
  color-scheme: light;
${lines(light, differs)}
}

:root[data-theme="dark"] {
  color-scheme: dark;
${lines(dark, differs)}
}
`;
writeFileSync(`${ROOT}/web/packages/client/src/styles/tokens.css`, tokensCss);
