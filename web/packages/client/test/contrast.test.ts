// W11.2: contrast of the feed's text and graphics in each theme ×
// appearance combination, from the values `tokens.css` resolves to. Text
// needs 4.5:1 against the surfaces it sits on (the passage shade and the
// quoted-passage tint composited over the feed); rails, dots, the hollow
// title node, the ring, avatar fills and the focus ring need 3:1. Disabled
// controls are exempt. A failure names the pair.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import test from "ava";

const tokensCss = readFileSync(
  join(import.meta.dirname, "..", "src", "styles", "tokens.css"),
  "utf8",
);

type Rgba = [number, number, number, number];

function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** `tokens.css` for `<html data-color-theme data-appearance>`, `var()`
 * references followed (as `palette.test.ts` resolves it). */
function resolvedTokens(theme: string, appearance: string): Map<string, string> {
  const attributes: Record<string, string> = {
    "data-color-theme": theme,
    "data-appearance": appearance,
  };
  const applied: { specificity: number; order: number; name: string; value: string }[] = [];
  let order = 0;
  for (const match of withoutComments(tokensCss).matchAll(/(:root[^{]*)\{([^{}]*)\}/g)) {
    let specificity = -1;
    for (const selector of (match[1] ?? "").split(",")) {
      const required = [...selector.matchAll(/\[([a-z-]+)="([^"]+)"\]/g)];
      if (required.every(([, name, value]) => name && attributes[name] === value))
        specificity = Math.max(specificity, required.length);
    }
    if (specificity < 0) continue;
    for (const d of (match[2] ?? "").matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g))
      applied.push({ specificity, order: order++, name: d[1] ?? "", value: (d[2] ?? "").trim() });
  }
  applied.sort((a, b) => a.specificity - b.specificity || a.order - b.order);
  const raw = new Map(applied.map(({ name, value }) => [name, value]));
  const resolve = (value: string, depth = 0): string =>
    depth > 8
      ? value
      : value.replace(/var\((--[a-z0-9-]+)\)/g, (_, name: string) =>
          resolve(raw.get(name) ?? "", depth + 1),
        );
  return new Map([...raw].map(([name, value]) => [name, resolve(value)]));
}

const over = (top: Rgba, bottom: Rgba): Rgba => {
  const a = top[3];
  return [0, 1, 2].map((i) => (top[i] ?? 0) * a + (bottom[i] ?? 0) * (1 - a)).concat(1) as Rgba;
};

/** A colour value: hex, rgb(a), `transparent`, or `color-mix(in srgb, A p%,
 * B)` (a missing percentage is the rest of 100 %). */
function parse(value: string): Rgba {
  const v = value.trim();
  if (v === "transparent") return [0, 0, 0, 0];
  const hex = /^#([0-9a-f]{3,8})$/i.exec(v)?.[1];
  if (hex) {
    const full = hex.length <= 4 ? [...hex].map((c) => c + c).join("") : hex;
    const n = (i: number) => parseInt(full.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), full.length === 8 ? n(6) / 255 : 1];
  }
  const rgb = /^rgba?\(([^)]+)\)$/.exec(v)?.[1];
  if (rgb) {
    const [r = 0, g = 0, b = 0, a = 1] = rgb.split(",").map((x) => parseFloat(x));
    return [r, g, b, a];
  }
  const mix = /^color-mix\(in srgb,\s*(.+)\)$/.exec(v)?.[1];
  if (mix) {
    // split on the top-level comma
    let depth = 0;
    let cut = -1;
    for (let i = 0; i < mix.length; i++) {
      const c = mix[i];
      if (c === "(") depth++;
      else if (c === ")") depth--;
      else if (c === "," && depth === 0) cut = i;
    }
    const part = (s: string) => {
      const m = /^(.*?)(?:\s+(\d+(?:\.\d+)?)%)?$/.exec(s.trim());
      return { color: parse(m?.[1] ?? s), pct: m?.[2] === undefined ? null : Number(m[2]) };
    };
    const a = part(mix.slice(0, cut));
    const b = part(mix.slice(cut + 1));
    const pa = (a.pct ?? (b.pct === null ? 50 : 100 - b.pct)) / 100;
    const pb = 1 - pa;
    const alpha = a.color[3] * pa + b.color[3] * pb;
    const ch = (i: number) =>
      alpha === 0
        ? 0
        : ((a.color[i] ?? 0) * a.color[3] * pa + (b.color[i] ?? 0) * b.color[3] * pb) / alpha;
    return [ch(0), ch(1), ch(2), alpha];
  }
  throw new Error(`cannot parse ${v}`);
}

