import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Shared with git-diff.ts (which imports this constant rather than re-declaring it — one
// definition, not two). See git-diff.ts's own comment on this value for the full rationale: git
// output here is untracked-path listings and `rev-parse` output, not patch text, so hitting this
// ceiling is pathological and pathological means the caller must treat the listing as unknown
// (`null`), never silently truncated.
export const MAX_GIT_BUFFER = 64 * 1024 * 1024;

// Counts 0x0A bytes directly rather than decoding to a string first — a buffer read must not be
// lossily decoded just to count lines, or binary content collapses to indistinguishable
// replacement characters before it's counted. (Moved from git-diff.ts unchanged; this module now
// owns every kind-dispatched read of an untracked path, so it owns this too.)
export function countNewlines(buf: Buffer): number {
  let count = 0;
  for (const byte of buf) {
    if (byte === 0x0a) count += 1;
  }
  return count;
}

/**
 * Untracked paths, repo-root-relative, whole-repo regardless of which directory inside the repo
 * `cwd` is. `--full-name` plus the `:/` pathspec (rather than a bare `git ls-files --others
 * --exclude-standard`) is what makes that true from any cwd — without them, running from a
 * subdirectory silently narrows both the listing *and* the paths to that subtree, which would
 * disagree with `diffFingerprint`'s whole-repo, root-relative `git status` output on the exact
 * path strings a SessionStart snapshot and a Stop-time measurement need to key on identically.
 *
 * `null` means the listing could not be fetched — never an empty list. A swallowed listing
 * failure read as "no untracked files" would hide every new file in the tree from the count; that
 * silent under-count is precisely what the `null` contract exists to prevent, so a failure here
 * must take the whole measurement down at the call site, not degrade to "nothing new."
 */
export async function listUntrackedPaths(cwd: string): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["ls-files", "--others", "--exclude-standard", "--full-name", "--", ":/"],
      { cwd, maxBuffer: MAX_GIT_BUFFER },
    );
    // Entries for an embedded repo / nested worktree arrive with a trailing slash (e.g.
    // "nested/"). That's kept verbatim — it's the exact string `readUntrackedEntry` is called
    // with, the exact string a baseline snapshot keys on, and the exact string `ignorePatterns`
    // matches against, so trimming it here would silently disagree with all three.
    return stdout.split("\n").filter((line) => line.trim().length > 0);
  } catch {
    return null;
  }
}

/**
 * The repo root for `cwd` (`git rev-parse --show-toplevel`), so callers can join
 * `listUntrackedPaths`' root-relative output against a real absolute path. `null` when `cwd`
 * isn't inside a working tree, or the call otherwise fails — callers must not fall back to `cwd`
 * itself, which would silently reproduce the same wrong-base bug `--full-name` above exists to
 * close, just less often.
 */
export async function repoRoot(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      maxBuffer: MAX_GIT_BUFFER,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

export interface UntrackedEntry {
  /** Content key: identical key = identical on-disk state. Prefixes are single-char + ":" and
   *  mutually exclusive, so no two kinds — regular file, symlink, directory, special, absent,
   *  unreadable — can ever produce a colliding key. */
  key: string;
  /** 0x0A count for a regular file; 0 for every other kind. */
  lines: number;
  /** False when the path could not be read at all. An entry with `readable: false` must never be
   *  written into a SessionStart snapshot: two successive unreadable reads of the same path would
   *  otherwise compare equal on their shared "u:" key and the path would silently stop counting —
   *  the exact fail-open the snapshot's whole design exists to avoid. */
  readable: boolean;
}

/**
 * Reads a single untracked path's current content key, `lines` count, and readability, by a total
 * `lstat` dispatch — mirroring `diffFingerprint`'s kind-dispatch rules (git-diff.ts:345-439) so
 * the two functions can never disagree about what a given on-disk path "is." `lstat`, never
 * `stat`: a symlink must be inspected as itself, not through whatever it points at.
 *
 * The symlink branch is the security-relevant one. `readFile` on an untracked symlink follows it:
 * a symlink planted in the working tree that points outside the repo used to read arbitrary
 * out-of-repo file content into the count, and a symlink pointing at a FIFO used to block
 * `readFile` forever with no writer on the other end — a hung Stop hook, which the harness then
 * kills at timeout and treats as non-blocking: a silent fail-open on the enforcement gate. Never
 * following the link, and recording only its target string, makes both of those structurally
 * unreachable rather than merely unlikely: nothing in this function ever opens what a symlink
 * points at, so it does not matter what kind of thing that is.
 *
 * The regular-file branch is what makes that hold up under the streaming path too: `lstat` proves
 * a path is a regular file *before* `createReadStream` is ever called on it, so a FIFO can only
 * ever reach the special-file branch (a marker, no open) — never the branch that opens a read
 * stream. Reordering that — opening the stream first and dispatching after — would reintroduce
 * the exact hang this function exists to close, just moved one line later.
 */
export async function readUntrackedEntry(root: string, relPath: string): Promise<UntrackedEntry> {
  const fullPath = join(root, relPath);

  let st;
  try {
    st = await lstat(fullPath);
  } catch (err) {
    // ENOENT: listed by `git ls-files`, then vanished before this read (a race, or a caller
    // re-checking a stale path). Not "unreadable" — there is nothing here to fail to read — and
    // "a:" differs from every other kind's key, so comparing against any real baseline value
    // still reads as "changed" and the path still counts.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { key: "a:", lines: 0, readable: true };
    }
    // Any other lstat failure (permissions, etc.) is genuinely unknown, not absence.
    return { key: "u:", lines: 0, readable: false };
  }

  if (st.isSymbolicLink()) {
    // Never followed — see the function doc comment for why. The key is derived from the link's
    // target string, not its content, so retargeting a symlink still moves the key even though
    // nothing was read through it, and a dangling target is not a read failure.
    let target: string;
    try {
      target = await readlink(fullPath);
    } catch {
      return { key: "u:", lines: 0, readable: false };
    }
    return { key: `l:${target}`, lines: 0, readable: true };
  }

  if (st.isDirectory()) {
    // An embedded repo / nested worktree collapses to a single directory-shaped entry in `git
    // ls-files` output, exactly as it does in `git status` for diffFingerprint — git itself does
    // not descend, so this function doesn't either. Deliberately 1 entry / 0 lines: descending
    // would be a different, much larger measurement than the one this module is asked to take.
    return { key: "d:", lines: 0, readable: true };
  }

  if (!st.isFile()) {
    // Everything that isn't a symlink, a directory, or a regular file: FIFO, socket, block or
    // character device. Gated on `st.isFile()` explicitly, not inferred from having failed the
    // earlier checks — streaming below is reached only through that explicit gate, never as an
    // implicit fallthrough, which is what keeps a FIFO from ever reaching `createReadStream`.
    return { key: "s:", lines: 0, readable: true };
  }

  // Regular file, proven by the lstat above: streamed through the hash rather than buffered via
  // readFile, so memory use stays bounded regardless of file size. Fed to both the sha256 and the
  // newline counter in the same pass — one read of the file, not two.
  const hash = createHash("sha256");
  let lines = 0;
  try {
    for await (const chunk of createReadStream(fullPath)) {
      const buf = chunk as Buffer;
      hash.update(buf);
      lines += countNewlines(buf);
    }
  } catch {
    return { key: "u:", lines: 0, readable: false };
  }
  return { key: `f:${hash.digest("hex")}`, lines, readable: true };
}
