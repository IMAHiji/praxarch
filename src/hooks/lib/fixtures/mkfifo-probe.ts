// Shared implementation for every test file (and, if a fixture runner script ever needs the same
// claim, by that too) that gates a test on real FIFO support. `which mkfifo` succeeding proves
// only that the binary is on PATH; it does not prove mkfifo(2) actually works in the sandbox the
// process is running under. This probe creates a real FIFO in a throwaway temp directory and
// confirms via lstat that what landed on disk is actually a FIFO. It never opens the FIFO for
// reading or writing -- opening (not creating) is the operation that can block forever -- and the
// result is cached so the probe runs once per process rather than once per test. `node --test`
// runs each test file in its own child process, so "once per process" in practice means once per
// importing test file, not once across every file in the suite -- each file that imports this
// module gets its own process-local cache.
import { execFileSync } from "node:child_process";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface MkfifoProbeResult {
  ok: boolean;
  // Distinguishes "mkfifo the binary isn't on PATH" from "mkfifo ran but didn't produce a real
  // FIFO" (EPERM/EOPNOTSUPP in a sandbox, or some other syscall-level refusal), so a CI log says
  // which of those two worlds it's looking at rather than a single generic "skip". Never carries
  // an absolute path -- only the platform-level reason, so a temp directory doesn't leak into CI
  // logs.
  reason: string | null;
}

async function probeMkfifo(): Promise<MkfifoProbeResult> {
  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), "praxarch-mkfifo-probe-"));
    const fifoPath = join(dir, "probe.fifo");
    try {
      execFileSync("mkfifo", [fifoPath], { stdio: "ignore" });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return { ok: false, reason: "mkfifo is unavailable on this platform (binary not found on PATH)" };
      }
      return {
        ok: false,
        reason: `mkfifo exists but FIFO creation failed (${code ?? "non-zero exit"})`,
      };
    }
    const stat = await lstat(fifoPath);
    if (!stat.isFIFO()) {
      return {
        ok: false,
        reason: "mkfifo exists but the created path is not a FIFO (unexpected sandbox behavior)",
      };
    }
    return { ok: true, reason: null };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      ok: false,
      reason: `mkfifo exists but FIFO creation failed (${code ?? "unexpected error"})`,
    };
  } finally {
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

// Module-scope cache: within a single process, every importer of this module gets the same
// in-flight/settled promise, so the probe runs exactly once per process. Each test file runs in
// its own `node --test` child process, so this caches per file, not across the whole suite.
let cached: Promise<MkfifoProbeResult> | undefined;

export function getMkfifoProbe(): Promise<MkfifoProbeResult> {
  cached ??= probeMkfifo();
  return cached;
}
