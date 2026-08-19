import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Git output (numstat lines, ls-files paths, status entries) can be large; Node's default 1MB
// maxBuffer would reject the exec call outright well before anything worth calling "large" is
// reached. Generous rather than tuned — this is a safety margin, not a limit anyone should expect
// to hit. Shared across every git invocation in this file, including diffFingerprint's `git
// status` call — status output is paths, not patch text, so hitting this ceiling is pathological,
// and pathological means the fingerprint becomes unknown (`null`), never a hash silently computed
// from a truncated listing.
const MAX_GIT_BUFFER = 64 * 1024 * 1024;

// Both flags neutralize config-driven nondeterminism that would otherwise blank the diff we're
// measuring: `diff.external` (or an inherited GIT_EXTERNAL_DIFF) can replace `git diff`'s output
// with whatever the external driver prints — including nothing — while leaving --numstat
// unaffected, and a textconv filter can rewrite content before it's diffed. Either one, left
// unchecked, would collapse the fingerprint to a constant value and silently defeat the staleness
// check this module exists to support. --numstat is unaffected by external diff drivers, but the
// flags are harmless to pass alongside it too, so every `git diff` invocation in this file gets
// them rather than special-casing which ones strictly need it.
const NEUTRALIZE_DIFF_CONFIG = ["--no-ext-diff", "--no-textconv"];

export interface DiffCounts {
  changedLines: number;
  changedFiles: number;
}

function parseNumstat(stdout: string, ignorePatterns: string[]): DiffCounts {
  let changedLines = 0;
  let changedFiles = 0;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const [added, removed, path] = line.split("\t");
    if (path === undefined) continue;
    if (ignorePatterns.some((pattern) => path.includes(pattern))) continue;
    changedFiles += 1;
    const addedNum = added === "-" ? 0 : Number(added);
    const removedNum = removed === "-" ? 0 : Number(removed);
    changedLines += addedNum + removedNum;
  }
  return { changedLines, changedFiles };
}

// Counts 0x0A bytes directly rather than decoding to a string first — a buffer read (see
// diffFingerprint's untracked-file handling) must not be lossily decoded just to count lines,
// or binary content collapses to indistinguishable replacement characters before it's counted.
function countNewlines(buf: Buffer): number {
  let count = 0;
  for (const byte of buf) {
    if (byte === 0x0a) count += 1;
  }
  return count;
}

// True only for the specific failure the HEAD fallback below exists to handle: `target` doesn't
// resolve to an object git can diff against (a baseline sha the repo no longer has — e.g. a reset
// or a shallow clone). Matched on git's stderr, not on exit code: `git diff` exits non-zero for a
// bad revision *and* for a maxBuffer overflow alike, and those two failures must be told apart —
// only the former has a legitimate fallback. A failure that doesn't match this must propagate, so
// the caller's fingerprint becomes `null` rather than silently measuring the wrong diff.
function isBadObjectError(err: unknown): boolean {
  const stderr = (err as { stderr?: unknown } | null | undefined)?.stderr;
  const message = typeof stderr === "string" ? stderr : stderr instanceof Buffer ? stderr.toString("utf8") : String(err);
  return /bad object|unknown revision|bad revision/i.test(message);
}

// Positive detection of "cwd is a git repo," not inferred from any diff/status call having
// failed — the defect this issue exists to close is exactly that conflation (a FIFO tripping
// `git diff --numstat` inside a real repo used to read identically to cwd not being a repo at
// all). `git rev-parse --is-inside-work-tree` succeeds in any working tree, including one with an
// unborn HEAD and zero commits, and fails (non-zero exit, "not a git repository" on stderr)
// everywhere else — that boolean is the only thing this function reports.
async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
    return true;
  } catch {
    return false;
  }
}

async function trackedDiff(cwd: string, target: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["diff", ...NEUTRALIZE_DIFF_CONFIG, target, ...args], {
      cwd,
      maxBuffer: MAX_GIT_BUFFER,
    });
    return stdout;
  } catch (err) {
    // Fall back to HEAD only when `target` itself was the problem (bad-object baseline) and we
    // aren't already diffing against HEAD. Any other failure — most notably a maxBuffer overflow
    // on a huge patch — must propagate: falling back would "succeed" against a different diff
    // than the one that failed, turning a fetch failure into a wrong (but real-looking) answer.
    if (target === "HEAD" || !isBadObjectError(err)) throw err;
    const { stdout } = await execFileAsync("git", ["diff", ...NEUTRALIZE_DIFF_CONFIG, "HEAD", ...args], {
      cwd,
      maxBuffer: MAX_GIT_BUFFER,
    });
    return stdout;
  }
}

