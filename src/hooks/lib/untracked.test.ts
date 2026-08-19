import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { getMkfifoProbe as GetMkfifoProbe } from "./fixtures/mkfifo-probe.js";
import type {
  getNonUtf8FilenameProbe as GetNonUtf8FilenameProbe,
  nonUtf8FilenameBytes as NonUtf8FilenameBytes,
} from "./fixtures/non-utf8-filename-probe.js";
import { TEST_DIST_DIR } from "../../test-support/dist-dir.js";
// Imports the compiled output, not the sibling .ts source — matches the convention in
// config.test.ts (see the comment there): tests resolve modules the way Node does at runtime.
const { listUntrackedPaths, readUntrackedEntry, repoRoot } = (await import(
  join(TEST_DIST_DIR, "hooks", "lib", "untracked.js")
)) as typeof import("./untracked.js");
// Same convention as above: this is test infra, not product code, but a bare
// "./fixtures/mkfifo-probe.ts" specifier fails tsc (TS5097) since this project emits, and the
// sibling fixtures/*-runner.ts files are already executed from dist -- this sits where the build
// already handles it. Resolved through TEST_DIST_DIR (not a hardcoded "dist" segment) so it comes
// from the scratch tree under `pnpm verify`, same as every other compiled-output import here.
const { getMkfifoProbe } = (await import(
  join(TEST_DIST_DIR, "hooks", "lib", "fixtures", "mkfifo-probe.js")
)) as { getMkfifoProbe: typeof GetMkfifoProbe };
const { getNonUtf8FilenameProbe, nonUtf8FilenameBytes } = (await import(
  join(TEST_DIST_DIR, "hooks", "lib", "fixtures", "non-utf8-filename-probe.js")
)) as { getNonUtf8FilenameProbe: typeof GetNonUtf8FilenameProbe; nonUtf8FilenameBytes: typeof NonUtf8FilenameBytes };

// See git-diff.test.ts's matching comment for the full rationale -- `which mkfifo` only proves the
// binary is on PATH, not that mkfifo(2) actually works in this sandbox.
const mkfifoProbeResult = await getMkfifoProbe();
const hasMkfifo = mkfifoProbeResult.ok;
const mkfifoSkipReason = mkfifoProbeResult.reason ?? "mkfifo not available on this platform";

// APFS (macOS) rejects a filename containing invalid-UTF-8 bytes outright (EILSEQ); ext4/xfs
// (Linux, including GitLab CI) permit it. This is the exact asymmetry that let the Node-decode
// bypass ship invisibly from local development -- see the non-UTF-8 filename tests below.
const nonUtf8ProbeResult = await getNonUtf8FilenameProbe();
const hasNonUtf8Filenames = nonUtf8ProbeResult.ok;
const nonUtf8SkipReason = nonUtf8ProbeResult.reason ?? "non-UTF-8 filenames not supported on this filesystem";
const untrackedFifoRunnerPath = join(TEST_DIST_DIR, "hooks", "lib", "fixtures", "untracked-fifo-runner.js");

interface UntrackedFifoRunnerResult {
  entry: { key: string; lines: number; readable: boolean };
}

// Reusable deadline-bound child-process runner -- see git-diff.test.ts's matching helper for the
// full rationale (a regression that made the FIFO branch fall through to createReadStream would
// hang in libuv's threadpool, unreachable by node:test's own per-test timeout).
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
  const repo = await mkdtemp(join(tmpdir(), "praxarch-untracked-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  await writeFile(join(repo, "tracked.txt"), "line\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });
  return repo;
}

// UTF-8 encodes a display path into the raw bytes readUntrackedEntry expects -- every path
// constructed directly in a test (as opposed to obtained from listUntrackedPaths itself) goes
// through this rather than a bare string, since readUntrackedEntry's second argument is the exact
// on-disk bytes, not a string.
function rawOf(path: string): Buffer {
  return Buffer.from(path, "utf8");
}

// `readUntrackedEntry`'s `root` parameter is a Buffer (the exact bytes `repoRoot` would print),
// not a string -- see untracked.ts's doc comment on that function for why. Tests that construct a
// repo path directly (rather than obtaining it from `repoRoot` itself) go through this rather than
// a bare string for the same reason `rawOf` exists for `raw`.
function rootOf(path: string): Buffer {
  return Buffer.from(path, "utf8");
}

