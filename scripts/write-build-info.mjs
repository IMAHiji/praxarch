#!/usr/bin/env node
// Stamps the compiled hooks with the git ref they were built from (issue #14 Part B), so a
// session can tell whether its running gate is merged code or branch code. Runs as the last step
// of `pnpm build` (and of the scratch build in scripts/verify.sh, pointed at the scratch dir
// instead) — plain Node, not TypeScript, so it needs no compile step of its own before it can run
// right after tsc.
//
// Every git call is best-effort: a tarball install, a detached HEAD, or a dirty tree must never
// stop the build, so failures degrade to `null` fields rather than throwing.
import { execFileSync } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = process.argv[2] ?? join(repoRoot, "dist");

function git(args) {
  try {
    return execFileSync("git", args, { cwd: repoRoot }).toString("utf8").trim();
  } catch {
    return null;
  }
}

const ref = git(["rev-parse", "HEAD"]);
const branchOut = git(["rev-parse", "--abbrev-ref", "HEAD"]);
const branch = branchOut && branchOut !== "HEAD" ? branchOut : null; // "HEAD" means detached
const statusOut = git(["status", "--porcelain"]);
const dirty = statusOut === null ? null : statusOut.length > 0;

const info = { ref, branch, dirty, builtAt: new Date().toISOString() };

const hooksDir = join(outDir, "hooks");
await mkdir(hooksDir, { recursive: true });
await writeFile(join(hooksDir, "build-info.json"), `${JSON.stringify(info, null, 2)}\n`, "utf8");