function luminance([r, g, b]: Rgba): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function ratio(fg: Rgba, bg: Rgba): number {
  const solidBg = bg[3] < 1 ? over(bg, [255, 255, 255, 1]) : bg;
  const solidFg = over(fg, solidBg);
  const [l1, l2] = [luminance(solidFg), luminance(solidBg)].sort((x, y) => y - x);
  return ((l1 ?? 0) + 0.05) / ((l2 ?? 0) + 0.05);
}

/** [foreground, background layers from the top down, minimum, what]. */
type Pair = [string, string[], number, string];

/** The surfaces text sits on: the feed, cards and popovers. */
const SURFACES: string[][] = [["--research-feed-bg"], ["--content-card-bg"], ["--popover-bg"]];
/** A shaded passage and the quoted-passage tint, over the card: the
 * answer's text, citations and count buttons sit on them. */
const PASSAGES: string[][] = [
  ["--passage-mark", "--content-card-bg"],
  ["qsel", "--content-card-bg"],
];

const PAIRS: Pair[] = [
  ...SURFACES.flatMap((bg): Pair[] => [
    ["--text-primary", bg, 4.5, "title"],
    ["--text-faint", bg, 4.5, "footer meta, site footer"],
    ["--text-secondary", bg, 4.5, "tree row, chip"],
  ]),
  ...[...SURFACES, ...PASSAGES].flatMap((bg): Pair[] => [
    ["--text-body-soft", bg, 4.5, "answer text"],
    ["--accent-color", bg, 4.5, "citation, link"],
  ]),
  ["--text-secondary", ["--control-bg"], 4.5, "chip"],
  ["--accent-color", ["--accent-soft", "--content-card-bg"], 4.5, "passage count button"],
  ["--placeholder-color", ["--content-card-bg"], 4.5, "composer placeholder"],
  ["--placeholder-color", ["--field-bg"], 4.5, "inline composer placeholder"],
  ["--tree-rail", ["--research-feed-bg"], 3, "tree rail"],
  ["--tree-rail-on", ["--research-feed-bg"], 3, "tree rail on the selected path"],
  ["--tree-node", ["--research-feed-bg"], 3, "tree dot"],
  ["--tree-dot-selected", ["--research-feed-bg"], 3, "selected dot"],
  ["--tree-node", ["--content-card-bg"], 3, "hollow title node"],
  ["--focus-ring", ["--research-feed-bg"], 3, "focus ring"],
  ["--focus-ring", ["--content-card-bg"], 3, "focus ring on a card"],
  ...[1, 2, 3, 4, 5, 6].map((n): Pair => ["--avatar-fg", [`--avatar-${n}`], 3, `avatar ${n}`]),
];

const COMBINATIONS = ["green-blob", "orange-blob"].flatMap((theme) =>
  ["dark", "light"].map((appearance) => ({ theme, appearance })),
);

for (const { theme, appearance } of COMBINATIONS) {
  test(`contrast in ${theme} ${appearance}`, (t) => {
    const tokens = resolvedTokens(theme, appearance);
    const color = (name: string): Rgba =>
      name === "qsel"
        ? parse(`color-mix(in srgb, ${tokens.get("--accent-color") ?? ""} 9%, transparent)`)
        : parse(tokens.get(name) ?? `(unset ${name})`);
    const failures: string[] = [];
    for (const [fg, layers, min, what] of PAIRS) {
      let bg = color(layers[layers.length - 1] ?? "");
      for (let i = layers.length - 2; i >= 0; i--) bg = over(color(layers[i] ?? ""), bg);
      const r = ratio(color(fg), bg);
      if (r < min)
        failures.push(`${what}: ${fg} on ${layers.join(" over ")} is ${r.toFixed(2)} (< ${min})`);
    }
    t.deepEqual(failures, []);
  });
}
