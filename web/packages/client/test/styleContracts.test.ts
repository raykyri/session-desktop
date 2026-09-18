import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import test from "ava";

// The desktop's `tests/appearanceStyleContracts.test.ts` and
// `researchStyleContracts.test.ts`, re-expressed for the web
// (`08-design-system-and-styling.md` §6). The intents are unchanged; what moved
// is the set of files, because the twelve feature stylesheets became Tailwind
// utilities on components and only `prose.css` and `tweet.css` remain as CSS.

const stylesDirectory = join(import.meta.dirname, "..", "src", "styles");
const sourceDirectory = join(import.meta.dirname, "..", "src");

const tokensCss = readFileSync(join(stylesDirectory, "tokens.css"), "utf8");
const proseCss = readFileSync(join(stylesDirectory, "prose.css"), "utf8");
const tweetCss = readFileSync(join(stylesDirectory, "tweet.css"), "utf8");
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

function tokensDeclaredIn(selectorFilter: (selector: string) => boolean): Set<string> {
  const declared = new Set<string>();
  const blockPattern = /(:root[^{]*)\{((?:[^{}]|\{[^{}]*\})*)\}/g;
  for (const match of withoutComments(tokensCss).matchAll(blockPattern)) {
    if (!match[1] || !match[2] || !selectorFilter(match[1])) continue;
    for (const token of match[2].matchAll(/(--[a-z0-9-]+):/g)) {
      if (token[1]) declared.add(token[1]);
    }
  }
  return declared;
}

function sourceFiles(directory: string, extensions: string[]): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path, extensions));
    else if (extensions.some((extension) => entry.name.endsWith(extension))) files.push(path);
  }
  return files;
}

// ---------------------------------------------------------------- §6 item 1

test("every dark color token has a light-appearance override", (t) => {
  const dark = tokensDeclaredIn((selector) => !selector.includes("data-appearance"));
  const light = tokensDeclaredIn((selector) => selector.includes('data-appearance="light"'));
  // Layout, type, motion and stacking tokens are appearance-independent, as are
  // the lightbox scrims that sit over images.
  const appearanceIndependent =
    /^--(fs|control-h|radius|z|font|transition|research-feed|lightbox)-|^--control-fg$/;
  const missing = [...dark].filter(
    (token) => !light.has(token) && !appearanceIndependent.test(token),
  );

  t.deepEqual(missing, [], "dark tokens without a light override");
});

// ---------------------------------------------------------------- §6 item 2

test("light blocks follow the dark theme blocks and flip color-scheme", (t) => {
  const firstLight = tokensCss.indexOf(':root[data-appearance="light"]');
  const lastDarkTheme = tokensCss.lastIndexOf(':root[data-color-theme="orange-blob"] {');

  t.true(firstLight > lastDarkTheme, "light overrides must win the cascade over dark themes");
  t.regex(tokensCss, /:root\s*\{[^}]*color-scheme:\s*dark/s);
  t.regex(tokensCss, /:root\[data-appearance="light"\]\s*\{[^}]*color-scheme:\s*light/s);
  t.true(
    tokensCss.includes(':root[data-appearance="light"][data-color-theme="orange-blob"]'),
    "each color theme needs its own light variant",
  );
});

test("root element applies workspace background color instead of transparent background", (t) => {
  const root = ruleBody(tokensCss, ":root");
  t.regex(root, /background:\s*var\(--workspace-bg\)/);
  t.notRegex(root, /background:\s*transparent/);
});

// ---------------------------------------------------------------- §6 item 3

test("no color literals outside tokens.css", (t) => {
  const offenders: string[] = [];
  for (const [name, css] of [
    ["prose.css", proseCss],
    ["tweet.css", tweetCss],
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
  t.notRegex(surface, /--transcript-/, "the scale lives here; the deltas do not");

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

// ---------------------------------------------------------------- §6 item 5

test("DM Sans adds one optical half-pixel to UI type but not to monospace", (t) => {
  const root = ruleBody(tokensCss, ":root");
  for (const step of ["xs", "sm", "base", "input"]) {
    t.regex(root, new RegExp(`--fs-${step}:\\s*calc\\([^;]+var\\(--font-ui-size-offset\\)\\)`));
  }
  t.regex(
    ruleBody(tokensCss, ':root[data-body-font="dm-sans"]'),
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

// ---------------------------------------------------------------- §6 item 6

test("the tweet recipe is defined in tweet.css and nowhere else", (t) => {
  t.regex(tweetCss, /\.journal-tweet\s*\{/);
  const tweet = ruleBody(tweetCss, ".journal-tweet");
  t.regex(tweet, /max-width:\s*var\(--research-feed-max-width\)/);

  const stats = ruleBody(tweetCss, ".journal-tweet-stats");
  t.regex(stats, /align-items:\s*center/);
  t.regex(stats, /line-height:\s*1/);

  // No other stylesheet, and no component, may redeclare the recipe.
  for (const [name, css] of [
    ["prose.css", proseCss],
    ["app.css", appCss],
  ] as const) {
    t.false(withoutComments(css).includes(".journal-tweet"), `${name} must not redefine it`);
  }

  const redefining = sourceFiles(sourceDirectory, [".css"]).filter(
    (file) =>
      !file.endsWith("tweet.css") &&
      withoutComments(readFileSync(file, "utf8")).includes(".journal-tweet"),
  );
  t.deepEqual(redefining, []);
});

// -------------------------------------------------- the Tailwind token bridge

test("the theme maps the app's color ramp under fg-* and every surface under surface-*", (t) => {
  const theme = ruleBody(appCss, "@theme inline");

  const textTokens = [
    ...new Set(
      [...ruleBody(tokensCss, ":root").matchAll(/(--text-[a-z0-9-]+):/g)].map((match) => match[1]),
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

test("app.css declares the three custom variants the structural rules need", (t) => {
  t.regex(appCss, /@custom-variant light \(/);
  t.regex(appCss, /@custom-variant warm \(/);
  t.regex(appCss, /@custom-variant reduce-motion \(/);
});

test("the font faces moved out of tokens.css into fonts.css", (t) => {
  const fontsCss = readFileSync(join(stylesDirectory, "fonts.css"), "utf8");
  t.false(withoutComments(tokensCss).includes("@font-face"));
  t.is((withoutComments(fontsCss).match(/@font-face/g) ?? []).length, 14);
  t.regex(fontsCss, /url\("\.\.\/assets\/fonts\/DMSans-Variable-Latin\.woff2"\)/);
  // Code faces block rather than swap: a metric swap inside a code block
  // reflows the whole answer.
  t.regex(fontsCss, /"JetBrains Mono"[\s\S]*?font-display: block/);
});

test("the reduced-motion block is kept and covers both the setting and the preference", (t) => {
  t.regex(proseCss, /@media \(prefers-reduced-motion: reduce\)/);
  t.regex(proseCss, /\.reduce-motion,\n\.reduce-motion \*/);
  t.regex(proseCss, /transition-duration: 0\.01ms !important/);
});

test("DOM search paints through the documented highlight registry names", (t) => {
  t.regex(proseCss, /::highlight\(session-search\)/);
  t.regex(proseCss, /::highlight\(session-search-active\)/);

  const searchModule = readFileSync(join(sourceDirectory, "lib", "transcriptSearch.ts"), "utf8");
  t.regex(searchModule, /SEARCH_HIGHLIGHT = "session-search"/);
  t.regex(searchModule, /SEARCH_ACTIVE_HIGHLIGHT = "session-search-active"/);
});
