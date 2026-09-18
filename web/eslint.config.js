import js from "@eslint/js";
import { createTypeScriptImportResolver } from "eslint-import-resolver-typescript";
import importX from "eslint-plugin-import-x";
import jsxA11y from "eslint-plugin-jsx-a11y";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

/** ADR-1: client ──► shared; server ──► shared, db; db ──► shared; shared ──► nothing. */
const forbidden = {
  "packages/shared": ["@session/db", "@session/server", "@session/client"],
  "packages/db": ["@session/server", "@session/client"],
  "packages/server": ["@session/client"],
  "packages/client": ["@session/db", "@session/server"],
};

const boundaries = Object.entries(forbidden).map(([directory, packages]) => ({
  files: [`${directory}/**/*.{ts,tsx}`],
  rules: {
    "@typescript-eslint/no-restricted-imports": [
      "error",
      {
        patterns: packages.map((name) => ({
          group: [name, `${name}/*`],
          message: `${directory} may not import ${name} (ADR-1 package dependency graph).`,
        })),
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
  // `shared` and `db` are libraries: an export nothing imports is dead code.
  // The rule reads `.eslintrc.json` for its ignore patterns; that file exists
  // only because the rule cannot see flat-config ignores.
  {
    files: ["packages/shared/src/**/*.ts", "packages/db/src/**/*.ts"],
    rules: { "import-x/no-unused-modules": ["error", { unusedExports: true }] },
  },
  {
    files: ["packages/client/**/*.{ts,tsx}"],
    extends: [reactHooks.configs.flat.recommended, jsxA11y.flatConfigs.recommended],
  },
  ...boundaries,
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: { ecmaVersion: 2023, sourceType: "module" },
  },
);
