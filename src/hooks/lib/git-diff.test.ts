import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// Imports the compiled output, not the sibling .ts source — matches the convention in
// config.test.ts (see the comment there): tests resolve modules the way Node does at runtime.
const here = dirname(fileURLToPath(import.meta.url));
const { diffStat, diffFingerprint } = (await import(
  join(here, "..", "..", "..", "dist", "hooks", "lib", "git-diff.js")
)) as typeof import("./git-diff.js");

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

// A fake `git` on PATH that behaves like the real one for --numstat and ls-files, but always
// fails the bare patch fetch (`git diff <target>` with no --numstat) — simulating a real,
// black-box failure of exactly the call that can hit maxBuffer on a huge diff, without actually
// generating tens of megabytes of test fixture. Also counts every invocation line to a log file,
// so tests can assert a bare diff was (or wasn't) invoked at all.
//
// `failOn: "numstat"` instead fails the --numstat probe itself (everything else, including
// rev-parse and the bare diff, passes through to the real git) — simulating a probe failure that
// isn't the genuine "no commits / not a repo" case, since the repo is real and HEAD resolves
// fine.
async function makeFakeGitDir(logPath?: string, failOn: "diff" | "numstat" = "diff"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "praxarch-gitdiff-fakegit-"));
  // Resolve the real git's absolute path up front — the script below must never call "git" by
  // bare name, since by the time it runs, PATH has this fake directory prepended and a bare
  // call would just recurse into itself.
  const realGit = execFileSync("which", ["git"]).toString("utf8").trim();
  const logLine = logPath ? `echo "$*" >> "${logPath}"\n` : "";
  const caseBody =
    failOn === "numstat"
      ? [
          'case "$*" in',
          `  *--numstat*) echo "fake git: numstat probe failed" >&2; exit 1 ;;`,
          `  *) exec "${realGit}" "$@" ;;`,
          "esac",
        ]
      : [
          'case "$*" in',
          `  *--numstat*) exec "${realGit}" "$@" ;;`,
          `  *ls-files*) exec "${realGit}" "$@" ;;`,
          '  *diff*) echo "fake git: patch fetch failed" >&2; exit 1 ;;',
          `  *) exec "${realGit}" "$@" ;;`,
          "esac",
        ];
  const script = ["#!/bin/sh", logLine.trimEnd(), ...caseBody].filter((line) => line.length > 0).join("\n");
  await writeFile(join(dir, "git"), `${script}\n`, "utf8");
  await chmod(join(dir, "git"), 0o755);
  return dir;
}

async function withFakeGitOnPath<T>(
  fn: () => Promise<T>,
  logPath?: string,
  failOn: "diff" | "numstat" = "diff",
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
    const a = await diffStat(repo, [], null);
    const b = await diffStat(repo, [], null);
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
    const after = await diffStat(repo, [], null);
    assert.equal(after.changedFiles, 1);
    assert.ok(after.changedLines > 0);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("diffStat returns zeros, without throwing, when there is no usable git diff", async () => {
  const repo = await mkdtemp(join(tmpdir(), "praxarch-gitdiff-nogit-"));
  try {
    const result = await diffStat(repo, [], null);
    assert.equal(result.changedLines, 0);
    assert.equal(result.changedFiles, 0);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("diffFingerprint returns a stable hash for an unchanged tree", async () => {
  const repo = await makeRepo();
  try {
    const a = await diffFingerprint(repo, null);
    const b = await diffFingerprint(repo, null);
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
    const before = await diffFingerprint(repo, null);
    await writeFile(join(repo, "file.txt"), "changed line\n".repeat(5));
    const after = await diffFingerprint(repo, null);
    assert.notEqual(before, after);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("diffFingerprint hash changes when an untracked file's contents change", async () => {
  const repo = await makeRepo();
  try {
    await writeFile(join(repo, "new.txt"), "v1\n");
    const before = await diffFingerprint(repo, null);
    await writeFile(join(repo, "new.txt"), "v2\n");
    const after = await diffFingerprint(repo, null);
    assert.notEqual(before, after);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("diffFingerprint's no-git/no-commits hash is a real (non-null) deterministic value, distinct from a failed fingerprint", async () => {
  const repo = await mkdtemp(join(tmpdir(), "praxarch-gitdiff-nogit2-"));
  try {
    const result = await diffFingerprint(repo, null);
    assert.notEqual(result, null);
    assert.equal(typeof result, "string");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("diffFingerprint returns null (not a fake-fresh hash) when the patch fetch fails", async () => {
  const repo = await makeRepo();
  try {
    await writeFile(join(repo, "file.txt"), "changed line\n".repeat(50));
    await withFakeGitOnPath(async () => {
      const result = await diffFingerprint(repo, null);
      assert.equal(result, null);
    });
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("diffFingerprint returns null when the numstat probe itself fails, not the deterministic empty hash", async () => {
  // The probe failure happens in a real repo with commits (HEAD resolves fine) -- this is the
  // "something else went wrong" case, distinct from genuinely having nothing to diff, and must
  // yield null rather than silently certifying whatever verdict was recorded as still current.
  const repo = await makeRepo();
  try {
    await withFakeGitOnPath(
      async () => {
        const result = await diffFingerprint(repo, null);
        assert.equal(result, null);
      },
      undefined,
      "numstat",
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("diffFingerprint still returns the deterministic empty hash for a genuine no-commits repo even with a failing numstat probe", async () => {
  // Same failing-numstat fake git as above, but here HEAD genuinely doesn't resolve (no commits
  // at all) -- the two cases must stay distinguishable: this one is real "nothing to diff", not
  // an unknown fingerprint.
  const repo = await mkdtemp(join(tmpdir(), "praxarch-gitdiff-nogit3-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  try {
    await withFakeGitOnPath(
      async () => {
        const result = await diffFingerprint(repo, null);
        assert.notEqual(result, null);
        assert.equal(typeof result, "string");
      },
      undefined,
      "numstat",
    );
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
    const a = await diffFingerprint(repoA, null);
    const b = await diffFingerprint(repoB, null);
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
    const before = await diffFingerprint(repo, null);
    await writeFile(join(repo, "file.txt"), "changed line\n".repeat(5));
    const after = await diffFingerprint(repo, null);
    // Without --no-ext-diff, git substitutes the no-op driver's (empty) output for the real
    // patch text on the bare `git diff` fetch, so the hash would stay constant across a real
    // content change -- the round-1 critical (600 unverified lines allowed past a CONFIRMED
    // verdict) reproduces in full via exactly this path.
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
    const a = await diffFingerprint(repoA, null);
    const b = await diffFingerprint(repoB, null);
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
