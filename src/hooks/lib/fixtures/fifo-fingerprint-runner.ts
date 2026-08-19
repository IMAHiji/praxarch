// Test fixture, not shipped code. Spawned as a child process by git-diff.test.ts's real-FIFO
// regression test so that a hang in the isFile() dispatch gate (git-diff.ts:352) — which blocks
// inside libuv's threadpool where node:test can neither abort nor report on it — becomes a
// SIGKILL-able child the parent can bound with a deadline, instead of wedging the whole suite.
//
// Builds the same repo fixture the in-process FIFO test used to build, drives diffFingerprint
// through: regular file -> FIFO -> regular file again, and prints one JSON line of results to
// stdout. The parent asserts on exit code and the printed line; it never inspects this script's
// internals, so anything here can change freely as long as the printed contract holds.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { diffFingerprint } = (await import(
  join(here, "..", "git-diff.js")
)) as typeof import("../git-diff.js");

async function main(): Promise<void> {
  const repo = await mkdtemp(join(tmpdir(), "praxarch-gitdiff-fifo-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
    const victimPath = join(repo, "file.txt");
    await writeFile(victimPath, "line\n".repeat(5));
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });

    const before = await diffFingerprint(repo);

    await rm(victimPath);
    execFileSync("mkfifo", [victimPath]);
    // The real hang site: pre-fix, diffFingerprint's createReadStream on this FIFO blocks
    // forever with no writer. If the isFile() gate has regressed, this call never resolves and
    // the parent's deadline (not this script) is what ends the test.
    const withFifo = await diffFingerprint(repo);

    await rm(victimPath);
    await writeFile(victimPath, "line\n".repeat(5));
    const afterRestoring = await diffFingerprint(repo);

    process.stdout.write(`${JSON.stringify({ before, withFifo, afterRestoring })}\n`);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exitCode = 1;
});
