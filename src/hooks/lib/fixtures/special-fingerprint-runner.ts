// Test fixture, not shipped code. Same reasoning as fifo-fingerprint-runner.ts: this scenario
// also drives diffFingerprint over a real FIFO (to lock the SPECIAL marker's literal byte
// image), so it's just as exposed to the isFile() dispatch gate hanging forever on a regressed
// build. Spawned by git-diff.test.ts with a deadline rather than run in-process.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { diffFingerprint } = (await import(
  join(here, "..", "git-diff.js")
)) as typeof import("../git-diff.js");

async function main(): Promise<void> {
  const repo = await mkdtemp(join(tmpdir(), "praxarch-gitdiff-special-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });

    const fifoPath = join(repo, "special.txt");
    await writeFile(fifoPath, "regular\n");
    execFileSync("git", ["add", "special.txt"], { cwd: repo });
    execFileSync("git", ["commit", "-q", "-m", "add special.txt"], { cwd: repo });
    await rm(fifoPath);
    execFileSync("mkfifo", [fifoPath]);

    // Trailing-newline strip only -- porcelain's leading status-code byte is often a literal
    // space (" M", " D", ...), and .trim() would eat it along with the newline, corrupting the
    // very 2-byte code this known-answer check depends on.
    const statusOut = execFileSync("git", ["status", "--porcelain"], { cwd: repo }).toString("utf8").replace(/\n$/, "");
    const code = statusOut.slice(0, 2);
    const path = statusOut.slice(3);
    const head = execFileSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: repo }).toString("utf8").trim();

    const expected = createHash("sha256");
    expected.update(head);
    expected.update("\0");
    expected.update(path);
    expected.update("\0");
    expected.update(code);
    expected.update("\0");
    expected.update("SPECIAL");
    expected.update("\0");

    // The real hang site: pre-fix, diffFingerprint's createReadStream on this FIFO blocks
    // forever with no writer. If the isFile() gate has regressed, this call never resolves and
    // the parent's deadline (not this script) is what ends the test.
    const actual = await diffFingerprint(repo);

    process.stdout.write(`${JSON.stringify({ actual, expected: expected.digest("hex") })}\n`);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exitCode = 1;
});
