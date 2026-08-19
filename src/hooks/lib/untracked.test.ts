import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
