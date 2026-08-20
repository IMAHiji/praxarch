import { execFile } from "node:child_process";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { loadConfig } from "../hooks/lib/config.js";
import { MAX_GIT_BUFFER, NEUTRALIZE_DIFF_CONFIG, matchesIgnorePattern } from "../hooks/lib/git-diff.js";
import { praxarchHome } from "../hooks/lib/paths.js";
import { listUntrackedPaths, repoRoot } from "../hooks/lib/untracked.js";

const execFileAsync = promisify(execFile);

/**
 * `praxarch verify-bundle` — a single prepared markdown artifact (base ref, diff --stat, full
 * diff, untracked-file contents, and optional test-command output) so a verification pass reads
 * one file instead of re-deriving the diff itself. Split out of #9; see issue #22 for the full
 * spec.
 *
 * Read-only against the repo by construction: every git invocation below is `diff`/`status`/
 * `rev-parse`/`ls-files` (never `add`, `commit`, `checkout`, or anything else that mutates the
 * index or working tree), and the only filesystem write this module performs is the bundle file
 * itself, at the caller-given `--out` path or the default under praxarch's own home directory —
 * see `defaultOutPath` below for why that, and not anything inside the target repo, is the
 * unconditionally-safe default.
 */

const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

// A per-file content cap for both the full diff and untracked-file dumps — generous rather than
// tuned, matching MAX_GIT_BUFFER's own "this is a safety margin, not a limit anyone should expect
// to hit" posture. Keeps one enormous generated/vendored file (missed by ignorePatterns) from
// blowing the bundle out to something no verifier can usefully read in one pass.
const MAX_UNTRACKED_FILE_BYTES = 256 * 1024;

interface VerifyBundleArgs {
  base: string | null;
  out: string | null;
  testCmd: string | null;
}

// A flag whose value is missing (end of argv, or the next token is itself another `--flag`) must
// error out, not silently fall back to the default as if the flag had never been given — a typo'd
// `--out --base main` would otherwise write to the default location while looking like it honored
// `--out`.
function readFlagValue(argv: string[], valueIndex: number, flag: string): string {
  const value = argv[valueIndex];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

// `--flag=value` is read here, ahead of (and independent from) the space-separated
// `--flag value` form `readFlagValue` handles below — `--out=` with nothing after the `=` is
// still a missing value (an empty string is never a valid path/ref/command), so that case falls
// through to the same "requires a value" error as the space-separated form instead of silently
// writing to "".
function readEqualsValue(token: string, flag: string): string | null {
  const prefix = `${flag}=`;
  if (!token.startsWith(prefix)) return null;
  const value = token.slice(prefix.length);
  if (value === "") throw new Error(`${flag} requires a value`);
  return value;
}

function parseArgs(argv: string[]): VerifyBundleArgs {
  const args: VerifyBundleArgs = { base: null, out: null, testCmd: null };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string; // loop bound guarantees this index exists
    const equalsBase = readEqualsValue(token, "--base");
    const equalsOut = readEqualsValue(token, "--out");
    const equalsTestCmd = readEqualsValue(token, "--test-cmd");
    if (equalsBase !== null) args.base = equalsBase;
    else if (equalsOut !== null) args.out = equalsOut;
    else if (equalsTestCmd !== null) args.testCmd = equalsTestCmd;
    else if (token === "--base") args.base = readFlagValue(argv, (i += 1), "--base");
    else if (token === "--out") args.out = readFlagValue(argv, (i += 1), "--out");
    else if (token === "--test-cmd") args.testCmd = readFlagValue(argv, (i += 1), "--test-cmd");
  }
  return args;
}

function fail(reason: string): number {
  process.stderr.write(`praxarch verify-bundle: ${reason}\n`);
  return 1;
}

async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
    return true;
  } catch {
    return false;
  }
}

