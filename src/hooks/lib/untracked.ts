import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readlink } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Exported so a later change can have git-diff.ts import this constant instead of re-declaring
// its own (one definition, not two) — git-diff.ts still declares it separately today. See
// git-diff.ts's own comment on this value for the full rationale: git output here is
// untracked-path listings and `rev-parse` output, not patch text, so hitting this ceiling is
// pathological and pathological means the caller must treat the listing as unknown (`null`),
// never silently truncated.
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

// git always prints "/" as the path separator in its own output (ls-files, status), regardless of
// host OS, so `root` is joined against a raw entry with a literal "/" here — not `node:path`'s
// OS-dependent separator, and not `path.join`, which is string-only and would force a decode step
// this module exists to avoid.
const PATH_SEP = Buffer.from("/");

// Splits on the raw 0x00 byte rather than decoding to a string and splitting on "\0" — decoding
// first is exactly the bug this module exists to close (see listUntrackedPaths's doc comment), so
// the delimiter search itself must run on the untouched bytes.
function splitOnNul(buf: Buffer): Buffer[] {
  const entries: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x00) {
      if (i > start) entries.push(buf.subarray(start, i));
      start = i + 1;
    }
  }
  if (start < buf.length) entries.push(buf.subarray(start));
  return entries;
}

export interface UntrackedPath {
  /**
   * The path exactly as git printed it, decoded to a string — present only when the raw bytes are
   * valid UTF-8 and decoding them round-trips losslessly (decode, then re-encode, then compare
   * against the original bytes). This is the only field that may be matched against
   * `ignorePatterns` or used as a display/snapshot key, and it is never a synthesized value: an
   * earlier version of this module encoded "unrepresentable" as an escaped marker string in this
   * same slot, and the marker's own alphabet could itself contain a default ignore pattern
   * (`dist/` appears inside a base64 payload) — silently dropping the entry from every count
   * before it was ever read. There is no safe synthesized string, so there isn't one: `null` is
   * the only representation for "this path is not a string."
   *
   * A caller matching `ignorePatterns` against `path` must skip (not invent a placeholder for)
   * entries where this is `null`. `null` can never match a real pattern, which is the fail-closed
   * direction — the entry falls through to being counted, never silently ignored.
   */
  path: string | null;
  /**
   * The exact bytes git printed for this entry, always present regardless of `path`. This — never
   * `path` — is what `readUntrackedEntry` uses to address the file on disk: Node's fs functions
   * accept a `Buffer` path and pass it to the syscall verbatim, with no string encode/decode step
   * to lose or corrupt bytes through. That is what makes a representable and an unrepresentable
   * path readable identically and correctly (real content, real line count) rather than the
   * unrepresentable case needing a weaker, always-unreadable fallback.
   */
  raw: Buffer;
}

/**
 * Untracked paths, repo-root-relative, whole-repo regardless of which directory inside the repo
 * `cwd` is. `--full-name` plus the `:/` pathspec (rather than a bare `git ls-files --others
 * --exclude-standard`) is what makes that true from any cwd — without them, running from a
 * subdirectory silently narrows both the listing *and* the paths to that subtree, which would
 * disagree with `diffFingerprint`'s whole-repo, root-relative `git status` output on the exact
 * path strings a SessionStart snapshot and a Stop-time measurement need to key on identically.
 *
 * `-z` (NUL-terminated, unquoted output) is required, not cosmetic: `core.quotePath` defaults to
 * true, so without it git C-quotes any path containing a non-ASCII byte, `"`, `\`, a tab, or a
 * newline — e.g. `naïve.md` prints as the *string* `"na\303\257ve.md"`, a path that does not exist
 * on disk.
 *
 * `-z` closes git's half of that, but not Node's: `execFile`'s default encoding decodes the
 * child's entire stdout as UTF-8 text before this function ever sees it, and a filename containing
 * bytes that are not valid UTF-8 (permitted by ext4/xfs on Linux; rejected outright by APFS on
 * macOS, which is why this half is invisible in local development) gets silently replaced with
 * U+FFFD by that decode. `encoding: "buffer"` below keeps `execFile` from decoding anything;
 * `splitOnNul` finds delimiters on the raw bytes, and each entry is round-tripped through UTF-8
 * individually (not the whole stream at once, so one malformed filename's replacement bytes can't
 * shift where a later delimiter appears to be) to decide `UntrackedPath.path` vs `null` — see that
 * field's doc comment for why an unrepresentable path is `null` rather than any synthesized
 * string, including the specific bypass an earlier in-band marker string reintroduced.
 *
 * `null` (the whole return value) means the listing could not be fetched — never an empty list. A
 * swallowed listing failure read as "no untracked files" would hide every new file in the tree
 * from the count; that silent under-count is precisely what the `null` contract exists to prevent,
 * so a failure here must take the whole measurement down at the call site, not degrade to "nothing
 * new."
 */
