#!/bin/sh
# Full branch verification (build + test) that never writes to dist/ — and therefore never writes
# through ~/.claude/praxarch/hooks when this checkout is a `pnpm add -g link:$(pwd)` dev install.
# See issue #14: `pnpm build` writes straight into dist/, which a dev-mode symlink install serves
# live, so a plain `pnpm typecheck && pnpm lint && pnpm build && pnpm test` review of a branch
# silently becomes an install of that branch's hooks.
#
# The scratch directory is `tsc -p tsconfig.json --outDir <scratch>` against the same
# tsconfig/build inputs as the real `pnpm build` (not a parallel config), so it cannot drift from
# the real build. Tests are then pointed at it via PRAXARCH_TEST_DIST_DIR (src/test-support/dist-dir.ts)
# instead of the real dist/.
set -eu

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
scratch_dir="$repo_root/.verify-out"

cleanup() {
  rm -rf "$scratch_dir"
}
trap cleanup EXIT

rm -rf "$scratch_dir"
sh "$repo_root/scripts/build.sh" "$scratch_dir"
PRAXARCH_TEST_DIST_DIR="$scratch_dir" node --test --experimental-strip-types --experimental-test-module-mocks "$repo_root/src/**/*.test.ts"
