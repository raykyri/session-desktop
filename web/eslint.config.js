import js from "@eslint/js";
import { createTypeScriptImportResolver } from "eslint-import-resolver-typescript";
import importX from "eslint-plugin-import-x";
import jsxA11y from "eslint-plugin-jsx-a11y";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

/** ADR-1: client ──► shared; server ──► shared, db; db ──► shared; shared ──► nothing.
 * mutators ──► shared (`01` §3: shared by the client and the server, so it
 * depends on neither, nor on the prototype).
 * sync ──► shared, mutators (`01` §4: the client and server halves of the sync
 * core; `@session/db` implements its `ServerStore`).
 * replica-proto (phase 0 prototype) ──► shared, mutators, sync, and nothing imports it. */
const forbidden = {
  "packages/shared": [
    "@session/db",
    "@session/server",
    "@session/client",
    "@session/replica-proto",
    "@session/mutators",
    "@session/sync",
  ],
  "packages/mutators": [
    "@session/db",
    "@session/server",
    "@session/client",
    "@session/replica-proto",
    "@session/sync",
  ],
  "packages/sync": ["@session/db", "@session/server", "@session/client", "@session/replica-proto"],
  "packages/db": ["@session/server", "@session/client", "@session/replica-proto"],
  "packages/server": ["@session/client", "@session/replica-proto"],
  "packages/client": ["@session/db", "@session/server", "@session/replica-proto"],
  "packages/replica-proto": ["@session/db", "@session/server", "@session/client"],
};

/** `@session/mutators` runs deterministically on the client and the server
 * (`01` U1): no clock, random source, `Intl` or `Date` anywhere in it. Times
 * come from `tx.now` (`run`) or `ctx.now` (`pre`), randomness from
 * `ctx.random()`, ids from the input and `tx.id(ordinal)`. */
const DETERMINISTIC = "@session/mutators is deterministic (01 U1)";
const nondeterministic = {
  globals: [
    { name: "Date", message: `${DETERMINISTIC}: use tx.now, ctx.now or ./time.ts.` },
    { name: "Intl", message: `${DETERMINISTIC}: no locale formatting.` },
    { name: "crypto", message: `${DETERMINISTIC}: randomness comes from ctx.random().` },
    { name: "performance", message: `${DETERMINISTIC}: no clock.` },
  ],
  properties: [
    { object: "Math", property: "random", message: `${DETERMINISTIC}: use ctx.random().` },
    ...["Date", "Intl", "crypto", "performance"].map((property) => ({
      object: "globalThis",
      property,
      message: `${DETERMINISTIC}.`,
    })),
  ],
  imports: [
    {
      group: ["crypto", "node:crypto", "node:perf_hooks", "perf_hooks"],
      message: `${DETERMINISTIC}: randomness comes from ctx.random().`,
    },
    {
      group: ["@session/shared/*"],
      message: `${DETERMINISTIC}: import only the spaces contract and the model registry from @session/shared.`,
    },
  ],
  /** `@session/shared` holds formatting and Markdown code too: the mutators
   * import only the spaces contract and the model registry from it. */
  paths: [
    {
      name: "@session/shared",
      allowImportNames: ["spaces", "Spaces", "MODEL_REGISTRY", "ReasoningEffort"],
      message: `${DETERMINISTIC}: import only the spaces contract and the model registry from @session/shared.`,
    },
  ],
  /** Locale-dependent methods, and the global object, through which a
   * computed name (`globalThis["Da" + "te"]`) reaches what the global and
   * property bans name. */
  syntax: [
    {
      selector: "MemberExpression[property.name='localeCompare']",
      message: `${DETERMINISTIC}: compare with < and >, not the locale.`,
    },
    {
      selector: "MemberExpression[property.name=/^toLocale/]",
      message: `${DETERMINISTIC}: no locale formatting.`,
    },
    {
      // the global object itself, so no global is reached by a computed name
      selector: "Identifier[name=/^(globalThis|window|self|global)$/]",
      message: `${DETERMINISTIC}: no global object (a computed name reaches any global).`,
    },
  ],
};

