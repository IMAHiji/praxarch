import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readlink } from "node:fs/promises";
import { promisify } from "node:util";
import { listUntrackedPaths, lookupUntrackedBaseline, readUntrackedEntry, repoRoot } from "./untracked.js";
import { resolveEffectiveBaseline } from "./upstream-baseline.js";

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

// git always prints "/" as the path separator in its own output (status, ls-files) regardless of
// host OS — mirrors untracked.ts's identically-named, identically-reasoned constant. `fullPath`
// below is built by concatenating raw Buffers with this literal separator, never `node:path.join`
// (string-only, and would force a decode step this module exists to avoid) and never
// `node:path`'s OS-dependent separator.
const PATH_SEP = Buffer.from("/");

export interface DiffCounts {
  changedLines: number;
  changedFiles: number;
}

// A pattern ending in "/" denotes a whole path segment (a directory name), so it must only match
// when the occurrence starts at a segment boundary — the beginning of the path, or immediately
// after a "/" — never mid-segment. Without this, the default pattern "dist/" also matches
// "notdist/x.md": the substring "dist/" is genuinely present, but "notdist" is one path segment,
// not "not" + "dist", and silently dropping a legitimately-named file because of that is the exact
// fail-open ignorePatterns must never produce. A pattern not ending in "/" (an extension suffix
// like ".min.js", or an exact filename like "package-lock.json") keeps the existing unanchored
// substring match: it isn't a segment name, and anchoring it the same way would silently stop
// matching a minified file anywhere but at the very start of a path, breaking every default
// pattern of that shape.
function matchesIgnorePattern(path: string, pattern: string): boolean {
  if (!pattern.endsWith("/")) return path.includes(pattern);
  let from = 0;
  for (;;) {
    const idx = path.indexOf(pattern, from);
    if (idx === -1) return false;
    if (idx === 0 || path[idx - 1] === "/") return true;
    from = idx + 1;
  }
}

function parseNumstat(stdout: string, ignorePatterns: string[]): DiffCounts {
  let changedLines = 0;
  let changedFiles = 0;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const [added, removed, path] = line.split("\t");
    if (path === undefined) continue;
    if (ignorePatterns.some((pattern) => matchesIgnorePattern(path, pattern))) continue;
    changedFiles += 1;
    const addedNum = added === "-" ? 0 : Number(added);
    const removedNum = removed === "-" ? 0 : Number(removed);
    changedLines += addedNum + removedNum;
  }
  return { changedLines, changedFiles };
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

/**
 * Sizes the session's real diff: changes against `baseline` (the HEAD sha recorded at
 * SessionStart) when given, so committed work still gets measured — plus untracked new files,
 * which `git diff` never sees. Untracked files are listed whole-repo and root-relative (via
 * `listUntrackedPaths`) and each one dispatched by `readUntrackedEntry`'s total `lstat` kind
 * dispatch — the same rules `diffFingerprint` uses (git-diff.ts:345-439): a symlink is never
 * followed (keyed on a hash of its raw target bytes instead), a directory (an embedded repo or
 * nested worktree) counts as 1 file / 0 lines rather than being descended into or throwing EISDIR,
 * and a FIFO/socket/device is never opened. `ignorePatterns` is tested before any of that dispatch
 * runs, not after — an ignored path (default `dist/`) must never be read at all, which is what
 * keeps a FIFO planted under an ignored directory from ever being opened. See `matchesIgnorePattern`
 * above for why the match is anchored to path segments rather than an unanchored substring test.
 *
 * `null` means the diff could not be measured — same contract as `diffFingerprint`'s return
 * value, and it must never be treated as "nothing changed": a caller that used to read a swallowed
 * measurement failure as `{0, 0}` was reading a genuinely unmeasured tree as trivially small,
 * which is how a FIFO (or a socket, device node, or any other `unsupported file type` git chokes
 * on) anywhere in the tree used to let a real diff of any size sail past verify-gate's trivial-diff
 * allow with no verdict ever recorded. Four distinguishable outcomes, not two:
 * - cwd isn't a git repo at all (`isGitRepo` below, checked positively — never inferred from the
 *   numstat/root/listing calls having failed, which is the conflation that caused the defect this
 *   split exists to fix) → `{0, 0}`. Deliberately still fail-open: the verify-gate treats this as
 *   "nothing to gate on" rather than failing the hook, and that's unchanged by this fix.
 * - A real repo whose `--numstat` probe, root resolution, or untracked-file listing fails for any
 *   other reason (the FIFO repro, a numstat failure, a `git rev-parse --show-toplevel` failure, an
 *   `ls-files` failure) → `null`. Root resolution failing while `isGitRepo` already succeeded is
 *   treated the same as `diffFingerprint`'s own `--show-toplevel` rule (git-diff.ts:325-337):
 *   unknown, never a silent fallback to `cwd` — that would reproduce the wrong-base bug (untracked
 *   paths are root-relative, not cwd-relative) just less often. The one carve-out is an unborn HEAD
 *   (a real repo, zero commits) diffing against `target`: `trackedDiff` reports that the same way
 *   `diffFingerprint` treats it — as "nothing committed yet," not as unknown — so a brand-new repo
 *   with only untracked work still gets real counts, not `null`.
 * - An individual untracked entry that fails to read (`readable: false` — permissions, or a read
 *   error mid-stream) still contributes its 1 file / 0 lines. Deliberately *not* `diffFingerprint`'s
 *   `null`-the-whole-measurement treatment of a read failure: a single permanently-unreadable path
 *   would otherwise make the gate un-measurable — and therefore permanently blocking — for the rest
 *   of the session, while counting it 1/0 keeps the measurement conservative (it can only ever
 *   under-count that one path's line total, never hide the fact that something changed there).
 * - Success → real counts.
 *
 * Deliberately cheap relative to `diffFingerprint`: only `--numstat` (tracked) is fetched from
 * git, no patch text. Every untracked regular file still has its full on-disk contents streamed
 * through `readUntrackedEntry` — which counts newlines *and* sha256-hashes the bytes for its
 * `key` — but `diffStat` itself only ever keeps the line count off that result; the key is
 * discarded here; it exists for callers (e.g. a SessionStart snapshot) that need to detect
 * whether a specific untracked path's content changed, not just how many lines it has. Callers
 * that also need the fingerprint (e.g. to detect a stale verdict) call `diffFingerprint`
 * separately, and only when they actually need it — see its doc comment for why that split
 * exists.
 */
