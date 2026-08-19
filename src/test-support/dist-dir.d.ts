/**
 * Every hook/CLI test spawns or dynamically imports compiled output rather than the .ts source
 * (the thing under test is the *built* artifact). Left hardcoded to `../../dist` per test file,
 * that meant a `pnpm verify` that builds to a scratch directory (issue #14) had nowhere to point
 * them but the real `dist/` — which is exactly the directory a dev-mode symlink install
 * (`~/.claude/praxarch/hooks -> <checkout>/dist/hooks`) serves live, so verifying a branch would
 * still require overwriting the running install just to make the suite pass.
 *
 * `PRAXARCH_TEST_DIST_DIR` lets `pnpm verify` (scripts/verify.sh) repoint every test at a scratch
 * build instead, without touching real `dist/`. Defaults to this repo's real `dist/`, so plain
 * `pnpm test` (after `pnpm build`) is unchanged.
 */
export declare const TEST_DIST_DIR: string;