const boundaries = Object.entries(forbidden).map(([directory, packages]) => ({
  files: [`${directory}/**/*.{ts,tsx}`],
  rules: {
    "@typescript-eslint/no-restricted-imports": [
      "error",
      {
        patterns: [
          ...packages.map((name) => ({
            group: [name, `${name}/*`],
            message: `${directory} may not import ${name} (ADR-1 package dependency graph).`,
          })),
          ...(directory === "packages/mutators" ? nondeterministic.imports : []),
        ],
        ...(directory === "packages/mutators" ? { paths: nondeterministic.paths } : {}),
      },
    ],
  },
}));

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/coverage/**",
      "**/.data/**",
      "**/playwright-report/**",
      "**/test-results/**",
      "docs/**",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    extends: [tseslint.configs.recommendedTypeChecked, importX.flatConfigs.recommended],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    settings: {
      // Without this, import-x treats only `.js`/`.mjs`/`.cjs` as source
      // files: `no-cycle` cannot follow a TypeScript import and
      // `no-unused-modules` classifies every `.ts` file as outside `src` and
      // reports nothing.
      "import-x/extensions": [".ts", ".tsx", ".js", ".mjs", ".cjs"],
      "import-x/resolver-next": [
        createTypeScriptImportResolver({
          project: ["packages/*/tsconfig.json"],
          noWarnOnMultipleProjects: true,
        }),
      ],
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "import-x/no-cycle": "error",
      "import-x/order": ["error", { "newlines-between": "always", alphabetize: { order: "asc" } }],
    },
  },
  // `shared` and `db` are libraries, and this catches a module that was never
  // wired into the package's `index.ts`. It does NOT catch an unused export
  // from a module that is wired in: `index.ts` re-exports every module with
  // `export *`, and the rule counts that re-export as a use. (`ignoreExports`
  // does not change this — it suppresses reporting on the barrel without
  // stopping the barrel from marking its sources used.) Finding genuinely dead
  // exports behind the barrel needs a whole-program tool such as `knip`.
  //
  // The rule reads `.eslintrc.json` for its ignore patterns; that file exists
  // only because the rule cannot see flat-config ignores. The `.ts` entry in
  // `import-x/extensions` above is what makes it run at all.
  //
  // The package's subpath entry points (`wire`, `schemas`, `lib/*`; see
  // `packages/shared/package.json`) are also imported by the desktop app,
  // which this config does not lint, so their exports are not reported.
  {
    files: ["packages/shared/src/**/*.ts", "packages/db/src/**/*.ts"],
    rules: {
      "import-x/no-unused-modules": [
        "error",
        {
          unusedExports: true,
          ignoreExports: [
            "packages/shared/src/wire/index.ts",
            "packages/shared/src/schemas/index.ts",
            "packages/shared/src/lib/*.ts",
            // the first-draft mock's contract: only the mock's validator test
            // (`test/spacesMock.test.ts`) imports it
            "packages/shared/src/schemas/spaces.deferred.ts",
            "packages/shared/src/types/spaces.deferred.ts",
          ],
        },
      ],
    },
  },
  {
    files: ["packages/client/**/*.{ts,tsx}"],
    extends: [reactHooks.configs.flat.recommended, jsxA11y.flatConfigs.recommended],
    rules: {
      // 08 §2: every themeable value is a token consumed through `var()`, so a
      // hex or `rgb()` written into a class name or a `style` prop is a color
      // that stops tracking `data-appearance` / `data-color-theme`. The two
      // exceptions (appearance-invariant scrims, `::highlight()` pseudos) live
      // in `styles/prose.css` and `styles/tweet.css`, outside this rule's scope.
      // Matching literal text catches colors inside multi-line `cn(…)` calls
      // that a line-based search would miss.
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "JSXAttribute[name.name=/^(className|style)$/] " +
            "Literal[value=/#[0-9a-fA-F]{3,8}\\b|(rgba?|hsla?|oklch|lab|lch)\\(/]",
          message:
            "No color literals in className or style (08 §2): use a token utility " +
            "(bg-surface-*, text-fg-*, …) or a var(--token) reference.",
        },
        {
          selector:
            "JSXAttribute[name.name=/^(className|style)$/] " +
            "TemplateElement[value.raw=/#[0-9a-fA-F]{3,8}\\b|(rgba?|hsla?|oklch|lab|lch)\\(/]",
          message:
            "No color literals in className or style (08 §2): use a token utility " +
            "(bg-surface-*, text-fg-*, …) or a var(--token) reference.",
        },
      ],
    },
  },
  ...boundaries,
  {
    files: ["packages/mutators/**/*.ts"],
    rules: {
      "no-restricted-globals": ["error", ...nondeterministic.globals],
      "no-restricted-properties": ["error", ...nondeterministic.properties],
      "no-restricted-syntax": ["error", ...nondeterministic.syntax],
    },
  },
  // the test that mutators read no clock, random source or Intl replaces
  // them with traps, so it names them
  {
    files: ["packages/mutators/test/determinism.test.ts"],
    rules: {
      "no-restricted-globals": "off",
      "no-restricted-properties": "off",
      "no-restricted-syntax": "off",
    },
  },
  // The tRPC client imports the server router's type. `verbatimModuleSyntax`
  // erases an
  // `import type` at emit, so the bundle has no edge (ADR-1,
  // `07-client-architecture.md` §1). It is scoped to this file and to the
  // `/router` subpath, and `@session/db` stays forbidden, so the exception
  // cannot widen into a runtime dependency without an edit here.
  {
    files: ["packages/client/src/api/trpc.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@session/db", "@session/db/*"],
              message:
                "packages/client may not import @session/db (ADR-1 package dependency graph).",
            },
            {
              group: ["@session/replica-proto", "@session/replica-proto/*"],
              message:
                "packages/client may not import @session/replica-proto (a phase 0 prototype).",
            },
            {
              group: ["@session/server", "@session/server/*", "!@session/server/router"],
              message:
                "packages/client may import only the AppRouter type from @session/server/router (ADR-1).",
            },
            {
              // A value import would be a runtime edge; only the type is erased.
              group: ["@session/server/router"],
              allowTypeImports: true,
              message: "@session/server/router may be imported only as a type (ADR-1).",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: { ecmaVersion: 2023, sourceType: "module" },
  },
);
