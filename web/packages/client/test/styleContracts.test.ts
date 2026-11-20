import { readFileSync } from "node:fs";
import { join } from "node:path";

import test from "ava";

// The desktop's `tests/appearanceStyleContracts.test.ts` and
// `researchStyleContracts.test.ts`, re-expressed for the web
// (`08-design-system-and-styling.md` §6). The intents are unchanged; what moved
// is the set of files, because the twelve feature stylesheets became Tailwind
// utilities on components and only `prose.css`
// remains as CSS.

const stylesDirectory = join(import.meta.dirname, "..", "src", "styles");

const tokensCss = readFileSync(join(stylesDirectory, "tokens.css"), "utf8");
/** The older shell pages' tokens, scoped to `.shell-legacy` (phase 2b). */
const shellCss = readFileSync(join(stylesDirectory, "shell-tokens.css"), "utf8");
const proseCss = readFileSync(join(stylesDirectory, "prose.css"), "utf8");
const appCss = readFileSync(join(stylesDirectory, "app.css"), "utf8");

const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\(/;

/** Comments are stripped first: a file that documents a rule in prose ("the
 * `:root { background: transparent }` of the desktop") would otherwise have the
 * comment matched as the rule. */
function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(withoutComments(css));
  if (!match?.[1]) throw new Error(`missing CSS rule for ${selector}`);
  return match[1];
}

/** The custom properties a block of `css` declares, for each selector. */
function tokensBy(css: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const blockPattern = /([^{}]+)\{([^{}]*)\}/g;
  for (const match of withoutComments(css).matchAll(blockPattern)) {
    const selector = (match[1] ?? "").trim();
    const set = out.get(selector) ?? new Set<string>();
    for (const token of (match[2] ?? "").matchAll(/(--[a-z0-9-]+):/g))
      if (token[1]) set.add(token[1]);
    out.set(selector, set);
  }
  return out;
}

// ---------------------------------------------------------------- §6 items 1 and 2
// The spaces client's tokens are the mockup's (phase 2b): dark on `:root`;
// light with the system's light appearance (unless `data-theme="dark"`) or
// `data-theme="light"`; and `data-theme="dark"` restores dark under a light
// system. The three override blocks set the same tokens.

test("each appearance block sets the same tokens, and dark covers them all", (t) => {
  const by = tokensBy(tokensCss);
  const root = by.get(":root") ?? new Set();
  const light = by.get(':root[data-theme="light"]') ?? new Set();
  const system = by.get(':root:not([data-theme="dark"])') ?? new Set();
  const dark = by.get(':root[data-theme="dark"]') ?? new Set();
  t.true(light.size > 30, "sanity: the light block was found");
  t.deepEqual(
    [...system].sort(),
    [...light].sort(),
    "the system's light block matches data-theme=light",
  );
  t.deepEqual(
    [...dark].sort(),
    [...light].sort(),
    "data-theme=dark restores every token light changes",
  );
  t.deepEqual(
    [...light].filter((x) => !root.has(x)),
    [],
    "light changes only tokens dark sets",
  );
});

