import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { getMkfifoProbe as GetMkfifoProbe } from "./fixtures/mkfifo-probe.js";
import type {
  getNonUtf8FilenameProbe as GetNonUtf8FilenameProbe,
  nonUtf8FilenameBytes as NonUtf8FilenameBytes,
} from "./fixtures/non-utf8-filename-probe.js";
// Imports the compiled output, not the sibling .ts source — same convention as git-diff.test.ts
// (see the comment there): tests resolve modules the way Node does at runtime. Written against the
// current `main` dist-path convention deliberately, per the plan's note on the in-flight
// fix/verify-without-installing branch: that branch rewrites every test file's preamble to a
// shared TEST_DIST_DIR helper that does not exist on `main` yet, so pre-adopting it here would not
// compile. Rebasing after it lands is a two-line mechanical edit, not a merge conflict.
const here = dirname(fileURLToPath(import.meta.url));
const { listUntrackedPaths, readUntrackedEntry, repoRoot } = (await import(
  join(here, "..", "..", "..", "dist", "hooks", "lib", "untracked.js")
)) as typeof import("./untracked.js");
// Same dist-path convention as above (this is test infra, not product code, and a bare
// "./fixtures/mkfifo-probe.ts" specifier fails tsc (TS5097) since this project emits).
const { getMkfifoProbe } = (await import(
  join(here, "..", "..", "..", "dist", "hooks", "lib", "fixtures", "mkfifo-probe.js")
)) as { getMkfifoProbe: typeof GetMkfifoProbe };
const { getNonUtf8FilenameProbe, nonUtf8FilenameBytes } = (await import(
  join(here, "..", "..", "..", "dist", "hooks", "lib", "fixtures", "non-utf8-filename-probe.js")
)) as { getNonUtf8FilenameProbe: typeof GetNonUtf8FilenameProbe; nonUtf8FilenameBytes: typeof NonUtf8FilenameBytes };

// See git-diff.test.ts's matching comment for the full rationale -- `which mkfifo` only proves the
// binary is on PATH, not that mkfifo(2) actually works in this sandbox.
const mkfifoProbeResult = await getMkfifoProbe();
const hasMkfifo = mkfifoProbeResult.ok;
const mkfifoSkipReason = mkfifoProbeResult.reason ?? "mkfifo not available on this platform";

// APFS (macOS) rejects a filename containing invalid-UTF-8 bytes outright (EILSEQ); ext4/xfs
// (Linux, including GitLab CI) permit it. This is the exact asymmetry that let the Node-decode
// bypass ship invisibly from local development -- see the non-UTF-8 filename test below.
const nonUtf8ProbeResult = await getNonUtf8FilenameProbe();
const hasNonUtf8Filenames = nonUtf8ProbeResult.ok;
const nonUtf8SkipReason = nonUtf8ProbeResult.reason ?? "non-UTF-8 filenames not supported on this filesystem";
const untrackedFifoRunnerPath = join(
  here,
  "..",
  "..",
  "..",
  "dist",
  "hooks",
  "lib",
  "fixtures",
  "untracked-fifo-runner.js",
);

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
      (paths ?? []).includes("root-untracked.txt"),
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

    const entry = await readUntrackedEntry(repo, linkRelPath);
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

    const entry = await readUntrackedEntry(repo, linkRelPath);
    assert.ok(entry.key.startsWith("l:"), `expected an "l:" key for a dangling symlink, got: ${entry.key}`);
    assert.equal(entry.readable, true, "a dangling target is not a read failure");
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
    const embeddedPath = (paths ?? []).find((p) => p.startsWith("embedded"));
    assert.notEqual(embeddedPath, undefined, `expected an "embedded"-prefixed entry, got: ${JSON.stringify(paths)}`);
    assert.ok(
      embeddedPath?.endsWith("/"),
      `expected the embedded repo's listed path to end with "/", got: ${embeddedPath}`,
    );

    const entry = await readUntrackedEntry(repo, embeddedPath as string);
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
    const a = await readUntrackedEntry(repo, "new.txt");
    const b = await readUntrackedEntry(repo, "new.txt");
    assert.equal(a.key, b.key, "the key must be stable across two reads of unchanged content");
    assert.ok(a.key.startsWith("f:"));

    await writeFile(join(repo, "new.txt"), "v2\n");
    const c = await readUntrackedEntry(repo, "new.txt");
    assert.notEqual(a.key, c.key, "the key must change when the file's content changes");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("a file whose content is 'a\\nb\\n' reports lines === 2", async () => {
  const repo = await makeRepo();
  try {
    await writeFile(join(repo, "twolines.txt"), "a\nb\n");
    const entry = await readUntrackedEntry(repo, "twolines.txt");
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
    const entry = await readUntrackedEntry(repo, "never-existed.txt");
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
    assert.ok(
      (paths ?? []).includes(fileName),
      `expected the exact on-disk name "${fileName}" in the listing (not a C-quoted string), got: ${JSON.stringify(paths)}`,
    );

    const entry = await readUntrackedEntry(repo, fileName);
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
      (paths ?? []).includes(" "),
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
  "a filename with invalid-UTF-8 bytes is never self-matching: always readable: false, so it always counts",
  { skip: hasNonUtf8Filenames ? false : nonUtf8SkipReason },
  async () => {
    // Round 3's finding: -z stops GIT from quoting, but execFile's default utf8 decode still
    // mangles a genuinely non-UTF-8 filename into U+FFFD before this module ever sees it -- the
    // exact same self-matching "a:" bypass as the quoting bug, reached through Node's decoder
    // instead of git's. Fixed by reading stdout as a raw buffer and round-tripping each entry
    // individually; an entry that can't round-trip losslessly must come back readable: false
    // (never snapshotted, always counted), not a fixed "a:" key that matches itself forever.
    const repo = await makeRepo();
    try {
      const nameBytes = nonUtf8FilenameBytes();
      const filePath = Buffer.concat([Buffer.from(`${repo}/`), nameBytes]);
      await writeFile(filePath, "line\n".repeat(250));

      const paths = await listUntrackedPaths(repo);
      assert.notEqual(paths, null);
      assert.equal((paths ?? []).length, 1, `expected exactly one untracked entry, got: ${JSON.stringify(paths)}`);
      const listedPath = (paths as string[])[0] as string;

      const t0 = await readUntrackedEntry(repo, listedPath);
      assert.equal(t0.readable, false, "an unrepresentable path must never be marked readable (never snapshottable)");

      await appendFile(filePath, "line\n".repeat(250));

      // Re-measure exactly as diffStat's loop would: re-list, then re-read at the (possibly
      // re-decoded) current path string.
      const pathsAfter = await listUntrackedPaths(repo);
      const listedPathAfter = ((pathsAfter ?? [])[0] ?? listedPath) as string;
      const t1 = await readUntrackedEntry(repo, listedPathAfter);

      // The bypass this test guards against was `readable: true` at both T0 and T1 with an
      // identical fixed "a:" key -- Task 3's captureUntrackedBaseline would snapshot it, and the
      // 250 new lines above would compare equal and contribute nothing. readable: false at T1
      // (not just T0) is what proves it: the path is never cached into a baseline, so it has no
      // way to self-match and keeps counting on every future measurement, unconditionally.
      assert.equal(
        t1.readable,
        false,
        "an unrepresentable path must stay unreadable after content changes too, or it could be snapshotted and then self-match",
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  },
);
