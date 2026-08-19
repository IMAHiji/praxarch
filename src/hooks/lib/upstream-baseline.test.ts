import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// Imports the compiled output, not the sibling .ts source — matches the convention in
// git-diff.test.ts/config.test.ts: tests resolve modules the way Node does at runtime.
const here = dirname(fileURLToPath(import.meta.url));
const { resolveEffectiveBaseline } = (await import(
  join(here, "..", "..", "..", "dist", "hooks", "lib", "upstream-baseline.js")
)) as typeof import("./upstream-baseline.js");

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd }).toString("utf8").trim();
}

// A real bare remote, not a fake — the security property this module provides (origin/HEAD vs.
// @{upstream}) only exists once a real `git clone`/`git push`/`git fetch` cycle is in play; a
// hand-built ref layout would risk testing the fixture instead of the module.
async function makeBareRemote(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "praxarch-upstream-bare-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", dir]);
  return dir;
}

async function makeSeedRepo(bareRemote: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "praxarch-upstream-seed-"));
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  await writeFile(join(dir, "base.txt"), "base\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "initial"]);
  git(dir, ["remote", "add", "origin", bareRemote]);
  git(dir, ["push", "-q", "-u", "origin", "main"]);
  return dir;
}

// A clone of `bareRemote` — the one operation that reliably sets `refs/remotes/origin/HEAD`
// (verified: `git init` + `git remote add` + `git fetch` does not).
async function cloneRepo(bareRemote: string, prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `praxarch-upstream-${prefix}-`));
  execFileSync("git", ["clone", "-q", bareRemote, dir]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  return dir;
}

