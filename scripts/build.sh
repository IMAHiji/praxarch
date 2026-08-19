#!/bin/sh
# The single definition of "what a praxarch build is." `pnpm build` calls this with no argument
# (outDir defaults to dist/); scripts/verify.sh calls it with a scratch directory. Adding a build
# step here reaches both automatically — the one thing issue #14 explicitly warned against was
# scripts/verify.sh hand-duplicating these steps and silently drifting from the real build.
set -eu

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
out_dir="${1:-$repo_root/dist}"

npx tsc -p "$repo_root/tsconfig.json" --outDir "$out_dir"
node "$repo_root/scripts/write-build-info.mjs" "$out_dir"
