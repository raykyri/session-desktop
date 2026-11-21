import { readFileSync } from "node:fs";
import { join } from "node:path";

import test from "ava";

// The desktop's `tests/appearanceStyleContracts.test.ts` and
// `researchStyleContracts.test.ts`, re-expressed for the web
// (`08-design-system-and-styling.md` §6). The intents are unchanged; what moved
// is the set of files, because the twelve feature stylesheets became Tailwind
// utilities on components and only `prose.css` and `shell.css` (the app
// bar's placement and the feed grid, 02 §2.2) remain as CSS.

const stylesDirectory = join(import.meta.dirname, "..", "src", "styles");

const tokensCss = readFileSync(join(stylesDirectory, "tokens.css"), "utf8");
const proseCss = readFileSync(join(stylesDirectory, "prose.css"), "utf8");
const appCss = readFileSync(join(stylesDirectory, "app.css"), "utf8");
const shellCss = readFileSync(join(stylesDirectory, "shell.css"), "utf8");
const spacesCss = readFileSync(join(stylesDirectory, "spaces.css"), "utf8");

const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/;

/** CSS named colours (CSS Color 4), matched as whole words in a value. */
const NAMED_COLORS = new RegExp(
  `(?<![-\\w])(?:${[
    "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue",
    "blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk",
    "crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki",
    "darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen",
    "darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue",
    "dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite",
    "gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki",
    "lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan",
    "lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen",
    "lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen",
    "magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen",
    "mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream",
    "mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid",
    "palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum",
    "powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown",
    "seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen",
    "steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen",
  ]
    .join(" ")
    .split(" ")
    .join("|")})(?![-\\w])`,
  "i",
);

/** The values of a stylesheet's declarations, by line. */
function declarationValues(line: string): string[] {
  return [...line.matchAll(/^[\s]*[-a-z]+\s*:\s*([^;{}]+)/gi)].map((m) => m[1] ?? "");
}

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

// ---------------------------------------------------------------- §6 item 1

test("every dark color token has a light-appearance override", (t) => {
  const dark = tokensDeclaredIn((selector) => !selector.includes("data-appearance"));
  const light = tokensDeclaredIn((selector) => selector.includes('data-appearance="light"'));
  // Layout, type, motion and stacking tokens are appearance-independent, as are
  // the lightbox scrims that sit over images.
  const appearanceIndependent =
    /^--(fs|control-h|radius|z|font|transition|research-feed|lightbox|app-bar)-|^--control-fg$/;
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
    ["app.css", appCss],
    ["shell.css", shellCss],
    ["spaces.css", spacesCss],
  ] as const) {
    css.split("\n").forEach((line, index) => {
      // Two escape hatches, both spelled on the line that uses them: colors
      // that must not change with the appearance (image scrims, the graphviz
      // paper canvas) and `::highlight()` pseudos, where custom properties
      // resolve unreliably so each appearance spells its own literal.
      const named = declarationValues(line).some((value) => NAMED_COLORS.test(value));
      if (
        (COLOR_LITERAL.test(line) || named) &&
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
  const root = ruleBody(tokensCss, ":root");
  // The title and the composer input take the mockup's sizes with no offset
  // (02 §11).
  for (const step of ["xs", "sm", "base", "md", "lg"]) {
    t.regex(
      root,
      new RegExp(`--fs-${step}:\\s*calc\\([^;]+var\\(--font-ui-size-offset\\)[^;]*\\)`),
    );
  }
  for (const step of ["title", "input"]) {
    t.notRegex(root, new RegExp(`--fs-${step}:[^;]*font-ui-size-offset`));
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

// ---------------------------------------------------------------- 02 §11

test("the spaces roles have a dark value and a light override, exposed to Tailwind", (t) => {
  const dark = ruleBody(tokensCss, ":root");
  const light = ruleBody(tokensCss, ':root[data-appearance="light"]');
  const theme = ruleBody(appCss, "@theme inline");
  const roles = [
    "--unread-dot",
    "--passage-mark",
    ...[1, 2, 3, 4, 5, 6].map((n) => `--avatar-${n}`),
    "--avatar-fg",
    "--tree-rail",
    "--tree-rail-on",
    "--tree-dot-selected",
  ];
  for (const role of roles) {
    t.true(dark.includes(`${role}:`), `${role} has a dark value`);
    t.true(light.includes(`${role}:`), `${role} has a light override`);
    t.true(theme.includes(`var(${role})`), `${role} is exposed to Tailwind`);
  }
});

test("typography follows the members mockup: Inter, a 16.5 px title, a 15 px input", (t) => {
  const root = ruleBody(tokensCss, ":root");
  t.regex(root, /--font-ui:\s*"Inter"/);
  t.regex(root, /--fs-title:\s*calc\(16\.5px/);
  t.regex(root, /--fs-input:\s*calc\(15px/);
  t.regex(root, /--fs-base:\s*calc\(13\.5px/);
});

test("the app bar is placed over the page and slides with a transform", (t) => {
  const slot = ruleBody(shellCss, ".app-bar-slot");
  t.regex(slot, /position:\s*absolute/);
  t.regex(slot, /transition:\s*transform 0\.2s/);
  t.regex(ruleBody(shellCss, ".app-bar-slot[data-hidden]"), /translateY\(-100%\)/);
  t.regex(ruleBody(shellCss, ".feed-inner"), /padding:\s*var\(--app-bar-h\)/);
  t.regex(ruleBody(tokensCss, ":root"), /--app-bar-h:\s*49px/);
  t.regex(
    withoutComments(shellCss),
    /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.app-bar-slot\s*\{\s*transition:\s*none/,
  );
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

test("every rule of spaces.css starts with a class", (t) => {
  const css = withoutComments(spacesCss);
  const offenders: string[] = [];
  for (const match of css.matchAll(/([^{};]+)\{/g)) {
    const selector = (match[1] ?? "").trim();
    if (selector.startsWith("@") || /^(from|to|\d+%)$/.test(selector)) continue;
    for (const part of selector.split(","))
      if (!part.trim().startsWith(".")) offenders.push(part.trim());
  }
  t.deepEqual(offenders, []);
});
