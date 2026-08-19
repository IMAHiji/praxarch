// Test fixture, not shipped code. Spawned as a child process by untracked.test.ts's special-file
// (`!st.isFile()`) coverage test, per the same child-process isolation convention as
// diffstat-fifo-runner.ts and the fifo-fingerprint-runner.ts family: readUntrackedEntry's `s:`
// branch never opens the FIFO (it returns on the `!st.isFile()` check before createReadStream is
// ever reached), so there's no known hang risk here today -- this still runs as a spawned,
// deadline-bound child for consistency with that convention, and so a *regression* that made the
// dispatch fall through to createReadStream produces a bounded test failure instead of a wedged
// test runner.
//
// Creates an untracked FIFO in a real repo, calls readUntrackedEntry on it, and prints one JSON
// line of the result to stdout.
import { mkdtemp, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { readUntrackedEntry } = (await import(join(here, "..", "untracked.js"))) as typeof import("../untracked.js");

async function main(): Promise<void> {
  const repo = await mkdtemp(join(tmpdir(), "praxarch-untracked-fifo-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });

    const fifoRelPath = "special.fifo";
    execFileSync("mkfifo", [join(repo, fifoRelPath)]);

    const entry = await readUntrackedEntry(Buffer.from(repo, "utf8"), Buffer.from(fifoRelPath, "utf8"));

    process.stdout.write(`${JSON.stringify({ entry })}\n`);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exitCode = 1;
});
