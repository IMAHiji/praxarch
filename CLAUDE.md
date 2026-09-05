# praxarch

Tiered delegation harness for Claude Code: hooks, agent role files, skills, and a managed
CLAUDE.md block, installed into `~/.claude` by `praxarch install`.

## The one thing to get right

`templates/` is the source of truth. `~/.claude/agents/*.md`, `~/.claude/praxarch/hooks/*.js`,
and the `praxarch:orchestration` block in `~/.claude/CLAUDE.md` are installed artifacts and are
overwritten (with backup) on reinstall. Never fix a behavior by editing the installed copy — edit
the template or the TypeScript source here, then reinstall. Hooks under `~/.claude/praxarch/hooks/`
are compiled from `src/hooks/*.ts` by `pnpm build`.

`~/.claude/settings.json` is different: the installer merges `templates/settings.fragment.json`
into it additively (`src/cli/lib/settings-merge.ts`) and never overwrites an existing `model`,
`fallbackModel`, `statusLine`, or `advisorModel` value. There are no markers in settings.json.

## Commands

- `pnpm test` — node test runner over `src/**/*.test.ts`
- `pnpm lint`, `pnpm typecheck`, `pnpm build`
- `pnpm verify` — build into a scratch dir plus tests, without writing `dist/`. Use it to check a
  branch: on a dev-mode symlink install, `pnpm build` writes straight into the live hooks. It does
  not run lint.

## Conventions

- TypeScript strict, ESM, pnpm. Hooks must fail open on their own errors.
- Never write a model name into the orchestration template; model bindings live only in agent
  frontmatter.
- Content outside the `praxarch:orchestration` markers in a user's CLAUDE.md belongs to the user;
  the installer must not touch it.
- Verify-gate and route-guard run on this repo too. Prose-only template diffs still trip the
  gate when large enough; use a `checker` or `verifier` pass rather than waiving.