interface ChangedFileEntry {
  path: string;
  added: number | null; // null means git reported "-" (binary content, no line count)
  removed: number | null;
  // How many consecutive "diff --git " sections (see filterDiffByEntries) this one --numstat
  // record corresponds to in the full diff. Always 1, except a typechange (a tracked path whose
  // type — regular file, symlink, submodule — changed, not just its content), which git renders as
  // exactly one --numstat record but two full-diff sections: a "deleted file mode" half and a "new
  // file mode" half. Derived from `git diff --raw -z`'s own status letter for the path (`T`), not
  // inferred from the diff text itself — see changedFileEntries below.
  sections: 1 | 2;
}

// Splits raw NUL-delimited git output on the raw byte, not on a decoded string's "\0" — mirrors
// splitOnNul in git-diff.ts (see StatusEntry.path's doc comment there for why decoding first would
// be the bug). `--numstat -z` still tab-separates the two count fields ahead of the (single, raw)
// path field within each NUL-terminated record.
function splitOnNul(buf: Buffer): Buffer[] {
  const entries: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] === 0x00) {
      if (i > start) entries.push(buf.subarray(start, i));
      start = i + 1;
    }
  }
  if (start < buf.length) entries.push(buf.subarray(start));
  return entries;
}

function parseNumstatZ(buf: Buffer): Omit<ChangedFileEntry, "sections">[] {
  return splitOnNul(buf).map((entry) => {
    const text = entry.toString("utf8");
    const firstTab = text.indexOf("\t");
    const secondTab = text.indexOf("\t", firstTab + 1);
    const addedStr = text.slice(0, firstTab);
    const removedStr = text.slice(firstTab + 1, secondTab);
    return {
      path: text.slice(secondTab + 1),
      added: addedStr === "-" ? null : Number(addedStr),
      removed: removedStr === "-" ? null : Number(removedStr),
    };
  });
}

// Parses `git diff --raw -z --no-renames` output into just the per-file status letter, in the
// same order git reports the files. Each record is two NUL-terminated tokens back to back — a
// metadata line (`:<old_mode> <new_mode> <old_sha> <new_sha> <status>`, no rename/copy score
// suffix since `--no-renames` rules those statuses out entirely) followed by the path itself —
// so token indices 0, 2, 4, ... are metadata and 1, 3, 5, ... are paths. Only the metadata token's
// trailing status letter is read here; the path token is skipped entirely (the numstat path,
// already read elsewhere, is the one actually used) since this function exists solely to answer
// "is this file's status T (typechange)," never to re-derive a path.
function parseRawStatusesZ(buf: Buffer): string[] {
  const tokens = splitOnNul(buf);
  const statuses: string[] = [];
  for (let i = 0; i < tokens.length; i += 2) {
    const meta = (tokens[i] as Buffer).toString("utf8").trim();
    const fields = meta.split(/\s+/);
    const statusField = fields[fields.length - 1] ?? "";
    statuses.push(statusField.charAt(0));
  }
  return statuses;
}