// `null` means the listing could not be fetched (distinct from a real, empty listing) — same
// contract as diffFingerprint's return value, and for the same reason: an untracked-file count
// that silently degrades to "none" on failure would hide new files from the fingerprint just as
// surely as a swallowed patch-fetch failure would.
async function listUntracked(cwd: string): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd,
      maxBuffer: MAX_GIT_BUFFER,
    });
    return stdout.split("\n").filter((line) => line.trim().length > 0);
  } catch {
    return null;
  }
}

/**
 * Sizes the session's real diff: changes against `baseline` (the HEAD sha recorded at
 * SessionStart) when given, so committed work still gets measured — plus untracked new files,
 * which `git diff` never sees. Excludes paths matching any ignorePattern substring.
 *
 * `null` means the diff could not be measured — same contract as `diffFingerprint`'s return
 * value, and it must never be treated as "nothing changed": a caller that used to read a swallowed
 * measurement failure as `{0, 0}` was reading a genuinely unmeasured tree as trivially small,
 * which is how a FIFO (or a socket, device node, or any other `unsupported file type` git chokes
 * on) anywhere in the tree used to let a real diff of any size sail past verify-gate's trivial-diff
 * allow with no verdict ever recorded. Three distinguishable outcomes, not two:
 * - cwd isn't a git repo at all (`isGitRepo` below, checked positively — never inferred from the
 *   numstat/ls-files calls having failed, which is the conflation that caused the defect this
 *   split exists to fix) → `{0, 0}`. Deliberately still fail-open: the verify-gate treats this as
 *   "nothing to gate on" rather than failing the hook, and that's unchanged by this fix.
 * - A real repo whose `--numstat` probe or untracked-file listing fails for any other reason
 *   (the FIFO repro, a numstat failure, an `ls-files` failure) → `null`. The one carve-out is an
 *   unborn HEAD (a real repo, zero commits) diffing against `target`: `trackedDiff` reports that
 *   the same way `diffFingerprint` treats it — as "nothing committed yet," not as unknown — so a
 *   brand-new repo with only untracked work still gets real counts, not `null`.
 * - Success → real counts.
 *
 * Deliberately cheap: only `--numstat` (tracked) and untracked-file byte-length line counts are
 * computed — no patch text is fetched. Callers that also need the fingerprint (e.g. to detect a
 * stale verdict) call `diffFingerprint` separately, and only when they actually need it — see its
 * doc comment for why that split exists.
 */
export async function diffStat(
  cwd: string,
  ignorePatterns: string[],
  baseline?: string | null,
): Promise<DiffCounts | null> {
  if (!(await isGitRepo(cwd))) {
    return { changedLines: 0, changedFiles: 0 };
  }

  const target = baseline ? baseline : "HEAD";

  let tracked: DiffCounts;
  try {
    const numstatOut = await trackedDiff(cwd, target, ["--numstat"]);
    tracked = parseNumstat(numstatOut, ignorePatterns);
  } catch (err) {
    // Unborn HEAD (no commits yet) is the one bad-object-shaped failure that isn't unknown — a
    // real repo genuinely has nothing committed to diff against, matching diffFingerprint's
    // "NOHEAD" treatment of the same state. `target === "HEAD"` above already keeps this from
    // masking a bad `baseline` sha (trackedDiff's own HEAD fallback only fires when target isn't
    // already HEAD), so this only ever catches the unborn-HEAD case. Anything else — the FIFO
    // repro's "unsupported file type," a maxBuffer overflow, a genuine numstat failure — is
    // unknown and must propagate as `null`, not degrade to a silently-zero tracked count.
    if (isBadObjectError(err)) {
      tracked = { changedLines: 0, changedFiles: 0 };
    } else {
      return null;
    }
  }

  const untracked = await listUntracked(cwd);
  // A failed listing means a hidden batch of new files could be sitting uncounted — exactly the
  // under-count this null contract exists to prevent, so it takes the whole measurement down
  // rather than degrading to "contributes nothing" the way an individual unreadable file does.
  if (untracked === null) return null;

  let changedLines = tracked.changedLines;
  let changedFiles = tracked.changedFiles;
  for (const path of untracked) {
    let contents: Buffer | null = null;
    try {
      contents = await readFile(join(cwd, path));
    } catch {
      // Unreadable file (race, permissions) — contributes its path only, matching diffFingerprint.
    }
    if (ignorePatterns.some((pattern) => path.includes(pattern))) continue;
    changedFiles += 1;
    if (contents !== null) changedLines += countNewlines(contents);
  }

  return { changedLines, changedFiles };
}

