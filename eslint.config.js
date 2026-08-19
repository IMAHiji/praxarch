// @ts-check
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  {
    // Plain Node scripts (scripts/*.mjs, src/test-support/dist-dir.js) — not part of tsconfig's
    // file list, so they get js.configs.recommended's untyped rules rather than the type-aware
    // TS config below, plus Node's globals so `process`/`console` aren't flagged as undefined.
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: {
      globals: globals.node,
    },
  },
  ...tseslint.configs.strict,
  ...tseslint.configs.stylistic,
  {
    // Scoped to .ts: type-aware linting needs tsconfig's file list, which is src/**/*.ts only —
    // plain JS (scripts/*.mjs, src/test-support/dist-dir.js) is linted below by js.configs.recommended
    // instead, not exempted from lint altogether just because it can't take a tsconfig project.
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_" },
      ],
    },
  },
  {
    ignores: ["dist/**", ".verify-out/**", "node_modules/**", "eslint.config.js"],
  },
);