/**
 * Every changed-tracked-file record from `git diff --numstat -z --no-renames`, paired with a
 * `sections` count derived from `git diff --raw -z --no-renames`'s own status letter for that same
 * path.
 *
 * `-z` is the load-bearing flag on both invocations, mirroring `parseStatusZ` in git-diff.ts (read
 * that function's doc comment first): plain `--numstat`/`--raw` quote and octal-escape any path
 * git doesn't consider plain ASCII, or that contains a `"`, `\`, or control character — fine for
 * *display*, but not safely matchable against ignorePatterns, and not safely re-feedable to git as
 * a pathspec (a quoted/escaped string doesn't round-trip back into one). `-z` instead emits
 * unquoted, NUL-terminated records regardless of path content or `core.quotePath` — the same
 * guarantee `filterDiffByEntries` below relies on to never need to parse a path back out of the
 * full diff's own (still-quotable) `diff --git` header text. `--no-renames` guarantees a rename
 * always shows as two full records (an old-path delete and a new-path add) rather than one
 * `{old => new}`-shaped line with no safe string form — same guarantee, same reason, as
 * `--no-renames` on `git status` in parseStatusZ.
 *
 * `sections` exists because a typechange (a tracked path whose *type* — regular file, symlink,
 * submodule — changed, not just its content) is exactly one `--numstat`/`--raw` record but renders
 * as *two* `diff --git` sections in the full diff text: a "deleted file mode" half and a "new file
 * mode" half. `--raw -z` reports that as a single record with status letter `T`, which is what
 * `filterDiffByEntries` below uses to know how many consecutive sections belong to this one path,
 * instead of inferring it from the diff text (which is exactly the text-matching fragility this
 * module was rewritten to stop relying on).
 *
 * The paths returned here are read-only: they're matched against ignorePatterns and correlated
 * against git's own `--stat`/full-diff output by *position* (both invocations share the same
 * `--no-renames base` arguments as this one, so git's tree-diff walk visits files in the same
 * order for all three), never passed back to git as a pathspec argument (which is cwd-relative,
 * mismatched against these repo-root-relative paths, and can't represent a rename or a
 * quoted/escaped name in the first place).
 */
async function changedFileEntries(cwd: string, base: string): Promise<ChangedFileEntry[]> {
  const [{ stdout: numstatOut }, { stdout: rawOut }] = await Promise.all([
    execFileAsync("git", ["diff", ...NEUTRALIZE_DIFF_CONFIG, "--no-renames", base, "--numstat", "-z"], {
      cwd,
      maxBuffer: MAX_GIT_BUFFER,
      encoding: "buffer",
    }),
    execFileAsync("git", ["diff", ...NEUTRALIZE_DIFF_CONFIG, "--no-renames", base, "--raw", "-z"], {
      cwd,
      maxBuffer: MAX_GIT_BUFFER,
      encoding: "buffer",
    }),
  ]);
  const numstatEntries = parseNumstatZ(numstatOut);
  const statuses = parseRawStatusesZ(rawOut);
  if (statuses.length !== numstatEntries.length) {
    // Both invocations share identical `--no-renames base` arguments and walk the same tree diff,
    // so their record counts must always agree — a mismatch means something about the repo state
    // changed between the two calls (or a git behavior this module doesn't yet account for), and
    // guessing which records correspond would risk silently mis-grouping a typechange's sections.
    throw new Error(
      `git diff --numstat reported ${numstatEntries.length} file(s) but --raw reported ${statuses.length} — refusing to guess the mapping`,
    );
  }
  return numstatEntries.map((entry, i) => ({ ...entry, sections: statuses[i] === "T" ? 2 : 1 }));
}