export async function diffStat(
  cwd: string,
  ignorePatterns: string[],
  baseline?: string | null,
  // Session-start untracked snapshot (see untracked.ts's captureUntrackedBaseline). Omitted or
  // null = no usable capture -> every untracked path counts, exactly as before this parameter
  // existed. Optional and defaulted to "count everything" so every pre-Task-5 caller keeps
  // compiling and keeps today's behaviour unchanged.
  untrackedBaseline?: Record<string, string> | null,
): Promise<DiffCounts | null> {
  if (!(await isGitRepo(cwd))) {
    return { changedLines: 0, changedFiles: 0 };
  }

  // Received work is not this session's work. The pinned baseline itself stays pinned on disk
  // (see session-state.ts:74 and verify-gate.ts:148 for why); this only derives, per measurement,
  // the most recent already-upstream commit at or after it. `?? "HEAD"` below is safe only
  // because resolveEffectiveBaseline's contract guarantees it never returns null for a real,
  // non-empty `baseline` -- every failure or uncertainty it hits resolves back to `pinned`
  // unchanged (see its own doc comment). `null` here means the same thing `baseline` itself being
  // unset already meant: nothing to measure from but HEAD. If that contract ever changed to
  // return null on some internal error instead, this line would silently start measuring nothing
  // since the last commit -- an under-count that lets unverified session work through. See
  // git-diff.test.ts's "effective-baseline coupling" test, which pins this against exactly that
  // regression (mutation-tested by forcing resolveEffectiveBaseline to return null).
  const effective = await resolveEffectiveBaseline(cwd, baseline);
  const target = effective ?? "HEAD";

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

  // Resolved before listing, and before any untracked path is read — every entry `readUntrackedEntry`
  // reads below is joined against this root, never `cwd`, since the paths `listUntrackedPaths`
  // returns are root-relative. See the doc comment above for why a failure here is unknown
  // (`null`). Passed straight through to `readUntrackedEntry` with no intermediate stringification
  // (no template literal, no `String(root)`) so this call site stays correct regardless of
  // whether `repoRoot` returns a `string` or a raw-byte `Buffer` — the exact representation is
  // untracked.ts's decision, not this function's.
  const root = await repoRoot(cwd);
  if (root === null) return null;

  // `listUntrackedPaths` takes any cwd inside the repo, not specifically the root — that's the
  // whole point of its `--full-name` + `:/` pathspec (see its doc comment): the listing is
  // whole-repo and root-relative regardless of which directory it's invoked from. Passing the
  // original `cwd` here, rather than `root`, means this call never depends on `root`'s
  // representation either.
  const untracked = await listUntrackedPaths(cwd);
  // A failed listing means a hidden batch of new files could be sitting uncounted — exactly the
  // under-count this null contract exists to prevent, so it takes the whole measurement down
  // rather than degrading to "contributes nothing" the way an individual unreadable entry does.
  if (untracked === null) return null;

  let changedLines = tracked.changedLines;
  let changedFiles = tracked.changedFiles;
  // Iterates the whole `UntrackedPath` object, not a `{ path, raw }` destructure — a caller that
  // also needs to key a snapshot off this entry (e.g. `untrackedSnapshotKey`) needs the object
  // itself in hand, not just the two fields this loop happens to use today.
  for (const untrackedPath of untracked) {
    // A `null` path is a name this module cannot represent as a string (invalid UTF-8 bytes — see
    // UntrackedPath.path's doc comment in untracked.ts). ignorePatterns is a set of user-authored
    // strings tested with a substring/segment match; there is no way to run that match against a
    // path that isn't a string, and no safe synthesized stand-in for one (an earlier design tried
    // exactly that and reintroduced the bypass it was meant to close — see untracked.ts). The
    // fail-closed direction is to never treat a null path as ignore-matched, so it always falls
    // through to being read and counted below rather than silently vanishing into a rule nobody
    // could have written to catch it.
    //
    // This check runs before `readUntrackedEntry` is ever called, not after: an ignored path must
    // never be `lstat`ed or read at all, only ever matched by name. Moving it after the read would
    // still land on the same final counts (the `continue` below still discards the entry either
    // way), but it would mean every ignored path pays for a real filesystem read it has no reason
    // to trigger, and — for a path this module cannot yet prove is a plain file — no reason to
    // touch at all.
    if (
      untrackedPath.path !== null &&
      ignorePatterns.some((pattern) => matchesIgnorePattern(untrackedPath.path as string, pattern))
    ) {
      continue;
    }
    const entry = await readUntrackedEntry(root, untrackedPath.raw);
    // AMENDED 2026-08-19 — do NOT do a bare-path lookup (`untrackedBaseline?.[path]`), which is
    // what this spec originally said. Task 3's snapshot is keyed through `untrackedSnapshotKey`:
    // "p:" + path for a representable path, "r:" + sha256(raw).hex for one that is not valid
    // UTF-8. A bare-path lookup misses EVERY key, so the skip below would never fire and this
    // whole parameter would be silently inert — an over-count, the safe direction, but a useless
    // one. `lookupUntrackedBaseline` is exported for exactly this reason; call it rather than
    // indexing the record directly.
    const baselineKey = lookupUntrackedBaseline(untrackedBaseline, untrackedPath);
    // Only a key that matches exactly proves the session did not touch this path since capture.
    // Absent (never captured, or unreadable at capture time), different (content changed), or no
    // snapshot at all (`untrackedBaseline` null/undefined, `baselineKey` always undefined) all
    // count — the fail-closed direction this parameter must never weaken.
    if (baselineKey !== undefined && baselineKey === entry.key) continue;
    changedFiles += 1;
    // `entry.readable === false` (a permission error, or a read that failed mid-stream) still
    // contributes 1 file / 0 lines here, deliberately not `diffFingerprint`'s null-the-whole-
    // measurement treatment of the same failure — see the function doc comment above for why the
    // two functions diverge on this one point.
    //
    // A key that differs from the baseline contributes the entry's FULL current line count, not a
    // delta (design decision A2) — a one-line edit to a big pre-existing untracked file still
    // counts the whole file. Over-counts an edited pre-existing untracked file; that is the safe
    // direction, and it matches the semantics untracked content already had before this parameter
    // existed.
    changedLines += entry.lines;
  }

  return { changedLines, changedFiles };
}

