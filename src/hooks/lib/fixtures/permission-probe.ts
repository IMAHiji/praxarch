// Shared implementation for every test file that gates a test on `chmod 000` actually making a
// file unreadable. A uid check (`process.getuid() === 0`) is an assumption about *why* permission
// enforcement might not apply -- it says nothing about whether it actually doesn't. Root is the
// common case (CI images routinely run as root and bypass DAC checks entirely), but it is not the
// only way a sandbox can end up ignoring file mode bits, and it also isn't guaranteed root always
// bypasses them (a capability-dropped root, or a filesystem mounted in a way that still enforces
// permissions). This probe creates a real chmod-000 file in a throwaway temp directory and tries
// to actually open it for reading: if the open fails (EACCES/EPERM), permission enforcement is
// live and the gated tests should run; if it succeeds, enforcement is bypassed here and the gated
// tests must skip, whatever the reason. Result is cached so the probe runs once per process (see
// mkfifo-probe.ts's matching comment for the "once per test file, not once per suite" caveat --
// `node --test` runs each file in its own child process).
import { chmod, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface PermissionProbeResult {
  ok: boolean;
  // Names why permission enforcement could not be confirmed here, without leaking an absolute
  // path into a CI log.
  reason: string | null;
}

async function probePermissionEnforcement(): Promise<PermissionProbeResult> {
  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), "praxarch-perm-probe-"));
    const filePath = join(dir, "locked");
    await writeFile(filePath, "probe\n");
    await chmod(filePath, 0o000);

    try {
      const handle = await open(filePath, "r");
      await handle.close();
      return {
        ok: false,
        reason: "a chmod 000 file was still readable here -- permission enforcement is bypassed (e.g. running as root)",
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM") {
        return { ok: true, reason: null };
      }
      return { ok: false, reason: `unexpected error probing permission enforcement (${code ?? "unknown"})` };
    }
  } finally {
    if (dir !== undefined) {
      // Restore a readable mode before recursive removal -- rm on an unreadable directory entry
      // can itself fail depending on platform.
      await chmod(join(dir, "locked"), 0o644).catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  }
}

let cached: Promise<PermissionProbeResult> | undefined;

export function getPermissionProbe(): Promise<PermissionProbeResult> {
  cached ??= probePermissionEnforcement();
  return cached;
}
