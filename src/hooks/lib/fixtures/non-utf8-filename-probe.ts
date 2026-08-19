// Shared implementation for every test file that gates a test on the filesystem actually
// accepting a filename whose bytes are not valid UTF-8. ext4/xfs on Linux permit this; APFS on
// macOS rejects it outright with EILSEQ at the write() syscall -- there is no cross-platform way
// to construct this scenario, so a test that needs it must skip cleanly on a filesystem that
// can't hold it rather than fail for an unrelated reason. This probe writes a real file with such
// a name in a throwaway temp directory and confirms it landed, and caches the result so the probe
// runs once per process (see mkfifo-probe.ts's matching comment for the "once per test file, not
// once per suite" caveat -- `node --test` runs each file in its own child process).
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface NonUtf8FilenameProbeResult {
  ok: boolean;
  // Names the platform-level reason a filename with invalid-UTF-8 bytes couldn't be created here,
  // without leaking an absolute path into a CI log.
  reason: string | null;
}

// "caf" + a raw 0xE9 byte + ".md" -- 0xE9 alone is a UTF-8 lead byte for a 3-byte sequence with no
// continuation bytes following it, so this is not valid UTF-8 by construction.
const NON_UTF8_NAME_BYTES = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x2e, 0x6d, 0x64]);

async function probeNonUtf8Filename(): Promise<NonUtf8FilenameProbeResult> {
  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), "praxarch-nonutf8-probe-"));
    const path = Buffer.concat([Buffer.from(`${dir}/`), NON_UTF8_NAME_BYTES]);
    try {
      await writeFile(path, "probe\n");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return {
        ok: false,
        reason: `filesystem rejected a non-UTF-8 filename (${code ?? "unknown error"}) -- expected on APFS (macOS), not on ext4/xfs (Linux)`,
      };
    }
    return { ok: true, reason: null };
  } finally {
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

let cached: Promise<NonUtf8FilenameProbeResult> | undefined;

export function getNonUtf8FilenameProbe(): Promise<NonUtf8FilenameProbeResult> {
  cached ??= probeNonUtf8Filename();
  return cached;
}

export function nonUtf8FilenameBytes(): Buffer {
  return NON_UTF8_NAME_BYTES;
}
