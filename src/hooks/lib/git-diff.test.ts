import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DiffCounts } from "./git-diff.js";
import type { getMkfifoProbe as GetMkfifoProbe } from "./fixtures/mkfifo-probe.js";
// Imports the compiled output, not the sibling .ts source — matches the convention in
// config.test.ts (see the comment there): tests resolve modules the way Node does at runtime.
const here = dirname(fileURLToPath(import.meta.url));
const { diffStat, diffFingerprint } = (await import(
  join(here, "..", "..", "..", "dist", "hooks", "lib", "git-diff.js")
)) as typeof import("./git-diff.js");
// Same convention as above: the shared mkfifo probe is test infra, not product code, but a bare
// "./fixtures/mkfifo-probe.ts" specifier fails tsc (TS5097) since this project emits, and the
// sibling fixtures/*-runner.ts files are already executed from dist -- this sits where the build
// already handles it.
const { getMkfifoProbe } = (await import(
  join(here, "..", "..", "..", "dist", "hooks", "lib", "fixtures", "mkfifo-probe.js")
)) as { getMkfifoProbe: typeof GetMkfifoProbe };

// `diffStat` returns `DiffCounts | null` (null means "could not measure"). Every call site below
// that expects a real measurement (a healthy repo, no simulated failure) routes through this so a
// regression that turns a healthy-path measurement into `null` fails loudly with a clear message,
// rather than as an opaque "Cannot read properties of null" a bare destructure would produce.
function assertMeasured(counts: DiffCounts | null): DiffCounts {
  assert.notEqual(counts, null, "expected diffStat to return real counts, not null, on this healthy-path call");
  return counts as DiffCounts;
}

// mkfifo isn't available on every platform node:test runs on (notably Windows), and a platform
// can also ship the binary while blocking the underlying syscall (the plausible shape of a CI
// container sandbox) -- `which mkfifo` succeeding proves only that the binary is on PATH, not
// that mkfifo(2) actually works here. The FIFO-dependent tests below need the latter claim, so
// the guard is a functional probe shared with verify-gate.test.ts (see fixtures/mkfifo-probe.ts):
// create a real FIFO in a throwaway temp directory and confirm via lstat that what landed on disk
// is actually a FIFO. It never opens the FIFO for reading or writing -- opening (not creating) is
// the operation that can block forever -- and it caches its result once per process. `node --test`
// runs each test file in its own child process, so in practice that means once per file: this
// file's three FIFO tests share the single call below, and verify-gate.test.ts's FIFO test
// performs its own separate probe call in its own process. That still satisfies "once per
// process, not once per test" -- it just means "process" is per test-file here, not global.
const mkfifoProbeResult = await getMkfifoProbe();
const hasMkfifo = mkfifoProbeResult.ok;
const mkfifoSkipReason = mkfifoProbeResult.reason ?? "mkfifo not available on this platform";

// The real-FIFO scenario runs in a spawned child rather than in-process: a regressed isFile()
// gate makes createReadStream block forever on a writerless FIFO, and that block happens inside
// libuv's threadpool where node:test can neither abort it nor finish reporting -- an in-process
// per-test timeout cannot fire against it (see git-diff.test.ts history / issue #3). Spawning
// lets the parent SIGKILL the child on a deadline and turn the hang itself into an assertion
// failure instead of wedging the whole suite.
const fifoRunnerPath = join(here, "..", "..", "..", "dist", "hooks", "lib", "fixtures", "fifo-fingerprint-runner.js");
const specialRunnerPath = join(here, "..", "..", "..", "dist", "hooks", "lib", "fixtures", "special-fingerprint-runner.js");
const diffStatFifoRunnerPath = join(
  here,
  "..",
  "..",
  "..",
  "dist",
  "hooks",
  "lib",
  "fixtures",
  "diffstat-fifo-runner.js",
);

interface FifoRunnerResult {
  before: string | null;
  withFifo: string | null;
  afterRestoring: string | null;
}

interface SpecialRunnerResult {
  actual: string | null;
  expected: string;
}

interface DiffStatFifoRunnerResult {
  result: DiffCounts | null;
}

// Reusable by other tests/fixtures that need to bound a child process with a hard deadline and
// convert expiry into a descriptive assertion failure (see issue #2, which needs a FIFO fixture
// of its own). `deadlineMessage` names the suspected regression so a failure reads as a lead,
// not a mystery timeout.
async function runWithDeadline(
  scriptPath: string,
  deadlineMs: number,
  deadlineMessage: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, deadlineMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`${deadlineMessage} (deadline ${deadlineMs}ms exceeded; stdout so far: ${stdout || "<empty>"})`));
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