// Splits git's own unfiltered full-diff text on raw "diff --git " *line boundaries* — any line
// starting with that literal 10-character prefix, regardless of what follows it — and keeps only
// the section(s) belonging to a `--numstat`-reported path whose `keptFlags` entry is true.
//
// Deliberately does NOT parse or reconstruct a path out of the header line's own text (`diff --git
// a/<path> b/<path>`), unlike an earlier version of this function. That text is not a reliable
// section-identity key: `diff.noprefix`/`diff.mnemonicPrefix`/custom `diff.srcPrefix`/
// `diff.dstPrefix` config can change or remove the `a/`/`b/` prefixes entirely (closed instead by
// forcing `--src-prefix=a/ --dst-prefix=b/` on the full-diff invocation below, which overrides all
// of those configs), and a path containing `"`, `\`, or a control character is C-quoted and
// backslash-escaped in the header regardless of `core.quotePath` (that setting only suppresses
// escaping of non-ASCII *bytes*, not git's separate, unconditional quoting of those specific
// characters) — so a literal-text match against the unquoted `--numstat`/`--raw` path silently
// fails to find its section for exactly those two config/path shapes.
//
// Instead, section boundaries are correlated to `--numstat` entries purely by *position* and
// *count*: entries and full-diff sections are produced by the same `--no-renames base` tree-diff
// walk, in the same order (see changedFileEntries's doc comment), so the first `entries[0].sections`
// segments belong to `entries[0]`, the next `entries[1].sections` to `entries[1]`, and so on.
// `sections` is 1 for an ordinary change and 2 for a typechange (derived from `--raw -z`'s `T`
// status letter, not inferred from the diff text itself) — replacing the previous per-path
// literal-header matching used to group a typechange's two sections, with no dependency on parsing
// any path out of quoted/prefix-varying header text.
function filterDiffByEntries(fullDiff: string, entries: ChangedFileEntry[], keptFlags: boolean[]): string {
  if (entries.length === 0) return "";
  const segments = fullDiff.split(/(?=^diff --git )/m).filter((segment) => segment.length > 0);
  const kept: string[] = [];
  let segmentIndex = 0;
  for (const [i, entry] of entries.entries()) {
    const consumed = segments.slice(segmentIndex, segmentIndex + entry.sections);
    if (consumed.length !== entry.sections) {
      // Should always find exactly `entry.sections` sections at this position. If it doesn't, fail
      // loud instead of silently dropping the entry or mis-attributing a later section to it.
      throw new Error(
        `expected ${entry.sections} "diff --git " section(s) at position ${segmentIndex} for "${entry.path}" (reported by --numstat/--raw) but found ${consumed.length} — refusing to guess the mapping`,
      );
    }
    segmentIndex += entry.sections;
    if (keptFlags[i]) kept.push(...consumed);
  }
  if (segmentIndex !== segments.length) {
    // Every section must belong to some numstat entry. Leftover, unconsumed sections mean git
    // produced more sections than the numstat paths account for — fail loud rather than silently
    // dropping them from the bundle.
    throw new Error(
      `git diff produced ${segments.length} file section(s) but only ${segmentIndex} could be matched to a --numstat entry — refusing to guess the mapping`,
    );
  }
  return kept.join("");
}

function summarizeEntries(entries: ChangedFileEntry[]): string {
  let insertions = 0;
  let deletions = 0;
  for (const entry of entries) {
    insertions += entry.added ?? 0;
    deletions += entry.removed ?? 0;
  }
  const parts = [`${entries.length} file${entries.length === 1 ? "" : "s"} changed`];
  if (insertions > 0) parts.push(`${insertions} insertion${insertions === 1 ? "" : "s"}(+)`);
  if (deletions > 0) parts.push(`${deletions} deletion${deletions === 1 ? "" : "s"}(-)`);
  return ` ${parts.join(", ")}`;
}

// Same positional-zip strategy as filterDiffByEntries, applied to `git diff --stat` instead: git
// emits exactly one line per changed file (in numstat order), followed by a single summary line.
// The per-file lines are kept verbatim (git's own human-readable formatting, including its
// quoting of unusual paths — cosmetic only here, since nothing downstream parses them back out);
// the summary line is discarded and recomputed from the *kept* entries only, since git's own
// summary was computed over the unfiltered set.
async function filteredStatText(
  cwd: string,
  base: string,
  allEntries: ChangedFileEntry[],
  keptFlags: boolean[],
  keptEntries: ChangedFileEntry[],
): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    // -c core.quotePath=false for display consistency with the full-diff invocation below — both
    // suppress octal-escaping of non-ASCII path bytes in git's own human-readable output. (Does not
    // affect a path containing `"`, `\`, or a control character, which git quotes regardless; that
    // quoting is cosmetic here since nothing downstream parses a path back out of this text.)
    //
    // --no-color: `--stat` is colorized under `color.ui=always`/`color.diff=always` the same way the
    // full-diff invocation is (each changed-file line's `+`/`-` counts get an ANSI escape prefix),
    // which would otherwise embed raw escape codes in the bundle's markdown here too.
    ["-c", "core.quotePath=false", "diff", ...NEUTRALIZE_DIFF_CONFIG, "--no-renames", "--no-color", base, "--stat"],
    { cwd, maxBuffer: MAX_GIT_BUFFER },
  );
  // One line per changed file, in numstat order, followed by exactly one trailing summary line
  // (" N files changed, ...") — the summary line is dropped here and recomputed from the kept
  // entries below, since git's own summary was computed over the unfiltered set.
  const lines = stdout.split("\n").filter((line) => line.length > 0);
  const fileLines = lines.slice(0, lines.length - 1);
  if (fileLines.length !== allEntries.length) {
    throw new Error(
      `git diff --stat produced ${fileLines.length} file line(s) but --numstat reported ${allEntries.length} — refusing to guess the mapping`,
    );
  }
  const kept = fileLines.filter((_, i) => keptFlags[i]);
  return [...kept, summarizeEntries(keptEntries)].join("\n");
}