interface StatusEntry {
  path: string;
  statusCode: string;
}

// Parses `git status --porcelain -z --no-renames --untracked-files=all` output. Each entry is
// "XY <path>" NUL-terminated (NUL instead of newline, and — unlike the default porcelain format —
// paths are never quoted/escaped, so this is git's stable scripting interface for this data).
// --no-renames guarantees every entry is a single self-contained "XY path" — no second,
// NUL-delimited "orig path" segment to account for, which the default (rename-detecting) format
// would otherwise interleave for R/C entries.
function parseStatusZ(stdout: string): StatusEntry[] {
  return stdout
    .split("\0")
    .filter((entry) => entry.length > 0)
    .map((entry) => ({ statusCode: entry.slice(0, 2), path: entry.slice(3) }));
}

/**
 * Fingerprint of the current tree: sha256 over the HEAD sha (or the sentinel `"NOHEAD"` when HEAD
 * is unborn), followed by every entry of `git status --porcelain -z --no-renames
 * --untracked-files=all`, sorted by path, each contributing its path, status code, and — for
 * paths that still have on-disk content — a length-prefixed raw byte read of that content.
 * Deliberately ignores ignorePatterns — see the doc comment on diffStat's caller (verify-gate) for
 * why that's safe: a hash difference alone never expires a verdict, only a hash difference paired
 * with a size delta past the configured thresholds does, so lockfile-only churn can't spuriously
 * expire a verdict.
 *
 * Never generates a patch. Committed work is covered entirely by the HEAD sha — any commit moves
 * HEAD, which moves the fingerprint — so this function never fetches or measures patch text the
 * way the previous implementation did, and the entire class of failure that broke four rounds of
 * review (a maxBuffer overflow on patch text, or a `diff.external`/`GIT_EXTERNAL_DIFF`/textconv
 * driver blanking `git diff`'s output while `--numstat` kept working) is structurally impossible
 * here rather than defended against: nothing in this function ever runs `git diff`. Dirty and
 * untracked files are covered by reading their current on-disk bytes directly in Node, not by
 * diffing them.
 *
 * `null` means the fingerprint could not be computed and must never be treated as "unchanged":
 * - `git status` itself failing or exceeding `MAX_GIT_BUFFER` (status output is paths, not patch
 *   text, so overflowing this is pathological) → `null`. Never an empty or truncated listing.
 * - `git rev-parse --show-toplevel` failing while `git status` succeeded → `null`. Porcelain paths
 *   are repo-root-relative, not cwd-relative; joining them against `cwd` instead silently produces
 *   wrong (usually nonexistent) paths whenever the hook runs from a subdirectory, which reads as
 *   permanent ENOENT rather than as the wrong-base bug it is. A resolvable root is required before
 *   any entry is read — falling back to `cwd` would just reproduce the same bug more rarely.
 * - Each status entry is dispatched by `fs.lstat` (not `stat` — a symlink must never be followed),
 *   and the dispatch is total: every branch below emits either a kind marker or the regular-file
 *   length prefix, never silently falling through to another branch's encoding.
 *   - `ENOENT` → path + status code + the `"ABSENT"` marker. This covers both a real deletion
 *     (no on-disk content to read, by definition) and a delete-between-status-and-read race
 *     identically: either way the fingerprint describes the tree as it is right now. There is no
 *     `D`-status special case — an unmerged delete/modify conflict (`UD`/`DU`) is a single status
 *     entry with full working-tree content (the file a session edits to resolve the conflict), and
 *     `lstat` naturally falls through to the regular-file branch for it.
 *   - Any other `lstat` failure (permissions, etc.) → `null`.
 *   - A symlink → path + status code + the `"SYMLINK"` marker + the `readlink` target string,
 *     never the link's followed content. Not following means a dangling target is no longer a read
 *     failure, a retargeted link still moves the hash (the target string changes), and the hook
 *     can never be made to read file content outside the repo by a symlink planted inside it.
 *   - A directory → path + status code + the `"DIR"` marker, nothing else. Porcelain reports a
 *     dirty submodule and an untracked embedded repo identically as a single directory-path entry;
 *     git itself collapses their inner content the same way in `git status`, so this is inherited
 *     blindness, not a gap introduced here — content changes inside such an entry are invisible to
 *     the fingerprint exactly as they're invisible to `diffStat`'s numstat.
 *   - Anything else non-regular (FIFO, socket, block/character device — gated on `st.isFile()`,
 *     not inferred from having failed the earlier checks) → path + status code + the `"SPECIAL"`
 *     marker. Streaming is reached only through an explicit `isFile()` branch, never as an
 *     implicit fallback: a tracked file replaced by a FIFO used to fall through to
 *     `createReadStream`, which blocks forever with no writer on the other end, hanging the hook
 *     until the harness kills it at timeout — a stall and a silent fail-open, not a fingerprint
 *     defect. `"SPECIAL"` rather than `null` because a special file sitting in the tree is a
 *     persistent state (the same reasoning as the dangling-symlink fix): `null` would leave the
 *     fingerprint permanently unknown for as long as the file stays that kind, where the marker
 *     keeps it moving as the kind changes. One marker covers every non-regular, non-symlink,
 *     non-directory kind — which specific special kind sits at a path is not a state worth
 *     distinguishing.
 *   - A regular file → path + status code + byte length + content, streamed through the hash
 *     (`createReadStream`, not a buffered `readFile`) so memory use stays bounded regardless of
 *     file size. A read error mid-stream → `null`.
 *   Kind markers (`"ABSENT"`, `"SYMLINK"`, `"DIR"`, `"SPECIAL"`) are non-numeric and
 *   NUL-terminated, so no marker can be read as a regular file's numeric length prefix and no two
 *   markers can collide with each other — every branch's encoding is prefix-free by construction.
 *
 * `git rev-parse --verify HEAD` failing *while `git status` succeeded* is treated as a genuinely
 * unborn HEAD (the `"NOHEAD"` sentinel), not as unknown — status succeeding proves a working repo,
 * so rev-parse failing in a working repo means there's no HEAD to resolve, not that something went
 * wrong. A transient split between the two calls (status succeeds, HEAD resolves a moment later)
 * would make the fingerprint read as "differs" against a real recorded hash, which is the
 * conservative direction: it can cause an extra block, never a falsely-certified stale verdict.
 *
 * Split out from diffStat (which returns counts only, and keeps its own `baseline`-relative
 * behaviour and degrade-to-zero-on-failure contract untouched) because this is the expensive half:
 * it reads every dirty/untracked file's full current contents, where diffStat's counts already
 * serve the common case (a trivial diff that returns at verify-gate's early allow, or a Stop where
 * no verifier verdict was even parsed in telemetry) far more cheaply. Callers invoke this only
 * after establishing they actually need a fingerprint.
 */