// Mode-000 fixtures below reproduce EACCES-shaped failures that root simply doesn't experience --
// DAC_OVERRIDE lets root traverse a mode-000 directory and open a mode-000 file as if the mode
// bits weren't set at all, so these tests must skip (not fail for an unrelated reason) when the
// test runner itself is root, which is the default user in the node:22 CI image this project's
// pipeline runs under.
function isRoot(): boolean {
  return typeof process.getuid === "function" && process.getuid() === 0;
}
const rootSkipReason = "mode-000 permission checks are bypassed when running as root (DAC_OVERRIDE)";

test("listUntrackedPaths from a subdirectory still returns the root-relative path of a file in a sibling directory", async () => {
  // The fail-open finding 1 from the plan: without --full-name and the :/ pathspec, `git ls-files
  // --others --exclude-standard` run from a subdirectory lists only that subtree, cwd-relative.
  // This must return the whole-repo, root-relative listing regardless of which directory the
  // caller happens to be in.
  const repo = await makeRepo();
  try {
    await writeFile(join(repo, "root-untracked.txt"), "hello\n");
    const sub = join(repo, "sub");
    await mkdir(sub);

    const paths = await listUntrackedPaths(sub);
    assert.notEqual(paths, null);
    assert.ok(
      (paths ?? []).some((p) => p.path === "root-untracked.txt"),
      `expected root-relative "root-untracked.txt" in listing from a subdirectory, got: ${JSON.stringify(paths)}`,
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("listUntrackedPaths returns null (never an empty list) when cwd is not inside a git repo at all", async () => {
  const dir = await mkdtemp(join(tmpdir(), "praxarch-untracked-nogit-"));
  try {
    const paths = await listUntrackedPaths(dir);
    assert.equal(paths, null, "a listing failure must read as unknown, never as a swallowed empty list");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("repoRoot resolves the toplevel for a real repo and is null outside one", async () => {
  const repo = await makeRepo();
  const nonRepo = await mkdtemp(join(tmpdir(), "praxarch-untracked-nonrepo-"));
  try {
    const root = await repoRoot(repo);
    assert.notEqual(root, null);
    assert.equal(await repoRoot(nonRepo), null);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(nonRepo, { recursive: true, force: true });
  }
});

test("repoRoot preserves a trailing space in the repo's own directory name (not stripped like .trim() would)", async () => {
  // `.trim()` strips every kind of trailing whitespace, not just git's single terminating
  // newline -- a repo whose own directory name ends in a space comes back truncated to a path
  // that doesn't exist. readUntrackedEntry then builds every Buffer path against that wrong root,
  // lstat ENOENTs on all of them, and every untracked entry reads as the fixed self-matching
  // `{key: "a:", readable: true}` -- the exact defect this module exists to close, reached
  // through the root instead of a leaf.
  const parent = await mkdtemp(join(tmpdir(), "praxarch-untracked-trim-"));
  const repo = join(parent, "dirspace ");
  try {
    await mkdir(repo);
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
    await writeFile(join(repo, "file.txt"), "line\n".repeat(400));

    const root = await repoRoot(repo);
    assert.notEqual(root, null);
    assert.ok(Buffer.isBuffer(root), "repoRoot must return a Buffer, not a UTF-8-decoded string");
    assert.ok(
      root && root.toString("utf8").endsWith("dirspace "),
      `expected repoRoot to preserve the trailing space in the directory name, got: ${JSON.stringify(root)}`,
    );

    const paths = await listUntrackedPaths(repo);
    assert.notEqual(paths, null);
    const found = (paths ?? []).find((p) => p.path === "file.txt");
    assert.ok(found, `expected "file.txt" in the listing, got: ${JSON.stringify(paths)}`);

    const entry = await readUntrackedEntry(root as Buffer, found.raw);
    assert.equal(entry.readable, true);
    assert.equal(entry.lines, 400, "a repo root ending in whitespace must not be truncated to a nonexistent path");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("repoRoot preserves a trailing carriage return in the repo's own directory name (not stripped by a \\r? in the newline-strip step)", async () => {
  // MAJOR 1 from the round-3 adversarial pass: git terminates `rev-parse --show-toplevel`'s output
  // with a single LF, never CRLF, through a pipe on any platform -- a `\r?` in the strip pattern
  // protects nothing and instead eats a legal trailing CR that is part of the repo root directory's
  // own name. readUntrackedEntry then builds every path against the truncated root, lstat ENOENTs
  // on all of them, and every untracked entry reads as the fixed self-matching `{key: "a:",
  // readable: true}` -- reproduced end-to-end with a 400-line file measuring as 0 lines forever,
  // on both macOS and Linux.
  const parent = await mkdtemp(join(tmpdir(), "praxarch-untracked-cr-"));
  const repo = join(parent, "dircr\r");
  try {
    await mkdir(repo);
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
    await writeFile(join(repo, "file.txt"), "line\n".repeat(400));

    const root = await repoRoot(repo);
    assert.notEqual(root, null);
    assert.ok(
      root && root.toString("utf8").endsWith("dircr\r"),
      `expected repoRoot to preserve the trailing CR in the directory name, got: ${JSON.stringify(root)}`,
    );

    const paths = await listUntrackedPaths(repo);
    assert.notEqual(paths, null);
    const found = (paths ?? []).find((p) => p.path === "file.txt");
    assert.ok(found, `expected "file.txt" in the listing, got: ${JSON.stringify(paths)}`);

    const entry = await readUntrackedEntry(root as Buffer, found.raw);
    assert.equal(entry.readable, true);
    assert.equal(
      entry.lines,
      400,
      "a repo root ending in a legal trailing CR must not be truncated to a nonexistent path by an overbroad \\r? strip",
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test(
  "repoRoot returns the exact raw bytes for a non-UTF-8 repo root reached through an ASCII symlink, and readUntrackedEntry reads through it correctly (round-3 residual defect on the root half)",
  { skip: hasNonUtf8Filenames ? false : nonUtf8SkipReason },
  async () => {
    // MAJOR 2: `repoRoot` used to call execFile without `encoding: "buffer"`, so a non-UTF-8 repo
    // root got UTF-8-decoded (U+FFFD corruption) before readUntrackedEntry ever built a path from
    // it -- the round-3 defect, left unfixed on the root half while listUntrackedPaths's leaf half
    // was already closed. Reachable without any unusual filesystem access: a hook's cwd arrives via
    // an ASCII-named symlink, but `getcwd()` inside the spawned git process resolves to the
    // *physical* directory -- git's own `rev-parse --show-toplevel` output is the real, possibly
    // non-UTF-8, on-disk name, never the symlink's ASCII name.
    const parent = await mkdtemp(join(tmpdir(), "praxarch-untracked-rootbytes-"));
    const nameBytes = nonUtf8FilenameBytes();
    const repoPath = Buffer.concat([Buffer.from(`${parent}/repo-`), nameBytes]);
    const linkPath = join(parent, "asciilink");
    try {
      await mkdir(repoPath);
      await symlink(repoPath, linkPath);
      // Every git invocation below goes through the ASCII symlink -- a valid UTF-8 string -- never
      // through repoPath directly, matching the hook's real cwd shape.
      execFileSync("git", ["init", "-q"], { cwd: linkPath });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: linkPath });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: linkPath });
      await writeFile(Buffer.concat([repoPath, Buffer.from("/file.txt")]), "line\n".repeat(400));

      const root = await repoRoot(linkPath);
      assert.notEqual(root, null);
      assert.ok(Buffer.isBuffer(root), "repoRoot must return a Buffer, not a UTF-8-decoded string");
      assert.ok(
        (root as Buffer).includes(nameBytes),
        `expected the raw non-UTF-8 bytes in repoRoot's result (not the ASCII symlink path), got: ${JSON.stringify(root)}`,
      );

      const paths = await listUntrackedPaths(linkPath);
      assert.notEqual(paths, null);
      const found = (paths ?? []).find((p) => p.path === "file.txt");
      assert.ok(found, `expected "file.txt" in the listing, got: ${JSON.stringify(paths)}`);

      const entry = await readUntrackedEntry(root as Buffer, found.raw);
      assert.equal(entry.readable, true, "a non-UTF-8 repo root must not corrupt every read into ENOENT");
      assert.equal(
        entry.lines,
        400,
        "the real line count must be measured through the raw-byte root, not truncated to 0 via a UTF-8-decode/re-encode round trip",
      );
    } finally {
      await rm(linkPath, { force: true });
      await rm(repoPath, { recursive: true, force: true });
      await rm(parent, { recursive: true, force: true });
    }
  },
);

test("readUntrackedEntry on a symlink to an out-of-repo file never follows it: key starts with l:, lines is 0", async () => {
  // The security-relevant case: an untracked symlink pointing outside the repo must never have
  // its target's content read into the count. A 50-line file outside the repo, followed, would
  // have produced lines === 50 under the old readFile-based implementation.
  const repo = await makeRepo();
  const outside = await mkdtemp(join(tmpdir(), "praxarch-untracked-outside-"));
  try {
    const outsideFile = join(outside, "secret.txt");
    await writeFile(outsideFile, "line\n".repeat(50));

    const linkRelPath = "link-to-outside";
    await symlink(outsideFile, join(repo, linkRelPath));

    const entry = await readUntrackedEntry(rootOf(repo), rawOf(linkRelPath));
    assert.ok(entry.key.startsWith("l:"), `expected an "l:" key for a symlink, got: ${entry.key}`);
    assert.equal(entry.lines, 0, "a symlink must never contribute the followed target's line count");
    assert.equal(entry.readable, true);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("readUntrackedEntry on a dangling symlink yields an l: key and readable: true", async () => {
  const repo = await makeRepo();
  try {
    const linkRelPath = "dangling-link";
    await symlink("does-not-exist", join(repo, linkRelPath));

    const entry = await readUntrackedEntry(rootOf(repo), rawOf(linkRelPath));
    assert.ok(entry.key.startsWith("l:"), `expected an "l:" key for a dangling symlink, got: ${entry.key}`);
    assert.equal(entry.readable, true, "a dangling target is not a read failure");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("two symlinks with distinct invalid-UTF-8 targets get distinct keys (no target-decode collision)", async () => {
  // The readlink half of the same defect family: a decoded (lossy) target string collapses two
  // different invalid-UTF-8 byte sequences to the identical U+FFFD-laden string, so two
  // genuinely different retargets would compare equal. readUntrackedEntry hashes the raw target
  // bytes instead of embedding a decoded string, which has no "unrepresentable" case at all.
  // Symlink targets aren't validated as real filesystem paths at creation time (unlike a real
  // filename), so this doesn't need the non-UTF-8-filesystem probe -- it reproduces on macOS too.
  const repo = await makeRepo();
  try {
    const targetA = Buffer.from([0x2f, 0x74, 0x6d, 0x70, 0x2f, 0x63, 0x61, 0x66, 0xe9]); // "/tmp/caf" + 0xE9
    const targetB = Buffer.from([0x2f, 0x74, 0x6d, 0x70, 0x2f, 0x63, 0x61, 0x66, 0xea]); // "/tmp/caf" + 0xEA
    assert.equal(
      targetA.toString("utf8"),
      targetB.toString("utf8"),
      "test setup assumption: both targets decode to the same lossy string (both single invalid trailing bytes)",
    );

    await symlink(targetA, join(repo, "link-a"));
    await symlink(targetB, join(repo, "link-b"));

    const entryA = await readUntrackedEntry(rootOf(repo), rawOf("link-a"));
    const entryB = await readUntrackedEntry(rootOf(repo), rawOf("link-b"));
    assert.ok(entryA.key.startsWith("l:"));
    assert.ok(entryB.key.startsWith("l:"));
    assert.notEqual(entryA.key, entryB.key, "two symlinks with different raw targets must never produce the same key");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("an embedded git repo is listed with a trailing slash and reads as key d:, lines 0", async () => {
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

    const paths = await listUntrackedPaths(repo);
    assert.notEqual(paths, null);
    const embeddedEntry = (paths ?? []).find((p) => p.path?.startsWith("embedded"));
    assert.ok(embeddedEntry, `expected an "embedded"-prefixed entry, got: ${JSON.stringify(paths)}`);
    assert.ok(
      embeddedEntry.path?.endsWith("/"),
      `expected the embedded repo's listed path to end with "/", got: ${embeddedEntry.path}`,
    );

    const entry = await readUntrackedEntry(rootOf(repo), embeddedEntry.raw);
    assert.equal(entry.key, "d:");
    assert.equal(entry.lines, 0);
    assert.equal(entry.readable, true);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("a regular file's key changes when its content changes and is stable when it does not", async () => {
  const repo = await makeRepo();
  try {
    await writeFile(join(repo, "new.txt"), "v1\n");
    const a = await readUntrackedEntry(rootOf(repo), rawOf("new.txt"));
    const b = await readUntrackedEntry(rootOf(repo), rawOf("new.txt"));
    assert.equal(a.key, b.key, "the key must be stable across two reads of unchanged content");
    assert.ok(a.key.startsWith("f:"));

    await writeFile(join(repo, "new.txt"), "v2\n");
    const c = await readUntrackedEntry(rootOf(repo), rawOf("new.txt"));
    assert.notEqual(a.key, c.key, "the key must change when the file's content changes");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("a file whose content is 'a\\nb\\n' reports lines === 2", async () => {
  const repo = await makeRepo();
  try {
    await writeFile(join(repo, "twolines.txt"), "a\nb\n");
    const entry = await readUntrackedEntry(rootOf(repo), rawOf("twolines.txt"));
    assert.equal(entry.lines, 2);
    assert.equal(entry.readable, true);
    assert.ok(entry.key.startsWith("f:"));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("readUntrackedEntry on a path that has vanished since listing (ENOENT) yields an a: key and still counts as readable", async () => {
  const repo = await makeRepo();
  try {
    const entry = await readUntrackedEntry(rootOf(repo), rawOf("never-existed.txt"));
    assert.equal(entry.key, "a:");
    assert.equal(entry.lines, 0);
    assert.equal(entry.readable, true, "a vanished path is a race, not an unreadable path");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// --- -z / quoting: non-ASCII and whitespace-only paths must round-trip exactly ------------------

test("listUntrackedPaths returns a non-ASCII filename unquoted, and readUntrackedEntry reads it correctly (core.quotePath fail-case)", async () => {
  // Without -z, core.quotePath's default of true makes git print a file named "naïve.md" as the
  // *string* `"na\303\257ve.md"` -- a path that does not exist on disk. lstat on that string then
  // ENOENTs, landing on the { key: "a:", readable: true } branch, which is a fixed key that
  // matches itself on every future measurement: the real file would silently stop counting after
  // its first appearance. This is the exact defect verified end-to-end (500-line file measured as
  // 0/0) before the -z fix.
  const repo = await makeRepo();
  try {
    const fileName = "naïve.md";
    await writeFile(join(repo, fileName), "line\n".repeat(500));

    const paths = await listUntrackedPaths(repo);
    assert.notEqual(paths, null);
    const found = (paths ?? []).find((p) => p.path === fileName);
    assert.ok(
      found,
      `expected the exact on-disk name "${fileName}" in the listing (not a C-quoted string), got: ${JSON.stringify(paths)}`,
    );

    const entry = await readUntrackedEntry(rootOf(repo), found.raw);
    assert.equal(entry.readable, true);
    assert.ok(entry.key.startsWith("f:"), `expected a real "f:" content key, got: ${entry.key}`);
    assert.equal(entry.lines, 500, "the file's real line count must be measured, not silently dropped to 0");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("listUntrackedPaths includes a whitespace-only filename (not discarded by the emptiness filter)", async () => {
  // A path that is entirely whitespace is a real, on-disk untracked entry that git lists. Filtering
  // on `.trim().length > 0` instead of raw `.length > 0` would silently discard it, the same
  // direction of defect as the quoting bug above, caught by the same fix (a raw-length filter on
  // NUL-split entries).
  const repo = await makeRepo();
  try {
    execFileSync("touch", [" "], { cwd: repo });

    const paths = await listUntrackedPaths(repo);
    assert.notEqual(paths, null);
    assert.ok(
      (paths ?? []).some((p) => p.path === " "),
      `expected the whitespace-only filename " " in the listing, got: ${JSON.stringify(paths)}`,
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test(
  "readUntrackedEntry on a FIFO reads as key s:, lines 0, readable: true -- never opening it",
  { skip: hasMkfifo ? false : mkfifoSkipReason },
  async () => {
    // Coverage for the !st.isFile() branch, which the whole "a FIFO can never reach
    // createReadStream" argument rests on and which nothing else in this file exercises. Run in a
    // spawned, deadline-bound child per this file's FIFO-test convention (see the runWithDeadline
    // helper above): the branch never opens the FIFO today, but a regression that made it fall
    // through to the streaming path would hang in libuv's threadpool where node:test's own
    // per-test timeout cannot reach it.
    const { code, stdout, stderr } = await runWithDeadline(
      untrackedFifoRunnerPath,
      15_000,
      "readUntrackedEntry hung on a FIFO: the !st.isFile() dispatch gate has likely regressed",
    );
    assert.equal(code, 0, `runner exited non-zero (code ${code}); stderr: ${stderr}`);

    const lastLine = stdout.trim().split("\n").pop() ?? "";
    let result: UntrackedFifoRunnerResult;
    try {
      result = JSON.parse(lastLine) as UntrackedFifoRunnerResult;
    } catch {
      assert.fail(`runner did not print parseable JSON; stdout: ${stdout || "<empty>"}, stderr: ${stderr}`);
    }

    assert.equal(result.entry.key, "s:");
    assert.equal(result.entry.lines, 0);
    assert.equal(result.entry.readable, true);
  },
);

// --- Node's own execFile utf8-decode bypass (a second half of the -z quoting fix) ---------------

test(
  "a filename with invalid-UTF-8 bytes gets path: null and is still read for real content via raw bytes",
  { skip: hasNonUtf8Filenames ? false : nonUtf8SkipReason },
  async () => {
    // Round 3's finding: -z stops GIT from quoting, but execFile's default utf8 decode still
    // mangles a genuinely non-UTF-8 filename into U+FFFD before this module ever sees it -- the
    // same self-matching "a:" bypass as the quoting bug, reached through Node's decoder instead of
    // git's. Fixed structurally: `path` is `null` for such an entry (never a synthesized string),
    // and `readUntrackedEntry` addresses the file with the raw bytes regardless -- so the file is
    // read correctly (a real, content-derived "f:" key and a real line count) rather than falling
    // back to a permanently-unreadable placeholder.
    const repo = await makeRepo();
    try {
      const nameBytes = nonUtf8FilenameBytes();
      const filePath = Buffer.concat([Buffer.from(`${repo}/`), nameBytes]);
      await writeFile(filePath, "line\n".repeat(250));

      const paths = await listUntrackedPaths(repo);
      assert.notEqual(paths, null);
      const list = paths ?? [];
      assert.equal(list.length, 1, `expected exactly one untracked entry, got: ${JSON.stringify(paths)}`);
      const entry0 = list[0];
      assert.ok(entry0, "expected exactly one untracked entry");
      assert.equal(entry0.path, null, "an invalid-UTF-8 filename must never be exposed as a synthesized string");

      const t0 = await readUntrackedEntry(rootOf(repo), entry0.raw);
      assert.equal(t0.readable, true, "the raw bytes address the real file, so it must read successfully");
      assert.ok(t0.key.startsWith("f:"), `expected a real "f:" content key, got: ${t0.key}`);
      assert.equal(t0.lines, 250, "the real line count must be measured, not dropped to 0");

      await appendFile(filePath, "line\n".repeat(250));

      const pathsAfter = await listUntrackedPaths(repo);
      const entry1 = (pathsAfter ?? []).find((p) => p.raw.equals(entry0.raw));
      assert.ok(entry1, "the same raw-byte entry must still be listed after the content change");
      const t1 = await readUntrackedEntry(rootOf(repo), entry1.raw);

      assert.equal(t1.lines, 500, "the updated content must be reflected, not silently frozen at the first read");
      assert.notEqual(t0.key, t1.key, "the key must move when the file's content changes, exactly like any other file");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  },
);

test(
  "an invalid-UTF-8 filename whose base64 escape would contain a default ignore pattern is never matched against ignorePatterns",
  { skip: hasNonUtf8Filenames ? false : nonUtf8SkipReason },
  async () => {
    // The MAJOR finding this round: an earlier fix encoded "unrepresentable" as an in-band marker
    // string ("\0raw:" + base64), and the base64 alphabet contains "/" -- these exact bytes
    // produced the marker "\0raw:pTydist/GJMu", which contains the default ignore pattern
    // "dist/". A caller's `ignorePatterns.some(p => path.includes(p))` would then drop the entry
    // before it was ever counted: 0 files / 0 lines for a genuinely new 500-line file, strictly
    // worse than any "always counts" fallback. There is no marker anymore -- `path` is `null` for
    // this entry, which is not a string an `Array.prototype.includes`-style check can match at
    // all, and the real bytes still flow through `raw` to a correct read.
    const repo = await makeRepo();
    const nameBytes = Buffer.from([0xa5, 0x3c, 0x9d, 0x8a, 0xcb, 0x7f, 0x18, 0x93, 0x2e]);
    try {
      // Confirms this specific byte sequence is still the one that reproduces the historical
      // defect (its base64 form contains "dist/"), so this test would fail loudly if the bytes
      // above ever stopped exercising that shape.
      assert.ok(
        nameBytes.toString("base64").includes("dist/"),
        `test setup assumption: nameBytes' base64 form must contain "dist/", got: ${nameBytes.toString("base64")}`,
      );

      const filePath = Buffer.concat([Buffer.from(`${repo}/`), nameBytes]);
      await writeFile(filePath, "line\n".repeat(200));

      const paths = await listUntrackedPaths(repo);
      assert.notEqual(paths, null);
      const list = paths ?? [];
      assert.equal(list.length, 1, `expected exactly one untracked entry, got: ${JSON.stringify(paths)}`);
      const entry = list[0];
      assert.ok(entry, "expected exactly one untracked entry");
      assert.equal(entry.path, null);

      // Simulates Task 2's ignore check exactly as specified (`ignorePatterns.some(p =>
      // path.includes(p))`) against the real default ignore patterns -- proving there is no
      // string in play that `.includes` could ever match, structurally, not just for this one
      // pattern list.
      const defaultIgnorePatterns = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", ".min.js", "dist/"];
      const wouldBeIgnored = entry.path !== null && defaultIgnorePatterns.some((p) => (entry.path as string).includes(p));
      assert.equal(wouldBeIgnored, false, "a null path must never be treated as ignored -- there is no string to check");

      const read = await readUntrackedEntry(rootOf(repo), entry.raw);
      assert.equal(read.readable, true);
      assert.equal(read.lines, 200, "the file must still be read for its real content, not silently dropped");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  },
);

// --- readable: false coverage -- MAJOR 3 from the round-3 adversarial pass ----------------------
//
// Nothing before this section ever asserted `readable === false` or the "u:" key. Per
// `UntrackedEntry.readable`'s own doc comment, an entry with `readable: false` reaching a
// SessionStart snapshot is "the exact fail-open the snapshot's whole design exists to avoid" --
// two of the three producers of that branch are exercised below (real, mode-000-based
// reproductions, skip-guarded on root rather than faked). The third (`readlink` failing
// independently of the `lstat` immediately above it in the same function) has no known
// deterministic external reproduction -- see the comment on that catch block in untracked.ts for
// the reachability argument; it is not tested here rather than faked.

test(
  "readUntrackedEntry on a path inside a directory with no search permission reads as key u:, readable: false (non-ENOENT lstat failure)",
  { skip: isRoot() ? rootSkipReason : false },
  async () => {
    const repo = await makeRepo();
    const blockedDir = join(repo, "blocked");
    try {
      await mkdir(blockedDir);
      await writeFile(join(blockedDir, "secret.txt"), "line\n".repeat(5));
      await chmod(blockedDir, 0o000);

      const entry = await readUntrackedEntry(rootOf(repo), rawOf("blocked/secret.txt"));
      assert.equal(entry.key, "u:", 'a non-ENOENT lstat failure must key as "u:", never the self-matching "a:"');
      assert.equal(
        entry.lines,
        0,
        "an unreadable entry must never carry a real line count",
      );
      assert.equal(
        entry.readable,
        false,
        "a permissions failure must never read as readable -- that is the exact fail-open this branch exists to avoid",
      );
    } finally {
      await chmod(blockedDir, 0o755).catch(() => undefined);
      await rm(repo, { recursive: true, force: true });
    }
  },
);

test(
  "readUntrackedEntry on a regular file with no read permission reads as key u:, readable: false (mid-stream read error)",
  { skip: isRoot() ? rootSkipReason : false },
  async () => {
    const repo = await makeRepo();
    const blockedFile = join(repo, "blocked.txt");
    try {
      await writeFile(blockedFile, "line\n".repeat(5));
      await chmod(blockedFile, 0o000);

      const entry = await readUntrackedEntry(rootOf(repo), rawOf("blocked.txt"));
      assert.equal(entry.key, "u:", 'a mid-stream read error must key as "u:"');
      assert.equal(entry.lines, 0, "an unreadable entry must never carry a real line count");
      assert.equal(
        entry.readable,
        false,
        "a permissions failure discovered while streaming must never read as readable -- lstat succeeding first (the file genuinely is a regular file) must not be conflated with the content actually being readable",
      );
    } finally {
      await chmod(blockedFile, 0o644).catch(() => undefined);
      await rm(repo, { recursive: true, force: true });
    }
  },
);