// Exported (not module-private) solely so git-diff.test.ts can pin its Buffer-splitting and
// sort-order logic directly against synthetic invalid-UTF-8-byte input on a filesystem (macOS)
// that cannot itself host a file with such a name — see the test's own comment for why that
// matters. Not used by any other module.
export interface StatusEntry {
  /**
   * The path exactly as git printed it, as raw bytes — never a decoded string. `-z` stops git
   * itself from quoting a path (see below), but `execFile`'s default encoding still UTF-8-decodes
   * the whole child stdout before this module ever sees it, and a tracked filename containing
   * bytes that are not valid UTF-8 (permitted by ext4/xfs on Linux; rejected outright by APFS on
   * macOS, which is why this is invisible in local development) gets silently replaced with
   * U+FFFD by that decode. This is the same defect `listUntrackedPaths` closed for the untracked
   * half of the tree (untracked.ts) — the fingerprint side had the identical bug for tracked
   * files: a corrupted path joins to an ENOENT, which hashes as the fixed `"ABSENT"` marker
   * regardless of the file's real content, so an edited file with an unrepresentable name could
   * never move the fingerprint at all.
   *
   * There is no `path: string | null` split here the way `UntrackedPath` has one: nothing in
   * `diffFingerprint` ever matches a path against `ignorePatterns` or uses it as a display key (it
   * deliberately ignores `ignorePatterns` — see the function doc comment), so there's no
   * string-typed use case to serve. Every consumer — sorting, hashing, and addressing the
   * filesystem — operates on these raw bytes directly.
   */
  path: Buffer;
  statusCode: string;
}