export async function diffFingerprint(cwd: string): Promise<string | null> {
  let statusOut: string;
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["status", "--porcelain", "-z", "--no-renames", "--untracked-files=all"],
      { cwd, maxBuffer: MAX_GIT_BUFFER },
    );
    statusOut = stdout;
  } catch {
    return null;
  }

  // Consulted only after `status` has already proven this is a working repo — see the doc
  // comment above for why a rev-parse failure at this point means "unborn HEAD," not "unknown."
  let head: string;
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--verify", "HEAD"], { cwd });
    head = stdout.trim();
  } catch {
    head = "NOHEAD";
  }

  // Porcelain paths are repo-root-relative, not cwd-relative — resolved once here rather than
  // joined against `cwd` below. See the doc comment above for why a failure here is `null`, not a
  // silent fallback to `cwd`.
  let root: string;
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      maxBuffer: MAX_GIT_BUFFER,
    });
    root = stdout.trim();
  } catch {
    return null;
  }

  const entries = parseStatusZ(statusOut).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const hash = createHash("sha256");
  hash.update(head);
  hash.update("\0");

  for (const { path, statusCode } of entries) {
    hash.update(path);
    hash.update("\0");
    hash.update(statusCode);
    hash.update("\0");

    const fullPath = join(root, path);

    // lstat, never stat: a symlink must be inspected as itself, not followed, so its branch below
    // can decide what "not following" means rather than transparently reading through it.
    let st;
    try {
      st = await lstat(fullPath);
    } catch (err) {
      // ENOENT covers a real deletion (no on-disk content by definition) and a race where the
      // path vanished between the status call and this lstat identically — either way, the
      // fingerprint describes the tree as it is right now. "ABSENT" makes the entry's boundary
      // explicit in the byte stream (see the kind-marker note below the regular-file branch) —
      // without it, an ENOENT entry's bytes are just "path\0code\0", indistinguishable from a
      // prefix of any other branch's encoding. Any other lstat failure (permissions, etc.) is
      // genuinely unknown and must not be silently omitted from the hash.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        hash.update("ABSENT");
        hash.update("\0");
        continue;
      }
      return null;
    }

    if (st.isSymbolicLink()) {
      // Never follow: a dangling target stops being a read failure, a retargeted link still moves
      // the hash (the target string changes), and content outside the repo can never be read
      // through a symlink planted inside it. "SYMLINK" is non-numeric, so it can't collide with a
      // regular file's numeric length prefix below; NUL-terminated like every other field, and
      // safe as a terminator because a symlink target — like a path — can't itself contain NUL.
      let target: string;
      try {
        target = await readlink(fullPath);
      } catch {
        return null;
      }
      hash.update("SYMLINK");
      hash.update("\0");
      hash.update(target);
      hash.update("\0");
      continue;
    }

    if (st.isDirectory()) {
      // A dirty submodule and an untracked embedded repo both surface in porcelain status as a
      // single directory-path entry — git itself collapses their inner content the same way, so
      // this is inherited blindness (see the function doc comment), not a gap introduced here.
      // Path + status code (already hashed above) is all there is to say about the entry.
      hash.update("DIR");
      hash.update("\0");
      continue;
    }

    if (!st.isFile()) {
      // Everything that isn't a symlink, a directory, or a regular file: FIFO, socket, block or
      // character device. A tracked file replaced with a FIFO (`mkfifo` over an existing path,
      // reported by porcelain as an ordinary modification) used to fall through to the streaming
      // branch below unconditionally — createReadStream blocks forever on a FIFO with no writer,
      // hanging the Stop hook until Claude Code kills it at timeout, which then treats the
      // timed-out hook as non-blocking: a session stall plus a silent fail-open with no log line.
      // Making the dispatch total on `st.isFile()` closes that off structurally rather than by
      // special-casing FIFOs: streaming only ever happens under an explicit "this is a regular
      // file" check. "SPECIAL" is not `null` — a special file sitting in the tree is a persistent
      // state, not a transient failure, and `null` would leave the fingerprint permanently unknown
      // for as long as it exists (the same degradation round 6 fixed for dangling symlinks). The
      // marker still moves the hash when a file becomes a FIFO and back, which is the sensitivity
      // wanted. One marker covers every non-regular kind; distinguishing a FIFO from a socket at
      // the same path is not a state worth engineering for.
      hash.update("SPECIAL");
      hash.update("\0");
      continue;
    }

    // Regular file: streamed through the hash rather than buffered via readFile, so memory use
    // stays bounded regardless of file size. The length prefix (from the lstat already taken —
    // not a symlink, so its size is the real file size) plus its own delimiter make the
    // path/content boundary unambiguous even when one path is a prefix of another path's content
    // (e.g. path "afile" + content "b" vs path "afileb" + content "" would otherwise hash
    // identically). Bytes, not a utf8 decode: decoding first would collapse invalid byte
    // sequences to U+FFFD and hash the *decoded* length, making distinct binary contents collide.
    hash.update(String(st.size));
    hash.update("\0");
    try {
      for await (const chunk of createReadStream(fullPath)) {
        hash.update(chunk as Buffer);
      }
    } catch {
      return null;
    }
  }

  return hash.digest("hex");
}