async function resolveBase(cwd: string, requested: string | null): Promise<{ base: string; sha: string } | null> {
  const base = requested ?? "HEAD";
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", base], { cwd });
    return { base, sha: stdout.trim() };
  } catch {
    // An unborn HEAD (a real repo, zero commits) is the one case an unresolvable default base
    // should not be treated as a caller error: fall back to git's well-known empty-tree object so
    // a brand-new repo with only untracked/staged work still gets a real diff. A user-supplied
    // `--base` that doesn't resolve is always a real error, never silently substituted.
    if (requested === null) {
      try {
        await execFileAsync("git", ["cat-file", "-e", EMPTY_TREE_SHA], { cwd });
        return { base: "HEAD (unborn — diffed against the empty tree)", sha: EMPTY_TREE_SHA };
      } catch {
        return null;
      }
    }
    return null;
  }
}

// The hard guardrail is "a verify-bundle must never be committed," and a default location inside
// the target repo can only honor that conditionally — it depends on that repo's own .gitignore
// content, which praxarch doesn't own and can't guarantee in every consuming repo. Writing under
// praxarch's own home directory instead (mirroring paths.ts's stateDir()/logDir() pattern) makes
// the guardrail hold unconditionally, for every repo praxarch is installed into, with no reliance
// on that repo's ignore rules. `--out` remains the explicit, unchanged override for anyone who
// deliberately wants the bundle somewhere else (including inside the repo).
// The per-repo subdirectory is named `<basename>-<hash of the absolute repo root>` rather than just
// the basename, so two differently-located repos that happen to share a directory name (e.g. two
// checkouts both named "praxarch") don't collide.
function defaultOutPath(repoRootStr: string): string {
  const hash = createHash("sha256").update(repoRootStr).digest("hex").slice(0, 8);
  const repoDir = `${basename(repoRootStr)}-${hash}`;
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(praxarchHome(), "verify-bundles", repoDir, `${timestamp}.md`);
}

function runTestCmd(cwd: string, cmd: string): string {
  const result = spawnSync("sh", ["-c", cmd], { cwd, encoding: "utf8", maxBuffer: MAX_GIT_BUFFER });
  const parts = [`$ ${cmd}`];
  if (result.error) {
    parts.push(`(failed to run: ${String(result.error)})`);
  } else {
    if (result.stdout) parts.push(result.stdout.replace(/\n$/, ""));
    if (result.stderr) parts.push(`--- stderr ---\n${result.stderr.replace(/\n$/, "")}`);
    parts.push(`(exit code: ${result.status ?? "unknown"})`);
  }
  return parts.join("\n");
}