export async function listUntrackedPaths(cwd: string): Promise<UntrackedPath[] | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["ls-files", "--others", "--exclude-standard", "--full-name", "-z", "--", ":/"],
      { cwd, maxBuffer: MAX_GIT_BUFFER, encoding: "buffer" },
    );
    // Entries for an embedded repo / nested worktree arrive with a trailing slash (e.g.
    // "nested/"); kept verbatim in `raw` (and in `path`, when representable) rather than trimmed,
    // for the same reason `splitOnNul` only drops genuinely zero-length segments and not
    // whitespace-only ones (`touch ' '` is a real entry and must survive intact).
    return splitOnNul(stdout).map((raw) => {
      const decoded = raw.toString("utf8");
      const path = Buffer.from(decoded, "utf8").equals(raw) ? decoded : null;
      return { path, raw };
    });
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
 * `raw` is the exact bytes `listUntrackedPaths` printed for this entry (its `UntrackedPath.raw`),
 * not a string. Every fs call below is made against a `Buffer` path built from it, so there is no
 * string encode/decode step anywhere in this function that could corrupt bytes or silently target
 * a different file than the one git listed — the same guarantee for every entry, representable or
 * not, rather than a weaker fallback for the latter.
 *
 * The symlink branch is the security-relevant one. `readFile` on an untracked symlink follows it:
 * a symlink planted in the working tree that points outside the repo used to read arbitrary
 * out-of-repo file content into the count, and a symlink pointing at a FIFO used to block
 * `readFile` forever with no writer on the other end — a hung Stop hook, which the harness then
 * kills at timeout and treats as non-blocking: a silent fail-open on the enforcement gate. Never
 * following the link, and keying on a hash of its target bytes rather than its content, makes both
 * of those structurally unreachable for `raw`'s final path component: this function never opens
 * what the leaf itself points at, so it does not matter what kind of thing that leaf is.
 * `lstat`/`readlink` still resolve *intermediate* path components normally (that's POSIX path
 * resolution, not a choice this function makes) — a `raw` byte string shaped like
 * `"outdir/secret.txt"` where `outdir` is a symlinked directory would read through that
 * intermediate link. The intended caller cannot reach that shape: `git ls-files` never descends
 * into a symlinked directory, so `listUntrackedPaths` only ever hands this function
 * directory-shaped entries as a single opaque leaf (see the `d:` branch below). `raw` values must
 * come from `listUntrackedPaths` in the same measurement for that guarantee to hold — this
 * function does not itself validate that precondition.
 *
 * The regular-file branch is what makes that hold up under the streaming path too: `lstat` proves
 * a path is a regular file *before* `createReadStream` is ever called on it, so a FIFO can only
 * ever reach the special-file branch (a marker, no open) — never the branch that opens a read
 * stream. Reordering that — opening the stream first and dispatching after — would reintroduce
 * the exact hang this function exists to close, just moved one line later.
 */
export async function readUntrackedEntry(root: string, raw: Buffer): Promise<UntrackedEntry> {
  const fullPath = Buffer.concat([Buffer.from(root, "utf8"), PATH_SEP, raw]);

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
    // Never followed — see the function doc comment for why. Read as raw bytes (not a decoded
    // string) and then hashed, rather than embedded verbatim the way a representable target could
    // be: two different targets that are each invalid UTF-8 can decode to the identical
    // U+FFFD-laden string (verified: symlinks to two distinct invalid-UTF-8 targets produced the
    // same decoded string and therefore the same key), which would silently collapse two really
    // different retargets into one. Hashing the raw bytes makes the key exact regardless of the
    // target's own encoding, with no round-trip check needed the way `path` above needs one — a
    // hash has no "unrepresentable" case. Content is still never read: only the target's bytes are
    // hashed, so retargeting still moves the key even though nothing was read through the link,
    // and a dangling target is not a read failure.
    let target: Buffer;
    try {
      target = await readlink(fullPath, { encoding: "buffer" });
    } catch {
      return { key: "u:", lines: 0, readable: false };
    }
    const targetHash = createHash("sha256").update(target).digest("hex");
    return { key: `l:${targetHash}`, lines: 0, readable: true };
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