async function commitFile(repo: string, name: string, contents: string, message: string): Promise<string> {
  await writeFile(join(repo, name), contents);
  git(repo, ["add", name]);
  git(repo, ["commit", "-q", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}

async function cleanup(...dirs: string[]): Promise<void> {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
}

test("pinned === null returns null (no baseline to advance from)", async () => {
  const result = await resolveEffectiveBaseline("/nonexistent-does-not-matter", null);
  assert.equal(result, null);
});

test("fast-forward pull of merged work advances past the pinned baseline (the observed regression)", async () => {
  const bare = await makeBareRemote();
  const seed = await makeSeedRepo(bare);
  const session = await cloneRepo(bare, "ff-session");
  try {
    const pinned = git(session, ["rev-parse", "HEAD"]);
    // Already-reviewed work lands on the remote's default branch without the session doing
    // anything — the exact shape of a teammate's MR merging while a session is still open.
    const pulledTip = await commitFile(seed, "upstream.txt", "already reviewed\n", "merged upstream work");
    git(seed, ["push", "-q", "origin", "main"]);
    git(session, ["pull", "-q", "--ff-only", "origin", "main"]);

    const effective = await resolveEffectiveBaseline(session, pinned);
    assert.equal(effective, pulledTip);
    assert.notEqual(effective, pinned);
  } finally {
    await cleanup(bare, seed, session);
  }
});

test("local commit only, nothing pulled, keeps the pinned baseline", async () => {
  const bare = await makeBareRemote();
  const seed = await makeSeedRepo(bare);
  const session = await cloneRepo(bare, "local-only");
  try {
    const pinned = git(session, ["rev-parse", "HEAD"]);
    await commitFile(session, "local.txt", "session work\n", "local commit");

    const effective = await resolveEffectiveBaseline(session, pinned);
    assert.equal(effective, pinned);
  } finally {
    await cleanup(bare, seed, session);
  }
});

test("local commit plus a merged-in upstream commit advances only to the upstream tip, local work stays counted", async () => {
  const bare = await makeBareRemote();
  const seed = await makeSeedRepo(bare);
  const session = await cloneRepo(bare, "merge-both");
  try {
    const pinned = git(session, ["rev-parse", "HEAD"]);
    // Diverging siblings: local work in the session clone, unrelated reviewed work pushed
    // straight to the remote by someone else — both built on `pinned`.
    await commitFile(session, "local.txt", "session work\n", "local commit");
    const upstreamTip = await commitFile(seed, "upstream.txt", "already reviewed\n", "merged upstream work");
    git(seed, ["push", "-q", "origin", "main"]);
    git(session, ["fetch", "-q", "origin"]);
    git(session, ["merge", "-q", "--no-edit", "-m", "merge upstream", "origin/main"]);

    const effective = await resolveEffectiveBaseline(session, pinned);
    assert.equal(effective, upstreamTip);

    // The sub-case B fail/pass pair at the git level: from the derived baseline only the local
    // file shows as changed; from the raw pinned baseline both files do, because the pinned
    // measurement has no way to know the upstream file was already reviewed.
    const numstatFromEffective = git(session, ["diff", "--numstat", String(effective)]);
    const numstatFromPinned = git(session, ["diff", "--numstat", pinned]);
    assert.equal(numstatFromEffective.split("\n").filter((line) => line.length > 0).length, 1);
    assert.match(numstatFromEffective, /local\.txt/);
    assert.equal(numstatFromPinned.split("\n").filter((line) => line.length > 0).length, 2);
  } finally {
    await cleanup(bare, seed, session);
  }
});

test("a local commit pushed to a feature branch is not laundered past the gate (anti-laundering)", async () => {
  const bare = await makeBareRemote();
  const seed = await makeSeedRepo(bare);
  const session = await cloneRepo(bare, "feature-push");
  try {
    const pinned = git(session, ["rev-parse", "HEAD"]);
    git(session, ["checkout", "-q", "-b", "feature"]);
    await commitFile(session, "local.txt", "session work\n", "local commit on a feature branch");
    git(session, ["push", "-q", "-u", "origin", "feature"]);

    const effective = await resolveEffectiveBaseline(session, pinned);
    assert.equal(effective, pinned);

    // The security property, made explicit: `merge-base(HEAD, @{upstream})` moves onto the
    // session's own pushed (but unreviewed) commit — the exact laundering `origin/HEAD` avoids by
    // construction, because the remote's *default* branch (still `main`) never moved. If a future
    // change swapped the reference back to `@{upstream}`, this assertion is what would catch it.
    const mergeBaseWithTrackingRef = git(session, ["merge-base", "HEAD", "@{upstream}"]);
    assert.notEqual(mergeBaseWithTrackingRef, effective);
  } finally {
    await cleanup(bare, seed, session);
  }
});

test("no remote configured at all keeps the pinned baseline", async () => {
  const repo = await mkdtemp(join(tmpdir(), "praxarch-upstream-noremote-"));
  try {
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    const pinned = await commitFile(repo, "file.txt", "content\n", "initial");

    const effective = await resolveEffectiveBaseline(repo, pinned);
    assert.equal(effective, pinned);
  } finally {
    await cleanup(repo);
  }
});

test("refs/remotes/<remote>/HEAD unset (init + remote add + fetch, not clone) keeps the pinned baseline", async () => {
  const bare = await makeBareRemote();
  const seed = await makeSeedRepo(bare);
  const repo = await mkdtemp(join(tmpdir(), "praxarch-upstream-nohead-"));
  try {
    // Deliberately not `git clone` — this is the one path documented (and verified) not to set
    // origin/HEAD.
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    git(repo, ["remote", "add", "origin", bare]);
    git(repo, ["fetch", "-q", "origin"]);
    git(repo, ["checkout", "-q", "-b", "main", "origin/main"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    const pinned = git(repo, ["rev-parse", "HEAD"]);

    const effective = await resolveEffectiveBaseline(repo, pinned);
    assert.equal(effective, pinned);
  } finally {
    await cleanup(bare, seed, repo);
  }
});

test("a pinned baseline that is not an ancestor of the derived candidate is left untouched (rollback guard)", async () => {
  const bare = await makeBareRemote();
  const seed = await makeSeedRepo(bare);
  const session = await cloneRepo(bare, "rollback");
  try {
    const initial = git(session, ["rev-parse", "HEAD"]);
    // `pinned` was recorded when the session was ahead of `initial`; the session then rolled HEAD
    // back (a `reset --hard`, or a checkout of an older commit) to a state `pinned` cannot be
    // reached from going forward.
    const pinned = await commitFile(session, "local.txt", "session work\n", "local commit");
    git(session, ["reset", "-q", "--hard", initial]);

    const effective = await resolveEffectiveBaseline(session, pinned);
    assert.equal(effective, pinned);
  } finally {
    await cleanup(bare, seed, session);
  }
});