export async function verifyBundle(argv: string[], cwd: string = process.cwd()): Promise<number> {
  let args: VerifyBundleArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  if (!(await isGitRepo(cwd))) {
    return fail(`${cwd} is not inside a git working tree`);
  }

  let repoRootStr: string;
  try {
    repoRootStr = (await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd })).stdout.trim();
  } catch (err) {
    return fail(`could not resolve repo root: ${String(err)}`);
  }

  const resolved = await resolveBase(cwd, args.base);
  if (!resolved) {
    return fail(`--base "${args.base}" does not resolve to a valid ref`);
  }
  const { base, sha: baseSha } = resolved;

  const { config, warnings } = await loadConfig(cwd);
  if (warnings.length > 0) process.stderr.write(`praxarch verify-bundle: ${warnings.join(" ")}\n`);
  const ignorePatterns = config.verifyGate.ignorePatterns;

  let allEntries: ChangedFileEntry[];
  try {
    allEntries = await changedFileEntries(cwd, baseSha);
  } catch (err) {
    return fail(`could not compute the tracked diff: ${String(err)}`);
  }
  const keptFlags = allEntries.map(
    (entry) => !ignorePatterns.some((pattern) => matchesIgnorePattern(entry.path, pattern)),
  );
  const ignoredCount = keptFlags.filter((kept) => !kept).length;
  const keptEntries = allEntries.filter((_, i) => keptFlags[i]);

  let statText: string;
  let diffText: string;
  if (keptEntries.length === 0) {
    statText = "(no tracked changes after applying ignorePatterns)";
    diffText = "(no tracked changes after applying ignorePatterns)";
  } else {
    try {
      const { stdout: fullDiff } = await execFileAsync(
        "git",
        // -c core.quotePath=false: display consistency for non-ASCII paths (cosmetic — see
        // filterDiffByEntries's doc comment for why nothing here parses a path back out of this
        // header text, so a still-quoted `"`/`\`/control-char path is not a correctness concern).
        //
        // --src-prefix=a/ --dst-prefix=b/: pins the header prefix regardless of a repo's own
        // `diff.noprefix`/`diff.mnemonicPrefix`/`diff.srcPrefix`/`diff.dstPrefix` config — git's own
        // documented mechanism for this, present since a very old git version (confirmed present in
        // this environment's git 2.54.0; `git diff --help` documents both flags). Without this, e.g.
        // `diff.noprefix=true` emits `diff --git new.txt new.txt` — still a well-formed
        // "diff --git " line, so filterDiffByEntries's position/count-based section splitting below
        // is unaffected either way; these two flags exist purely so the *displayed* header inside
        // the bundle stays in git's conventional a/ b/ form regardless of the invoking repo's config.
        //
        // --submodule=short: pins predictable, minimal submodule-diff rendering (a single ordinary
        // "diff --git" section per changed submodule pointer) regardless of the invoking repo's
        // `diff.submodule` config. `diff.submodule=log` replaces that section with a bare
        // "Submodule <name> <old>..<new>:" line and no "diff --git" header at all, under-supplying
        // sections and tripping filterDiffByEntries's "found fewer — refusing to guess the mapping"
        // guard for the entire diff, not just the submodule entry; `diff.submodule=diff` does the
        // opposite, injecting the submodule's own inner "diff --git" headers into the outer patch and
        // over-supplying sections. `--short` (git's actual default when `diff.submodule` is unset)
        // is what both `--raw` and `--numstat` above already report a submodule pointer change as,
        // so this keeps all three invocations counting the same one section per submodule entry.
        //
        // --no-color: without it, `color.ui=always`/`color.diff=always` prefixes each "diff --git "
        // header line with an ANSI escape, which breaks filterDiffByEntries's
        // `/(?=^diff --git )/m` line-boundary split (matches nothing for more than one changed file,
        // and embeds raw escape codes in the bundle's markdown even for a single file).
        [
          "-c",
          "core.quotePath=false",
          "diff",
          ...NEUTRALIZE_DIFF_CONFIG,
          "--no-renames",
          "--src-prefix=a/",
          "--dst-prefix=b/",
          "--submodule=short",
          "--no-color",
          baseSha,
        ],
        { cwd, maxBuffer: MAX_GIT_BUFFER },
      );
      diffText = filterDiffByEntries(fullDiff, allEntries, keptFlags);
      statText = await filteredStatText(cwd, baseSha, allEntries, keptFlags, keptEntries);
    } catch (err) {
      return fail(`could not compute the diff: ${String(err)}`);
    }
  }

  // Untracked files, filtered by the same ignorePatterns, with full content — this is what lets a
  // verifier see a brand-new file without separately exploring the tree. A path this module can't
  // represent as a string (see UntrackedPath.path's doc comment in untracked.ts) is listed by name
  // only, never matched against ignorePatterns and never read.
  const root = await repoRoot(cwd);
  const untrackedPaths = root === null ? null : await listUntrackedPaths(cwd);
  const untrackedSections: string[] = [];
  if (root !== null && untrackedPaths !== null) {
    for (const entry of untrackedPaths) {
      if (entry.path !== null && ignorePatterns.some((p) => matchesIgnorePattern(entry.path as string, p))) {
        continue;
      }
      const label = entry.path ?? "(path not representable as UTF-8)";
      const fullPath = Buffer.concat([root, Buffer.from("/"), entry.raw]);
      try {
        const buf = await readFile(fullPath);
        if (buf.includes(0)) {
          untrackedSections.push(`### ${label}\n\n(binary file, ${buf.length} bytes — content omitted)`);
        } else if (buf.length > MAX_UNTRACKED_FILE_BYTES) {
          untrackedSections.push(
            `### ${label}\n\n(${buf.length} bytes — exceeds the ${MAX_UNTRACKED_FILE_BYTES}-byte bundle cap, content omitted)`,
          );
        } else {
          untrackedSections.push(`### ${label}\n\n\`\`\`\n${buf.toString("utf8")}\n\`\`\``);
        }
      } catch (err) {
        untrackedSections.push(`### ${label}\n\n(could not read: ${String(err)})`);
      }
    }
  }

  const sections: string[] = [];
  sections.push("# verify-bundle");
  sections.push(
    `Generated: ${new Date().toISOString()}\nBase ref: \`${base}\` (\`${baseSha}\`)` +
      (ignoredCount > 0 ? `\nTracked files excluded by ignorePatterns: ${ignoredCount}` : ""),
  );
  // Not `.trim()`'d: `statText` is git's own `--stat` line formatting, where every per-file line
  // (and the summary line, from summarizeEntries) shares one leading space that is load-bearing for
  // column alignment against the rest of the block — `.trim()` here used to strip only the *first*
  // line's leading space (String.prototype.trim only touches the very start/end of the whole
  // string), misaligning it against every subsequent line. `statText` itself is never an empty
  // string (the `keptEntries.length === 0` branch above sets a non-empty placeholder, and
  // `filteredStatText` always yields at least a summary line), so `|| "(empty)"` is a defensive
  // fallback rather than a case this reaches in practice.
  sections.push(`## git diff --stat\n\n\`\`\`\n${statText || "(empty)"}\n\`\`\``);
  sections.push(`## Full diff\n\n\`\`\`diff\n${diffText.trim() || "(empty)"}\n\`\`\``);
  sections.push(
    untrackedPaths === null
      ? "## Untracked files\n\n(could not list untracked files)"
      : untrackedSections.length > 0
        ? `## Untracked files\n\n${untrackedSections.join("\n\n")}`
        : "## Untracked files\n\n(none)",
  );
  if (args.testCmd) {
    sections.push(`## Test command output\n\n\`\`\`\n${runTestCmd(cwd, args.testCmd)}\n\`\`\``);
  }

  const markdown = sections.join("\n\n") + "\n";

  const outPath = args.out
    ? isAbsolute(args.out)
      ? args.out
      : resolve(cwd, args.out)
    : defaultOutPath(repoRootStr);

  try {
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, markdown, "utf8");
  } catch (err) {
    return fail(`could not write bundle to ${outPath}: ${String(err)}`);
  }

  process.stdout.write(`praxarch verify-bundle: wrote ${outPath}\n`);
  return 0;
}
