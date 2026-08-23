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
    // .claude/worktrees/** holds separate git worktree checkouts (their own tsconfig/file lists)
    // left behind by /orchestrate and /fan-out runs — not part of this project's own source tree,
    // and `tsconfig.json`'s file list doesn't cover them, so linting them here only ever produces
    // a parserOptions.project "file not found" error, never a real finding.
    ignores: ["dist/**", ".verify-out/**", "node_modules/**", "eslint.config.js", ".claude/worktrees/**"],
  },
);
