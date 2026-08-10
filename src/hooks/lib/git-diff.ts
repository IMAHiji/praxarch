import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Patches can be large; Node's default 1MB maxBuffer would reject the exec call outright (caught
// below, turning into hash: null) well before anything worth calling a "large diff" is reached.
// Generous rather than tuned — this is a safety margin, not a limit anyone should expect to hit.
const MAX_DIFF_BUFFER = 64 * 1024 * 1024;

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

async function trackedDiff(cwd: string, target: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["diff", ...NEUTRALIZE_DIFF_CONFIG, target, ...args], {
      cwd,
      maxBuffer: MAX_DIFF_BUFFER,
    });
    return stdout;
  } catch (err) {
    if (target === "HEAD") throw err;
    // Baseline sha may be stale/unknown (e.g. repo reset) — fall back to HEAD diff.
    const { stdout } = await execFileAsync("git", ["diff", ...NEUTRALIZE_DIFF_CONFIG, "HEAD", ...args], {
      cwd,
      maxBuffer: MAX_DIFF_BUFFER,
    });
    return stdout;
  }
}

async function listUntracked(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["ls-files", "--others", "--exclude-standard"], { cwd });
    return stdout.split("\n").filter((line) => line.trim().length > 0);
  } catch {
    return [];
  }
}

/**
 * Sizes the session's real diff: changes against `baseline` (the HEAD sha recorded at
 * SessionStart) when given, so committed work still gets measured — plus untracked new files,
 * which `git diff` never sees. Excludes paths matching any ignorePattern substring. Returns
 * zeros if cwd isn't a git repo — the verify-gate treats that as "nothing to gate on" rather than
 * failing the hook.
 *
 * Deliberately cheap: only `--numstat` (tracked) and untracked-file byte-length line counts are
 * computed — no patch text is fetched. Callers that also need the fingerprint (e.g. to detect a
 * stale verdict) call `diffFingerprint` separately, and only when they actually need it — see its
 * doc comment for why that split exists.
 */
export async function diffStat(cwd: string, ignorePatterns: string[], baseline?: string | null): Promise<DiffCounts> {
  const target = baseline ? baseline : "HEAD";

  let tracked: DiffCounts = { changedLines: 0, changedFiles: 0 };
  try {
    const numstatOut = await trackedDiff(cwd, target, ["--numstat"]);
    tracked = parseNumstat(numstatOut, ignorePatterns);
  } catch {
    // No usable committed diff (e.g. no commits yet, or not a git repo) — tracked portion is
    // zero, but untracked-file counting below still runs.
  }

  let changedLines = tracked.changedLines;
  let changedFiles = tracked.changedFiles;
  for (const path of await listUntracked(cwd)) {
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

/**
 * Fingerprint of the diff: sha256 over the full (unfiltered) patch text plus, for each untracked
 * path in sorted order, the path and its raw byte contents. Deliberately ignores ignorePatterns —
 * see the doc comment on diffStat's caller (verify-gate) for why that's safe: a hash difference
 * alone never expires a verdict, only a hash difference paired with a size delta past the
 * configured thresholds does, so lockfile-only churn can't spuriously expire a verdict.
 *
 * `null` means the fingerprint could not be computed — either the patch fetch failed (e.g. it
 * exceeded maxBuffer) or the cheap --numstat probe that precedes it failed for a reason other than
 * "genuinely nothing to diff" (not a git repo, or a repo with no commits, which still yields the
 * deterministic hash of the empty patch below). Callers must treat `null` as "unknown", never as
 * "unchanged" — a hash that silently stopped tracking a diff would make a recorded verdict
 * immortal against exactly the diffs most likely to need re-verification.
 *
 * Split out from diffStat (which returns counts only) because this is the expensive half: it can
 * fetch up to 64MB of patch text and read every untracked file's full contents, where diffStat's
 * counts already served the common case (a trivial diff that returns at verify-gate's early
 * allow, or a Stop where no verifier verdict was even parsed in telemetry) far more cheaply.
 * Callers invoke this only after establishing they actually need a fingerprint.
 */
export async function diffFingerprint(cwd: string, baseline?: string | null): Promise<string | null> {
  const target = baseline ? baseline : "HEAD";
  const hash = createHash("sha256");

  let noUsableDiff = false;
  let hashUnknown = false;
  try {
    // A cheap call first (small output even on a huge diff) just to distinguish "no usable
    // committed diff" (no commits yet / not a git repo — a real, deterministic hash of nothing)
    // from a genuine fetch failure on the full patch text below (most likely maxBuffer on a very
    // large diff — hash must become null, not silently hash nothing).
    await trackedDiff(cwd, target, ["--numstat"]);
  } catch {
    // The probe itself failed. That's ambiguous on its own — it must not be assumed to mean "no
    // usable committed diff" (which is only true when there's structurally nothing to diff: not a
    // git repo, or a repo with no commits yet) — a probe failure for some other reason (corrupt
    // repo state, a transient git failure) could be hiding a real diff, and falling through to the
    // deterministic empty-patch hash below would be exactly the "unknown masquerading as
    // unchanged" bug this function exists to prevent. Disambiguate with an independent, cheap
    // check: if HEAD itself doesn't resolve, there's genuinely nothing to diff and the
    // deterministic hash is correct; if HEAD resolves fine, something else made the probe fail and
    // the fingerprint must become null instead.
    try {
      await execFileAsync("git", ["rev-parse", "--verify", "HEAD"], { cwd });
      hashUnknown = true;
    } catch {
      noUsableDiff = true;
    }
  }

  if (!noUsableDiff) {
    try {
      hash.update(await trackedDiff(cwd, target, []));
    } catch {
      hashUnknown = true;
    }
  }

  if (!hashUnknown) {
    for (const path of [...(await listUntracked(cwd))].sort()) {
      let contents: Buffer | null = null;
      try {
        contents = await readFile(join(cwd, path));
      } catch {
        // Unreadable file (race, permissions, binary) — contributes its path only.
      }
      // NUL can't appear in a path, so it's a safe delimiter; the content length prefix plus a
      // second delimiter makes the path/content boundary unambiguous even when one path is a
      // prefix of another path's content (e.g. path "afile" + content "b" vs path "afileb" +
      // content "" previously hashed identically with no delimiter at all). Bytes, not a utf8
      // decode: decoding first would collapse invalid byte sequences to U+FFFD and hash the
      // *decoded* length, making distinct binary contents collide.
      hash.update(path);
      hash.update("\0");
      if (contents !== null) {
        hash.update(String(contents.length));
        hash.update("\0");
        hash.update(contents);
      }
    }
  }

  return hashUnknown ? null : hash.digest("hex");
}