async function makeRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "praxarch-gitdiff-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  await writeFile(join(repo, "file.txt"), "line\n".repeat(5));
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });
  return repo;
}

// A fake `git` on PATH that behaves like the real one except for the one call `failOn` names —
// simulating a real, black-box failure of that specific call without actually generating tens of
// megabytes of test fixture. Also counts every invocation line to a log file, so tests can assert
// a bare diff was (or wasn't) invoked at all.
//
// - `"diff"` fails the bare patch fetch (`git diff <target>` with no --numstat); nothing in
//   diffFingerprint calls this anymore, but diffStat's own laziness test still uses this mode to
//   confirm diffStat never triggers it either.
// - `"numstat"` fails the --numstat probe itself (everything else passes through to the real
//   git) — diffStat's tracked-count path degrading gracefully when its own probe fails.
// - `"status"` fails `git status` outright — the primary failure path diffFingerprint's null
//   contract exists to cover (round 4's git-status-overflow scenario, generalized).
// - `"oversizedStatus"` makes `git status` print output larger than MAX_GIT_BUFFER instead of
//   failing outright — the maxBuffer-overflow variant of the same contract, without generating
//   15k real files: the shim just emits a large synthetic blob for that one call.
// - `"ls-files"` fails the untracked-file listing specifically, with `--numstat` passing through —
//   diffStat's null contract for a failed listing inside an otherwise-successful measurement.
async function makeFakeGitDir(
  logPath?: string,
  failOn: "diff" | "numstat" | "status" | "oversizedStatus" | "ls-files" = "diff",
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "praxarch-gitdiff-fakegit-"));
  // Resolve the real git's absolute path up front — the script below must never call "git" by
  // bare name, since by the time it runs, PATH has this fake directory prepended and a bare
  // call would just recurse into itself.
  const realGit = execFileSync("which", ["git"]).toString("utf8").trim();
  const logLine = logPath ? `echo "$*" >> "${logPath}"\n` : "";
  const caseBody = (() => {
    switch (failOn) {
      case "numstat":
        return [
          'case "$*" in',
          `  *--numstat*) echo "fake git: numstat probe failed" >&2; exit 1 ;;`,
          `  *) exec "${realGit}" "$@" ;;`,
          "esac",
        ];
      case "status":
        return [
          'case "$*" in',
          `  *--numstat*) exec "${realGit}" "$@" ;;`,
          `  *ls-files*) exec "${realGit}" "$@" ;;`,
          '  status*) echo "fake git: status failed" >&2; exit 1 ;;',
          `  *) exec "${realGit}" "$@" ;;`,
          "esac",
        ];
      case "oversizedStatus":
        return [
          'case "$*" in',
          `  *--numstat*) exec "${realGit}" "$@" ;;`,
          `  *ls-files*) exec "${realGit}" "$@" ;;`,
          // Larger than MAX_GIT_BUFFER (64MB) — /dev/zero keeps this fast without a real 15k-file
          // fixture. Node's execFile rejects on overflow, which is exactly the failure this mode
          // exists to simulate.
          '  status*) head -c 68000000 /dev/zero ;;',
          `  *) exec "${realGit}" "$@" ;;`,
          "esac",
        ];
      case "ls-files":
        return [
          'case "$*" in',
          `  *--numstat*) exec "${realGit}" "$@" ;;`,
          `  *ls-files*) echo "fake git: ls-files failed" >&2; exit 1 ;;`,
          `  *) exec "${realGit}" "$@" ;;`,
          "esac",
        ];
      case "diff":
      default:
        return [
          'case "$*" in',
          `  *--numstat*) exec "${realGit}" "$@" ;;`,
          `  *ls-files*) exec "${realGit}" "$@" ;;`,
          '  *diff*) echo "fake git: patch fetch failed" >&2; exit 1 ;;',
          `  *) exec "${realGit}" "$@" ;;`,
          "esac",
        ];
    }
  })();
  const script = ["#!/bin/sh", logLine.trimEnd(), ...caseBody].filter((line) => line.length > 0).join("\n");
  await writeFile(join(dir, "git"), `${script}\n`, "utf8");
  await chmod(join(dir, "git"), 0o755);
  return dir;
}

async function withFakeGitOnPath<T>(
  fn: () => Promise<T>,
  logPath?: string,
  failOn: "diff" | "numstat" | "status" | "oversizedStatus" | "ls-files" = "diff",
): Promise<T> {
  const fakeGitDir = await makeFakeGitDir(logPath, failOn);
  const prevPath = process.env["PATH"];
  process.env["PATH"] = `${fakeGitDir}:${prevPath ?? ""}`;
  try {
    return await fn();
  } finally {
    process.env["PATH"] = prevPath;
    await rm(fakeGitDir, { recursive: true, force: true });
  }
}