// Splits on the raw 0x00 byte, not on a decoded string's "\0" — decoding first is exactly the bug
// this function exists to close (see StatusEntry.path's doc comment), so the delimiter search
// itself must run on the untouched bytes. Mirrors untracked.ts's splitOnNul.
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

// Parses `git status --porcelain -z --no-renames --untracked-files=all` output. Each entry is
// "XY <path>" NUL-terminated (NUL instead of newline, and — unlike the default porcelain format —
// paths are never quoted/escaped, so this is git's stable scripting interface for this data).
// --no-renames guarantees every entry is a single self-contained "XY path" — no second,
// NUL-delimited "orig path" segment to account for, which the default (rename-detecting) format
// would otherwise interleave for R/C entries.
//
// Operates on the raw stdout `Buffer`, not a decoded string — see StatusEntry.path's doc comment
// for why. The two-byte status code is always ASCII by construction (git's own fixed alphabet of
// status letters and spaces), so decoding just that slice is safe; the path slice is kept as raw
// bytes all the way through.
export function parseStatusZ(stdout: Buffer): StatusEntry[] {
  return splitOnNul(stdout).map((entry) => ({
    statusCode: entry.subarray(0, 2).toString("utf8"),
    path: entry.subarray(3),
  }));
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
  // `encoding: "buffer"` keeps `execFile` from UTF-8-decoding stdout — see StatusEntry.path's doc
  // comment for why a decode here silently corrupts any tracked path with invalid-UTF-8 bytes,
  // and untracked.ts's `listUntrackedPaths` for the identical fix already applied on the
  // untracked-file half of the tree.
  let statusOut: Buffer;
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["status", "--porcelain", "-z", "--no-renames", "--untracked-files=all"],
      { cwd, maxBuffer: MAX_GIT_BUFFER, encoding: "buffer" },
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
  // `encoding: "buffer"` here too, and `root` stays a `Buffer` all the way to `fullPath` below —
  // same reasoning as untracked.ts's `repoRoot`: a repo root whose own on-disk name contains
  // invalid-UTF-8 bytes must not be corrupted to U+FFFD before every status entry is joined
  // against it, which would ENOENT every single entry regardless of its real content.
  let root: Buffer;
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      maxBuffer: MAX_GIT_BUFFER,
      encoding: "buffer",
    });
    // Strips only git's single terminating 0x0A byte, not `.trim()`'s arbitrary trailing
    // whitespace and not a `\r?` variant — same fix, and same reasoning, as untracked.ts's
    // repoRoot: a repo whose own directory name ends in whitespace would otherwise come back
    // truncated to a path that doesn't exist, and every status entry below would then `lstat`
    // ENOENT against that wrong root regardless of its real on-disk content. Strictly the single
    // trailing byte, not `\r?\n`: git writes LF through a pipe, never CRLF, so an optional `\r`
    // here protects nothing real and instead eats a LEGAL trailing carriage return that's part of
    // the directory name itself, reintroducing the exact truncation bug this line exists to fix
    // (verified: a repo directory named "dircr\r" collapses to a nonexistent "dircr" root under
    // `\r?\n$`, and the fingerprint stops moving on edits entirely). Working on the raw bytes
    // (rather than `.replace()` on a decoded string) is what makes stripping only the exact
    // trailing byte possible at all.
    const last = stdout.length - 1;
    root = last >= 0 && stdout[last] === 0x0a ? stdout.subarray(0, last) : stdout;
  } catch {
    return null;
  }

  const entries = parseStatusZ(statusOut).sort((a, b) => Buffer.compare(a.path, b.path));

  const hash = createHash("sha256");
  hash.update(head);
  hash.update("\0");

  for (const { path, statusCode } of entries) {
    hash.update(path);
    hash.update("\0");
    hash.update(statusCode);
    hash.update("\0");

    // Concatenated as raw Buffers with a literal "/" separator, not `node:path.join` — see
    // PATH_SEP's doc comment above for why. `path` is already the exact bytes git printed (see
    // StatusEntry.path), so this is the only representation of the on-disk path used from here
    // on: every fs call below (`lstat`, `readlink`, `createReadStream`) takes `fullPath` directly.
    const fullPath = Buffer.concat([root, PATH_SEP, path]);

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
