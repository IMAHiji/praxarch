// Shared implementation for every test file that gates a test on chmod actually blocking a read
// in this process. `process.getuid() === 0` is the wrong guard: CI can (and, as of this writing,
// does) run test containers as root, and root bypasses Unix permission bits entirely -- a uid
// check would skip the test exactly where the FIFO/mkfifo-probe comment's "sandbox can ship the
// binary while blocking the syscall" caveat has its mirror image: the permission bits exist but
// don't do anything. This probe creates a real file in a throwaway temp directory, chmods it to
// 0o000, and confirms via an actual read attempt that the OS refused it. Result is cached so the
// probe runs once per process (see mkfifo-probe.ts's matching comment for the "once per test
// file, not once per suite" caveat -- `node --test` runs each file in its own child process).
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface UnreadableFileProbeResult {
  ok: boolean;
  // Names why chmod 0o000 didn't block a read here (root bypassing permission bits, or some other
  // platform quirk), without leaking an absolute path into a CI log.
  reason: string | null;
}

async function probeUnreadableFile(): Promise<UnreadableFileProbeResult> {
  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), "praxarch-unreadable-probe-"));
    const filePath = join(dir, "probe.txt");
    await writeFile(filePath, "probe\n");
    await chmod(filePath, 0o000);
    try {
      await readFile(filePath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM") {
        return { ok: true, reason: null };
      }
      return { ok: false, reason: `chmod 0o000 produced an unexpected error (${code ?? "unknown"}) instead of EACCES` };
    }
    return { ok: false, reason: "chmod 0o000 did not block a read -- likely running as root" };
  } finally {
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

let cached: Promise<UnreadableFileProbeResult> | undefined;

export function getUnreadableFileProbe(): Promise<UnreadableFileProbeResult> {
  cached ??= probeUnreadableFile();
  return cached;
}