// A no-op GIT_EXTERNAL_DIFF driver: git invokes it once per changed path and uses whatever it
// prints (nothing, here) as that path's diff output. --numstat is documented to never invoke an
// external diff driver, so this blanks only the bare `git diff` fetch a real config or an
// inherited env var would silently affect the same way.
async function makeNoOpExternalDiffScript(): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "praxarch-gitdiff-extdiff-"));
  const path = join(dir, "noop-external-diff.sh");
  await writeFile(path, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(path, 0o755);
  return { dir, path };
}

test("diffStat returns a stable count for an unchanged tree", async () => {
  const repo = await makeRepo();
  try {
    const a = assertMeasured(await diffStat(repo, [], null));
    const b = assertMeasured(await diffStat(repo, [], null));
    assert.deepEqual(a, b);
    assert.equal(a.changedLines, 0);
    assert.equal(a.changedFiles, 0);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("diffStat counts change when the tracked diff changes", async () => {
  const repo = await makeRepo();
  try {
    await writeFile(join(repo, "file.txt"), "changed line\n".repeat(5));
    const after = assertMeasured(await diffStat(repo, [], null));
    assert.equal(after.changedFiles, 1);
    assert.ok(after.changedLines > 0);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("diffStat counts tracked and untracked changes together (healthy-path regression pin)", async () => {
  // Both halves of the measurement in one test -- a regression that broke either the tracked
  // (--numstat) side or the untracked (ls-files + byte-length) side alone would still pass the
  // single-purpose tests above/below on its own.
  const repo = await makeRepo();
  try {
    await writeFile(join(repo, "file.txt"), "changed line\n".repeat(5));
    await writeFile(join(repo, "new.txt"), "untracked line\n".repeat(3));
    const result = assertMeasured(await diffStat(repo, [], null));
    assert.equal(result.changedFiles, 2);
    assert.ok(result.changedLines > 3);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("diffStat returns zeros, without throwing, when cwd isn't a git repo at all (deliberate fail-open, unchanged by the null contract)", async () => {
  // Positive detection (isGitRepo), not an inferred "the diff call failed" -- this is the one
  // case the null contract deliberately leaves as-is: a non-repo cwd has nothing to gate on, so
  // verify-gate's trivial-diff allow should still fire, same as before this fix.
  const repo = await mkdtemp(join(tmpdir(), "praxarch-gitdiff-nogit-"));
  try {
    const result = await diffStat(repo, [], null);
    assert.notEqual(result, null, "a non-repo cwd must stay {0, 0}, never null");
    assert.equal(result?.changedLines, 0);
    assert.equal(result?.changedFiles, 0);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("diffStat returns real counts (not null) in a repo with no commits yet -- unborn HEAD is 'nothing committed', not 'unknown'", async () => {
  // The one bad-object-shaped failure diffStat's catch must NOT turn into null: a brand-new repo
  // with only untracked work is a healthy, common case (see verify-gate.test.ts's matching
  // end-to-end test), not a measurement failure.
  const repo = await mkdtemp(join(tmpdir(), "praxarch-gitdiff-nohead-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  try {
    await writeFile(join(repo, "new.txt"), "new line\n".repeat(5));
    const result = assertMeasured(await diffStat(repo, [], null));
    assert.equal(result.changedFiles, 1);
    assert.ok(result.changedLines > 0);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("diffStat returns null when the --numstat probe fails in a real repo (not a bad-object failure)", async () => {
  const repo = await makeRepo();
  try {
    await withFakeGitOnPath(
      async () => {
        const result = await diffStat(repo, [], null);
        assert.equal(result, null);
      },
      undefined,
      "numstat",
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("diffStat returns null when ls-files fails in a real repo, even though --numstat itself succeeded", async () => {
  const repo = await makeRepo();
  try {
    await writeFile(join(repo, "file.txt"), "changed line\n".repeat(5));
    await withFakeGitOnPath(
      async () => {
        const result = await diffStat(repo, [], null);
        assert.equal(
          result,
          null,
          "a failed untracked-file listing must null out the whole measurement, not just contribute nothing",
        );
      },
      undefined,
      "ls-files",
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("diffFingerprint returns a stable hash for an unchanged tree", async () => {
  const repo = await makeRepo();
  try {
    const a = await diffFingerprint(repo);
    const b = await diffFingerprint(repo);
    assert.equal(a, b);
    assert.equal(typeof a, "string");
    assert.ok((a ?? "").length > 0);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("diffFingerprint hash changes when the tracked diff changes", async () => {
  const repo = await makeRepo();
  try {
    const before = await diffFingerprint(repo);
    await writeFile(join(repo, "file.txt"), "changed line\n".repeat(5));
    const after = await diffFingerprint(repo);
    assert.notEqual(before, after);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("diffFingerprint hash changes when an untracked file's contents change", async () => {
  const repo = await makeRepo();
  try {
    await writeFile(join(repo, "new.txt"), "v1\n");
    const before = await diffFingerprint(repo);
    await writeFile(join(repo, "new.txt"), "v2\n");
    const after = await diffFingerprint(repo);
    assert.notEqual(before, after);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("diffFingerprint returns null when cwd isn't a git repo at all (git status itself fails)", async () => {
  // No `git init` at all -- `git status` fails outright, which must read as unknown, not as the
  // deterministic "nothing to diff" hash (that's reserved for a real repo with an unborn HEAD,
  // tested separately below).
  const repo = await mkdtemp(join(tmpdir(), "praxarch-gitdiff-nogit2-"));
  try {
    const result = await diffFingerprint(repo);
    assert.equal(result, null);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("diffFingerprint returns null when git status fails (round-4 primary failure path)", async () => {
  const repo = await makeRepo();
  try {
    await withFakeGitOnPath(
      async () => {
        const result = await diffFingerprint(repo);
        assert.equal(result, null);
      },
      undefined,
      "status",
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("diffFingerprint returns null when git status exceeds the buffer, not a hash computed from a truncated listing", async () => {
  const repo = await makeRepo();
  try {
    await withFakeGitOnPath(
      async () => {
        const result = await diffFingerprint(repo);
        assert.equal(result, null);
      },
      undefined,
      "oversizedStatus",
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("diffFingerprint on an unborn-HEAD repo (git init, no commits) with untracked files is a real hash that tracks content", async () => {
  const repo = await mkdtemp(join(tmpdir(), "praxarch-gitdiff-nohead-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  try {
    await writeFile(join(repo, "new.txt"), "v1\n");
    const before = await diffFingerprint(repo);
    assert.notEqual(before, null);
    assert.equal(typeof before, "string");

    // The "NOHEAD" sentinel still lets content changes move the hash -- an unborn HEAD isn't a
    // reason to stop tracking the tree, only a reason not to have a real sha to include.
    await writeFile(join(repo, "new.txt"), "v2\n");
    const after = await diffFingerprint(repo);
    assert.notEqual(before, after);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("a content edit inside an already-modified (still 'M') file moves the fingerprint", async () => {
  // Proves file contents are hashed, not just the status entry's path+status-code pair -- a
  // paths-only implementation would pass every other test here but fail this one, since the
  // status code ("M") and path don't change between the two writes below.
  const repo = await makeRepo();
  try {
    await writeFile(join(repo, "file.txt"), "changed line\n".repeat(5));
    const first = await diffFingerprint(repo);
    await writeFile(join(repo, "file.txt"), "changed line\n".repeat(5) + "one more\n");
    const second = await diffFingerprint(repo);
    assert.notEqual(first, second);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("commit-then-edit: the fingerprint moves when work is committed, and moves again on further edits", async () => {
  // Round 4's critical scenario: committing work must not "launder" it out of the fingerprint by
  // leaving it as an unreviewed baseline -- the new design covers committed work structurally
  // (the HEAD sha is part of every hash), so this must hold without any patch-fetch fallback.
  const repo = await makeRepo();
  try {
    const beforeCommit = await diffFingerprint(repo);

    await writeFile(join(repo, "file.txt"), "changed line\n".repeat(5));
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "-q", "-m", "work"], { cwd: repo });
    const afterCommit = await diffFingerprint(repo);
    assert.notEqual(beforeCommit, afterCommit, "committing alone must move the hash");

    await writeFile(join(repo, "file.txt"), "changed line\n".repeat(5) + "more\n");
    const afterEdit = await diffFingerprint(repo);
    assert.notEqual(afterCommit, afterEdit, "editing after the commit must move the hash again");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("untracked path/content hashing is unambiguous (no path+content boundary collision)", async () => {
  // Old scheme (no delimiter) hashed `path` then `contents` back-to-back — "afile"+"b" and
  // "afileb"+"" both hash identically to the byte sequence "afileb". A real delimiter plus a
  // length prefix must make these distinguishable.
  const repoA = await makeRepo();
  const repoB = await makeRepo();
  try {
    await writeFile(join(repoA, "afile"), "b");
    await writeFile(join(repoB, "afileb"), "");
    const a = await diffFingerprint(repoA);
    const b = await diffFingerprint(repoB);
    assert.notEqual(a, b);
  } finally {
    await rm(repoA, { recursive: true, force: true });
    await rm(repoB, { recursive: true, force: true });
  }
});

// --- --no-ext-diff / --no-textconv (round-3 major) ----------------------------------------------

test("a GIT_EXTERNAL_DIFF diff driver in the environment does not blank the fingerprint", async () => {
  const repo = await makeRepo();
  const { dir: extDiffDir, path: extDiffScript } = await makeNoOpExternalDiffScript();
  const prevExtDiff = process.env["GIT_EXTERNAL_DIFF"];
  process.env["GIT_EXTERNAL_DIFF"] = extDiffScript;
  try {
    const before = await diffFingerprint(repo);
    await writeFile(join(repo, "file.txt"), "changed line\n".repeat(5));
    const after = await diffFingerprint(repo);
    // Regression guard, not a live exposure anymore: the fingerprint no longer runs `git diff` at
    // all (only `status` and `rev-parse`, neither of which invoke a diff driver), so an external
    // diff driver structurally cannot blank it the way it blanked the round-1 patch fetch (600
    // unverified lines allowed past a CONFIRMED verdict). This test now passes for a different
    // reason than it used to -- it stands as a guard against that failure mode ever coming back.
    assert.notEqual(before, after);
  } finally {
    if (prevExtDiff === undefined) delete process.env["GIT_EXTERNAL_DIFF"];
    else process.env["GIT_EXTERNAL_DIFF"] = prevExtDiff;
    await rm(repo, { recursive: true, force: true });
    await rm(extDiffDir, { recursive: true, force: true });
  }
});

// --- Untracked binary content hashed as bytes, not utf8 (round-3 minor) -------------------------

test("untracked binary content that decodes to identical replacement characters hashes differently", async () => {
  // Two distinct single-byte files, each an invalid UTF-8 lead byte on its own -- Node's utf8
  // decoder turns each into a single U+FFFD replacement character, so a decode-then-hash scheme
  // collapses these to the same string despite genuinely different byte content.
  const repoA = await makeRepo();
  const repoB = await makeRepo();
  try {
    await writeFile(join(repoA, "binfile"), Buffer.from([0xff]));
    await writeFile(join(repoB, "binfile"), Buffer.from([0xfe]));
    assert.equal(
      Buffer.from([0xff]).toString("utf8"),
      Buffer.from([0xfe]).toString("utf8"),
      "test setup assumption: both bytes decode to the same replacement character",
    );
    const a = await diffFingerprint(repoA);
    const b = await diffFingerprint(repoB);
    assert.notEqual(a, b);
  } finally {
    await rm(repoA, { recursive: true, force: true });
    await rm(repoB, { recursive: true, force: true });
  }
});

// --- Laziness: diffFingerprint is not invoked when it isn't needed (round-3 minor) ---------------

test("diffStat never shells out to a bare `git diff` -- only --numstat and ls-files", async () => {
  // Sanity check on the counting shim itself: a plain diffStat call (which never fetches a bare
  // patch) should log --numstat/ls-files invocations but never a bare `diff` call.
  const repo = await makeRepo();
  const logDir = await mkdtemp(join(tmpdir(), "praxarch-gitdiff-log-"));
  const logPath = join(logDir, "invocations.log");
  await writeFile(logPath, "");
  try {
    await writeFile(join(repo, "file.txt"), "changed line\n".repeat(5));
    await withFakeGitOnPath(async () => {
      await diffStat(repo, [], null);
    }, logPath);
    const log = await (await import("node:fs/promises")).readFile(logPath, "utf8");
    const bareDiffCalls = log
      .split("\n")
      .filter((line) => line.includes("diff") && !line.includes("--numstat"));
    assert.equal(bareDiffCalls.length, 0, `expected no bare diff invocation, got: ${log}`);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(logDir, { recursive: true, force: true });
  }
});

// --- Round 6: the per-entry read loop (kind-dispatched read rule, root-relative join) -----------

async function makeUnmergedDeleteModifyRepo(): Promise<string> {
  // Constructs a real UD/DU conflict: one branch deletes file.txt, another modifies it, and
  // merging one into the other leaves a single status entry ("UD" or "DU" depending on merge
  // direction) with full working-tree content -- the file a session edits to resolve the
  // conflict. This is the exact shape the old `D`-code skip mis-handled: the status code contains
  // a `D`, but the path has real, unreviewed content on disk.
  const repo = await mkdtemp(join(tmpdir(), "praxarch-gitdiff-conflict-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  await writeFile(join(repo, "file.txt"), "base\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: repo });
  const mainBranch = execFileSync("git", ["branch", "--show-current"], { cwd: repo })
    .toString("utf8")
    .trim();

  execFileSync("git", ["checkout", "-q", "-b", "modify-branch"], { cwd: repo });
  await writeFile(join(repo, "file.txt"), "modified upstream\n");
  execFileSync("git", ["commit", "-q", "-am", "modify"], { cwd: repo });

  execFileSync("git", ["checkout", "-q", mainBranch], { cwd: repo });
  execFileSync("git", ["rm", "-q", "file.txt"], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "delete"], { cwd: repo });

  try {
    execFileSync("git", ["merge", "-q", "modify-branch"], { cwd: repo });
  } catch {
    // Expected: this is a modify/delete conflict, so `git merge` exits non-zero.
  }
  return repo;
}

test("an unmerged delete/modify conflict (UD/DU) is read as full content, not skipped as a deletion", async () => {
  const repo = await makeUnmergedDeleteModifyRepo();
  try {
    const statusOut = execFileSync("git", ["status", "--porcelain"], { cwd: repo }).toString("utf8");
    assert.match(statusOut, /D/, `expected a conflict status containing 'D', got: ${statusOut}`);

    const before = await diffFingerprint(repo);
    assert.notEqual(before, null);
    await writeFile(join(repo, "file.txt"), "resolved by the session\n");
    const after = await diffFingerprint(repo);
    assert.notEqual(before, after, "editing the conflicted file's content must move the fingerprint");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("a dirty repo fingerprinted from a nested subdirectory is non-null and matches the root-cwd fingerprint; an edit moves it", async () => {
  const repo = await makeRepo();
  try {
    const subdir = join(repo, "sub");
    await mkdir(subdir);
    await writeFile(join(repo, "file.txt"), "changed line\n".repeat(5));

    const fromRoot = await diffFingerprint(repo);
    const fromSub = await diffFingerprint(subdir);
    assert.notEqual(fromSub, null, "a subdirectory cwd must still resolve status paths correctly");
    assert.equal(fromSub, fromRoot, "the fingerprint must not depend on which directory in the repo it's run from");

    await writeFile(join(repo, "file.txt"), "changed line\n".repeat(5) + "more\n");
    const fromSubAfter = await diffFingerprint(subdir);
    assert.notEqual(fromSub, fromSubAfter, "an edit must still move the fingerprint when run from a subdirectory");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("a dangling symlink fingerprints as non-null; retargeting it (dangling->dangling, dangling->real) moves the hash", async () => {
  const repo = await makeRepo();
  try {
    const linkPath = join(repo, "link");
    await symlink("does-not-exist", linkPath);
    const before = await diffFingerprint(repo);
    assert.notEqual(before, null, "a dangling symlink must not permanently null the fingerprint");

    await rm(linkPath);
    await symlink("also-missing", linkPath);
    const afterDanglingRetarget = await diffFingerprint(repo);
    assert.notEqual(before, afterDanglingRetarget, "retargeting a dangling link to another dangling target must move the hash");

    await rm(linkPath);
    await symlink("file.txt", linkPath);
    const afterRealRetarget = await diffFingerprint(repo);
    assert.notEqual(afterDanglingRetarget, afterRealRetarget, "retargeting a dangling link to a real file must move the hash");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("a symlink retargeted between two real files with different content moves the hash (no-follow preserves round-5 retarget detection)", async () => {
  const repo = await makeRepo();
  try {
    await writeFile(join(repo, "target-a.txt"), "aaa\n");
    await writeFile(join(repo, "target-b.txt"), "bbb\n");
    const linkPath = join(repo, "link");
    await symlink("target-a.txt", linkPath);
    const before = await diffFingerprint(repo);

    await rm(linkPath);
    await symlink("target-b.txt", linkPath);
    const after = await diffFingerprint(repo);
    assert.notEqual(before, after);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("deleting a tracked file moves the fingerprint", async () => {
  const repo = await makeRepo();
  try {
    const before = await diffFingerprint(repo);
    execFileSync("git", ["rm", "-q", "file.txt"], { cwd: repo });
    const after = await diffFingerprint(repo);
    assert.notEqual(before, after);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("an untracked embedded git repo (a directory-shaped status entry) fingerprints stably across inner-content edits", async () => {
  const repo = await makeRepo();
  const embedded = join(repo, "embedded");
  try {
    await mkdir(embedded);
    execFileSync("git", ["init", "-q"], { cwd: embedded });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: embedded });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: embedded });
    await writeFile(join(embedded, "inner.txt"), "v1\n");
    execFileSync("git", ["add", "."], { cwd: embedded });
    execFileSync("git", ["commit", "-q", "-m", "inner"], { cwd: embedded });

    const statusOut = execFileSync("git", ["status", "--porcelain"], { cwd: repo }).toString("utf8");
    assert.match(statusOut, /embedded/, `expected the embedded repo to appear as a single status entry, got: ${statusOut}`);

    const before = await diffFingerprint(repo);
    assert.notEqual(before, null);

    await writeFile(join(embedded, "inner.txt"), "v2\n");
    execFileSync("git", ["add", "."], { cwd: embedded });
    execFileSync("git", ["commit", "-q", "-m", "inner edit"], { cwd: embedded });

    const after = await diffFingerprint(repo);
    assert.equal(
      after,
      before,
      "documented blindness: inner commits inside an embedded repo are invisible to the outer fingerprint, same as git status itself",
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("the same tree state produces an identical fingerprint across two calls from two different cwds", async () => {
  const repo = await makeRepo();
  try {
    const subdir = join(repo, "sub");
    await mkdir(subdir);
    await writeFile(join(repo, "file.txt"), "changed line\n".repeat(3));

    const fromRoot = await diffFingerprint(repo);
    const fromSub = await diffFingerprint(subdir);
    assert.equal(fromRoot, fromSub);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// --- Round 7: total lstat dispatch, prefix-free encoding --------------------------------------

test(
  "a tracked file replaced by a FIFO fingerprints promptly with a real hash; the FIFO appearing and disappearing moves the hash",
  { skip: hasMkfifo ? false : mkfifoSkipReason },
  async () => {
    // Round 6's dispatch tested isSymbolicLink() then isDirectory() then fell straight through to
    // createReadStream with no isFile() check. A FIFO (a tracked file replaced via `mkfifo`,
    // reported as " M victim.txt") blocks createReadStream forever with no writer. Running this
    // in-process, a regression here would wedge the whole test runner rather than fail it: the
    // block happens inside libuv's threadpool, where node:test can neither abort it nor finish
    // reporting, so no per-test timeout option can fire against it. The scenario runs in a
    // spawned child instead (see fixtures/fifo-fingerprint-runner.ts) so the parent can bound it
    // with a real deadline and SIGKILL.
    const { code, stdout, stderr } = await runWithDeadline(
      fifoRunnerPath,
      15_000,
      "fingerprint hung on a FIFO: the isFile() dispatch gate has likely regressed",
    );
    assert.equal(code, 0, `runner exited non-zero (code ${code}); stderr: ${stderr}`);

    const lastLine = stdout.trim().split("\n").pop() ?? "";
    let result: FifoRunnerResult;
    try {
      result = JSON.parse(lastLine) as FifoRunnerResult;
    } catch {
      assert.fail(`runner did not print parseable JSON; stdout: ${stdout || "<empty>"}, stderr: ${stderr}`);
    }

    assert.notEqual(result.before, null);
    assert.notEqual(result.withFifo, null, "a FIFO in the tree must not hang or permanently null the fingerprint");
    assert.notEqual(result.before, result.withFifo, "replacing the tracked file with a FIFO must move the hash");
    assert.notEqual(
      result.withFifo,
      result.afterRestoring,
      "removing the FIFO and restoring a regular file must move the hash again",
    );
  },
);

test("an ENOENT status entry's encoded bytes carry a distinguishing ABSENT marker (prefix-free encoding, known-answer check)", async () => {
  // Pre-fix, the ENOENT branch contributed nothing beyond the already-hashed path+status-code --
  // so a symlink entry "P\0C\0SYMLINK\0T\0" has the same byte image as two back-to-back ENOENT
  // entries whose fields happen to line up with "SYMLINK" and a 2-char target. Every branch,
  // including ENOENT, must now emit its own non-numeric marker so entry boundaries are always
  // recoverable from the byte stream. Reconstructs the exact expected hash by replicating the
  // documented encoding (head + path + code + marker) rather than merely asserting "differs,"
  // since the marker's specific presence -- not just any output change -- is the contract.
  const repo = await makeRepo();
  try {
    execFileSync("git", ["rm", "-q", "file.txt"], { cwd: repo });
    // Trailing-newline strip only -- porcelain's leading status-code byte is often a literal
    // space (" M", " D", ...), and .trim() would eat it along with the newline, corrupting the
    // very 2-byte code this known-answer check depends on.
    const statusOut = execFileSync("git", ["status", "--porcelain"], { cwd: repo }).toString("utf8").replace(/\n$/, "");
    const code = statusOut.slice(0, 2);
    const path = statusOut.slice(3);
    const head = execFileSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: repo }).toString("utf8").trim();

    const expected = createHash("sha256");
    expected.update(head);
    expected.update("\0");
    expected.update(path);
    expected.update("\0");
    expected.update(code);
    expected.update("\0");
    expected.update("ABSENT");
    expected.update("\0");

    const actual = await diffFingerprint(repo);
    assert.equal(
      actual,
      expected.digest("hex"),
      "an ENOENT entry must hash path + code + the ABSENT marker, not path + code alone",
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test(
  "a tracked path becoming a socket/char-device-shaped special file hashes as SPECIAL, distinct from a regular file of the same name",
  { skip: hasMkfifo ? false : mkfifoSkipReason },
  async () => {
    // Round 7 task 1's marker applies uniformly to every non-regular, non-symlink, non-directory
    // inode kind -- FIFO is the reproducible one in a test environment, but the dispatch itself
    // must be total (isFile() gates streaming, not an implicit fallthrough) rather than special-
    // cased to FIFOs alone. This is covered functionally by the FIFO test above; this test locks
    // the marker's literal name via the same known-answer approach used for ABSENT.
    //
    // This also calls diffFingerprint against a real FIFO, not just an lstat, so it's exposed to
    // the same hang as the test above if the isFile() gate regresses; it runs through the same
    // spawned-child, deadline-bound path rather than in-process for that reason.
    const { code, stdout, stderr } = await runWithDeadline(
      specialRunnerPath,
      15_000,
      "fingerprint hung on a FIFO: the isFile() dispatch gate has likely regressed",
    );
    assert.equal(code, 0, `runner exited non-zero (code ${code}); stderr: ${stderr}`);

    const lastLine = stdout.trim().split("\n").pop() ?? "";
    let result: SpecialRunnerResult;
    try {
      result = JSON.parse(lastLine) as SpecialRunnerResult;
    } catch {
      assert.fail(`runner did not print parseable JSON; stdout: ${stdout || "<empty>"}, stderr: ${stderr}`);
    }

    assert.equal(
      result.actual,
      result.expected,
      "a non-regular, non-symlink, non-directory inode must hash path + code + the SPECIAL marker",
    );
  },
);

// --- Issue #2: diffStat's null-on-failure contract ----------------------------------------------

test(
  "diffStat returns null on the original repro (a FIFO replacing a tracked file, plus a genuine large change elsewhere) -- never zeros",
  { skip: hasMkfifo ? false : mkfifoSkipReason },
  async () => {
    // The defect this issue closes: a FIFO anywhere in the tree used to make the whole --numstat
    // probe fail, and diffStat's old swallow-all catch degraded that failure to {0, 0} -- letting
    // a genuinely large, unreviewed change elsewhere in the same tree read as trivial. Run in a
    // spawned child per this file's FIFO-test convention (see diffstat-fifo-runner.ts's comment).
    const { code, stdout, stderr } = await runWithDeadline(
      diffStatFifoRunnerPath,
      15_000,
      "diffStat hung on a FIFO in the tree",
    );
    assert.equal(code, 0, `runner exited non-zero (code ${code}); stderr: ${stderr}`);

    const lastLine = stdout.trim().split("\n").pop() ?? "";
    let parsed: DiffStatFifoRunnerResult;
    try {
      parsed = JSON.parse(lastLine) as DiffStatFifoRunnerResult;
    } catch {
      assert.fail(`runner did not print parseable JSON; stdout: ${stdout || "<empty>"}, stderr: ${stderr}`);
    }

    assert.equal(
      parsed.result,
      null,
      "a FIFO-caused numstat failure must read as null (unmeasurable), never as zero counts",
    );
  },
);

test("a file larger than a few MB hashes successfully through the streaming path", async () => {
  const repo = await makeRepo();
  try {
    const bigPath = join(repo, "big.bin");
    const chunk = Buffer.alloc(1024 * 1024, 0x41);
    const fh = await open(bigPath, "w");
    try {
      for (let i = 0; i < 6; i++) {
        await fh.write(chunk);
      }
    } finally {
      await fh.close();
    }

    const result = await diffFingerprint(repo);
    assert.notEqual(result, null);
    assert.equal(typeof result, "string");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
