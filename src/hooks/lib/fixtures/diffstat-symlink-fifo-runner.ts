// Test fixture, not shipped code. Spawned as a child process by git-diff.test.ts's diffStat
// hang-guard test, per the same child-process isolation convention as diffstat-fifo-runner.ts and
// the fifo-fingerprint-runner.ts family: a regression that made the untracked loop's symlink
// dispatch fall through to a followed read would block forever on a symlink-to-FIFO with no
// writer, and that block happens inside libuv's threadpool where node:test can neither abort it
// nor finish reporting -- an in-process per-test timeout cannot fire against it. Spawning lets the
// parent SIGKILL the child on a deadline and turn the hang itself into an assertion failure
// instead of wedging the whole suite.
//
// Builds a repo with an untracked symlink pointing at a FIFO, plus a genuine untracked file, calls
// diffStat, and prints one JSON line of the result to stdout.
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { diffStat } = (await import(join(here, "..", "git-diff.js"))) as typeof import("../git-diff.js");

async function main(): Promise<void> {
  const repo = await mkdtemp(join(tmpdir(), "praxarch-gitdiff-symlinkfifostat-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
    await writeFile(join(repo, "tracked.txt"), "line\n");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });

    const fifoPath = join(repo, "target.fifo");
    execFileSync("mkfifo", [fifoPath]);
    await symlink(fifoPath, join(repo, "link-to-fifo"));

    // A genuine untracked file alongside the symlink -- proves the loop still measures real work
    // rather than merely surviving the FIFO without crashing.
    await writeFile(join(repo, "new.txt"), "line\n".repeat(5));

    const result = await diffStat(repo, [], null);

    process.stdout.write(`${JSON.stringify({ result })}\n`);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exitCode = 1;
});
