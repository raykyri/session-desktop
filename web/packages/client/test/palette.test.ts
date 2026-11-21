import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DEFAULT_USER_SETTINGS } from "@session/shared";
import test from "ava";

// The default theme is the members mockup's palette (02 §11): the Warm theme's
// tokens, resolved through the cascade of `tokens.css` for each appearance,
// equal the mockup's `:root` values (light) and its dark values, including
// the mockup's later dark override of `--accent-strong`.

const tokensCss = readFileSync(
  join(import.meta.dirname, "..", "src", "styles", "tokens.css"),
  "utf8",
);
const mockupHtml = readFileSync(
  join(import.meta.dirname, "..", "..", "..", "..", "docs", "mockups", "session-web-members.html"),
  "utf8",
);

/** Each mockup role and the tokens that carry it. The mockup's `--page`
 * (the window behind its frame), `--on-accent` (unused by its controls) and
 * its card shadows have no token. Two roles depart from the mockup for
 * contrast (W11.2, `contrast.test.ts`) and are not compared: `--placeholder`
 * (`--placeholder-color`) and the tree rails (`--tree-rail`, the mockup's
 * `--border-strong`). */
const ROLES: Record<string, readonly string[]> = {
  chrome: ["--chrome-header-bg"],
  pane: ["--right-pane-bg"],
  canvas: ["--research-feed-bg"],
  card: ["--content-card-bg", "--popover-bg"],
  inset: ["--content-inset-bg"],
  field: ["--field-bg", "--research-feed-field-bg"],
  control: ["--control-bg"],
  "control-hover": ["--control-bg-hover"],
  "control-border": ["--control-border"],
  divider: ["--surface-divider"],
  "border-strong": ["--surface-border-strong"],
  "fill-subtle": ["--surface-fill-subtle"],
  "fill-hover": ["--surface-fill-hover"],
  accent: ["--accent-color", "--focus-ring"],
  "accent-soft": ["--accent-soft"],
  "accent-strong": ["--accent-strong", "--unread-dot"],
  "on-accent-light": ["--text-on-accent"],
  "t-heading": ["--text-heading"],
  "t-primary": ["--text-primary"],
  "t-body": ["--text-body-soft"],
  "t-secondary": ["--text-secondary"],
  "t-muted": ["--text-muted"],
  "t-faint": ["--text-faint"],
  "t-dim": ["--text-dim"],
  good: ["--status-success-fg"],
  warn: ["--status-active-fg"],
  bad: ["--status-attention-fg"],
  av1: ["--avatar-1"],
  av2: ["--avatar-2"],
  av3: ["--avatar-3"],
  av4: ["--avatar-4"],
  av5: ["--avatar-5"],
  av6: ["--avatar-6"],
  "av-fg": ["--avatar-fg"],
  mark: ["--passage-mark"],
  "shadow-pop": ["--popover-shadow"],
};

function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function declarations(body: string): [string, string][] {
  return [...body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map(
    (match) => [match[1] ?? "", (match[2] ?? "").trim()] as [string, string],
  );
}

/** The mockup's custom properties per appearance: the `:root` blocks for
 * light, those and the `:root[data-theme="dark"]` blocks for dark, in source
 * order. */
function mockupPalette(appearance: "light" | "dark"): Map<string, string> {
  const css = withoutComments(mockupHtml.slice(0, mockupHtml.indexOf("</style>")));
  const values = new Map<string, string>();
  for (const match of css.matchAll(/^:root(\[data-theme="dark"\])?\s*\{([^}]*)\}/gm)) {
    if (match[1] && appearance === "light") continue;
    for (const [name, value] of declarations(match[2] ?? "")) values.set(name.slice(2), value);
  }
  return values;
}

/** `tokens.css` resolved for `<html data-color-theme data-appearance>`: each
 * block applies when every attribute of one of its selectors matches; later
 * and more specific declarations win, and `var()` references are followed. */
function resolvedTokens(theme: string, appearance: "light" | "dark"): Map<string, string> {
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
      if (required.every(([, name, value]) => name && attributes[name] === value)) {
        specificity = Math.max(specificity, required.length);
      }
    }
    if (specificity < 0) continue;
    for (const [name, value] of declarations(match[2] ?? "")) {
      applied.push({ specificity, order: order++, name, value });
    }
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

/** `rgba(0, 0, 0, 0.04)` and `rgba(0,0,0,.04)` are the same value. */
function normalized(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/(^|[^\d])0\./g, "$1.");
}

test("new accounts and signed-out visitors start on the Warm theme", (t) => {
  t.is(DEFAULT_USER_SETTINGS.colorTheme, "orange-blob");
  t.is(DEFAULT_USER_SETTINGS.appearance, "system");
});

for (const appearance of ["light", "dark"] as const) {
  test(`the Warm theme's ${appearance} tokens are the mockup's ${appearance} palette`, (t) => {
    const mockup = mockupPalette(appearance);
    const tokens = resolvedTokens("orange-blob", appearance);
    const differences: string[] = [];
    for (const [role, names] of Object.entries(ROLES)) {
      const expected = mockup.get(role);
      if (expected === undefined) {
        differences.push(`--${role} is not in the mockup`);
        continue;
      }
      for (const name of names) {
        const actual = tokens.get(name) ?? "(unset)";
        if (normalized(actual) !== normalized(expected)) {
          differences.push(`${name}: ${actual}, mockup --${role}: ${expected}`);
        }
      }
    }
    t.deepEqual(differences, []);
  });
}

test("the mockup's accent values are the ones the plan names", (t) => {
  t.is(mockupPalette("light").get("accent"), "#0a6fb8");
  t.is(mockupPalette("light").get("accent-strong"), "#095c98");
  t.is(mockupPalette("dark").get("accent-strong"), "#1c6fb3");
  t.is(mockupPalette("dark").get("on-accent-light"), "#ffffff");
});