test("the appearance blocks flip color-scheme, and the page has the pane's background", (t) => {
  t.regex(tokensCss, /:root\s*\{[^}]*color-scheme:\s*dark/s);
  t.regex(tokensCss, /:root\[data-theme="light"\]\s*\{[^}]*color-scheme:\s*light/s);
  t.regex(
    tokensCss,
    /@media \(prefers-color-scheme: light\)\s*\{\s*:root:not\(\[data-theme="dark"\]\)\s*\{[^}]*color-scheme:\s*light/s,
  );
  t.regex(withoutComments(appCss), /body\s*\{[^}]*background:\s*var\(--pane\)/);
});

test("the older shell's tokens are scoped to .shell-legacy", (t) => {
  for (const selector of tokensBy(shellCss).keys()) t.regex(selector, /\.shell-legacy$/, selector);
});

// ---------------------------------------------------------------- §6 item 3

test("no color literals outside tokens.css", (t) => {
  const offenders: string[] = [];
  for (const [name, css] of [
    ["prose.css", proseCss],
    ["app.css", appCss],
  ] as const) {
    css.split("\n").forEach((line, index) => {
      // Two escape hatches, both spelled on the line that uses them: colors
      // that must not change with the appearance (image scrims, the graphviz
      // paper canvas) and `::highlight()` pseudos, where custom properties
      // resolve unreliably so each appearance spells its own literal.
      if (
        COLOR_LITERAL.test(line) &&
        !line.includes("appearance-invariant") &&
        !line.includes("highlight-pseudo-literal")
      ) {
        offenders.push(`${name}:${index + 1}: ${line.trim()}`);
      }
    });
  }
  t.deepEqual(offenders, []);
});

// The component half of §6 item 3 is ESLint's, not this file's: the
// `no-restricted-syntax` rule in `eslint.config.js` matches the literal's own
// AST node inside a `className`/`style` attribute, so it sees a color buried in
// a multi-line `cn(…)` call that a line-oriented scan here cannot.

// ---------------------------------------------------------------- §6 item 4

test("prose typography is declared on the renderer, not on the surfaces that place it", (t) => {
  const prose = ruleBody(proseCss, ".research-prose");
  t.regex(prose, /--transcript-font-delta:/);
  t.regex(prose, /--transcript-line-height-delta:/);
  t.regex(prose, /font-size:\s*var\(--research-body-font-size\)/);
  t.regex(prose, /line-height:\s*var\(--research-body-line-height\)/);

  const surface = ruleBody(proseCss, ".research-reading-surface");
  t.notRegex(surface, /--transcript-/, "the scale is defined here; the deltas are not");

  const summary = ruleBody(proseCss, ".research-summary-text");
  t.regex(summary, /font-size:\s*var\(--research-summary-font-size\)/);
  t.regex(summary, /line-height:\s*var\(--research-summary-line-height\)/);

  // The placements (a Home recap slot, a thread recap) are Tailwind utilities
  // on components now; the contract is that prose.css does not grow a rule for
  // them, because that is how the desktop's typography drifted per surface.
  for (const placement of [".recent-query-recap", ".research-recap", ".research-content-card"]) {
    t.false(proseCss.includes(placement), `${placement} must not declare type in prose.css`);
  }
});

test("research prose restores list markers that Tailwind preflight strips", (t) => {
  const css = withoutComments(proseCss);
  t.regex(
    css,
    /\.research-prose ul,\s*\.research-prose ol\s*\{[^}]*list-style:\s*revert/,
    "unordered and ordered lists undo Tailwind's list-style: none",
  );
  t.regex(
    css,
    /\.research-prose ol\s*\{[^}]*padding-left:\s*20px/,
    "ordered lists keep a slightly wider gutter for the numbers",
  );
  t.regex(
    css,
    /\.research-prose li\.task-list-item\s*\{[^}]*list-style:\s*none/,
    "task items keep the checkbox and drop the disc",
  );
  t.notRegex(
    css,
    /\.research-prose ul\.contains-task-list[^{}]*\{[^}]*list-style:\s*none/,
    "ordinary items in mixed task lists keep their bullets",
  );
});

// ---------------------------------------------------------------- §6 item 5

test("DM Sans adds one optical half-pixel to UI type but not to monospace", (t) => {
  const root = ruleBody(shellCss, ":root .shell-legacy");
  for (const step of ["xs", "sm", "base", "input"]) {
    t.regex(
      root,
      new RegExp(`--fs-${step}:\\s*calc\\([^;]+var\\(--font-ui-size-offset\\)[^;]*\\)`),
    );
  }
  t.regex(
    ruleBody(shellCss, ':root[data-body-font="dm-sans"] .shell-legacy'),
    /--font-ui-size-offset:\s*0\.5px/,
  );

  const heading = ruleBody(proseCss, ".research-prose h1");
  t.regex(heading, /font-size:[^;]+\+ var\(--font-ui-size-offset\)/);

  const code = ruleBody(proseCss, ".research-prose code");
  t.notRegex(code, /font-ui-size-offset/, "the offset compensates a UI face, not a mono one");

  // The surface removes the offset from its baseline delta so prose picks it up
  // exactly once, at the child declarations above.
  const surface = ruleBody(proseCss, ".research-reading-surface");
  t.regex(surface, /--research-markdown-font-delta:[^;]+- var\(--font-ui-size-offset\)/s);
});

// -------------------------------------------------- the Tailwind token bridge

test("the theme maps the app's color ramp under fg-* and every surface under surface-*", (t) => {
  const theme = ruleBody(appCss, "@theme inline");

  const textTokens = [
    ...new Set(
      [...ruleBody(shellCss, ":root .shell-legacy").matchAll(/(--text-[a-z0-9-]+):/g)].map(
        (match) => match[1],
      ),
    ),
  ];
  t.true(textTokens.length > 10, "sanity: the ramp was found");

  const missing = textTokens.filter((token) => !theme.includes(`var(${token})`));
  t.deepEqual(missing, [], "every --text-* color token needs a --color-fg-* alias");

  // The namespace collision ADR-8 calls out: Tailwind's --text-* is a size.
  for (const step of ["xs", "sm", "base", "input"]) {
    t.true(theme.includes(`--text-${step}: var(--fs-${step});`));
  }

  for (const surface of [
    "--workspace-bg",
    "--panel-bg",
    "--popover-bg",
    "--field-bg",
    "--content-card-bg",
  ]) {
    t.true(theme.includes(`var(${surface})`), `${surface} is not exposed as a surface color`);
  }

  for (const token of [
    "--accent-color",
    "--control-bg",
    "--control-border",
    "--status-failed-fg",
    "--danger-fg",
    "--research-highlight-bg",
    "--focus-ring",
    "--popover-shadow",
    "--dialog-shadow",
    "--z-dialog",
    "--z-toast",
    "--z-context-menu",
    "--radius-md",
    "--control-h-md",
  ]) {
    t.true(theme.includes(`var(${token})`), `${token} is not exposed to Tailwind`);
  }
});

test("app.css declares the two custom variants the structural rules need", (t) => {
  t.regex(appCss, /@custom-variant light \(/);
  t.regex(appCss, /@custom-variant warm \(/);
  t.notRegex(
    appCss,
    /@custom-variant reduce-motion \(/,
    "the setting is gone; the OS preference is the one source",
  );
});

test("the font faces moved out of tokens.css into fonts.css", (t) => {
  const fontsCss = readFileSync(join(stylesDirectory, "fonts.css"), "utf8");
  t.false(withoutComments(tokensCss).includes("@font-face"));
  t.is((withoutComments(fontsCss).match(/@font-face/g) ?? []).length, 18);
  t.regex(fontsCss, /url\("\.\.\/assets\/fonts\/DMSans-Variable-Latin\.woff2"\)/);
  t.regex(fontsCss, /url\("\.\.\/assets\/fonts\/Inter-Variable-Latin\.woff2"\)/);
  // Code faces block rather than swap: a metric swap inside a code block
  // reflows the whole answer.
  t.regex(fontsCss, /"JetBrains Mono"[\s\S]*?font-display: block/);
});

test("the reduced-motion block follows the OS preference and cancels Tailwind translates", (t) => {
  t.regex(proseCss, /@media \(prefers-reduced-motion: reduce\)/);
  t.notRegex(proseCss, /\.reduce-motion,/);
  t.regex(proseCss, /transition-duration: 0\.01ms !important/);
  t.regex(proseCss, /translate: none/);
});
