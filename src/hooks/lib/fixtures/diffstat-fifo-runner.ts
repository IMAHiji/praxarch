// Test fixture, not shipped code. Spawned as a child process by git-diff.test.ts's diffStat FIFO
// regression test (issue #2's original repro) rather than run in-process — the child-process
// isolation convention from the FIFO fingerprint runners (see fifo-fingerprint-runner.ts) applies
// to every FIFO-based test in this file, not just diffFingerprint's, per that issue's guardrails.
// diffStat itself never streams file content through a FIFO (git's own numstat probe just errors
// out synchronously on it), so there's no real hang risk here the way there is for
// diffFingerprint's createReadStream path -- this still runs as a spawned, deadline-bound child
// for consistency with that convention rather than because this specific scenario is known to hang.
//
// Builds a repo with a tracked file replaced by a FIFO plus a genuine large change to a second
// tracked file, calls diffStat, and prints one JSON line of the result to stdout.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { diffStat } = (await import(join(here, "..", "git-diff.js"))) as typeof import("../git-diff.js");

async function main(): Promise<void> {
  const repo = await mkdtemp(join(tmpdir(), "praxarch-gitdiff-fifostat-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });

    const victimPath = join(repo, "victim.txt");
    const realChangePath = join(repo, "real-change.txt");
    await writeFile(victimPath, "line\n".repeat(5));
    await writeFile(realChangePath, "line\n".repeat(5));
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });

    // A genuine, sizeable change elsewhere in the tree -- this is the part the pre-fix defect let
    // slip past verify-gate as zeros once the FIFO below made the whole numstat probe fail.
    await writeFile(realChangePath, "changed line\n".repeat(500));

    await rm(victimPath);
    execFileSync("mkfifo", [victimPath]);

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
