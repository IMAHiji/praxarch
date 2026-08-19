import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEST_DIST_DIR } from "../../test-support/dist-dir.js";
// Imports the compiled output, not the sibling .ts source — matches the convention in
// git-diff.test.ts/config.test.ts: tests resolve modules the way Node does at runtime.
// TEST_DIST_DIR, not a hardcoded "../../../dist": #14 made `pnpm verify` build to a scratch
// directory so verifying a branch no longer overwrites the installed hooks.
const { resolveEffectiveBaseline } = (await import(
  join(TEST_DIST_DIR, "hooks", "lib", "upstream-baseline.js")
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

// A clone of `bareRemote` — the most common way `refs/remotes/origin/HEAD` gets set. Not the only
// one: on this machine's git (2.54.0), `git init` + `git remote add` + `git fetch` sets it too, so
// tests that need the ref genuinely absent delete it explicitly (see below) rather than relying on
// a fetch-without-clone path whose behavior has changed across git versions.
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

test("characterization: pushing a commit directly to the remote default branch does launder it out of scope (documented residual risk, intentional)", async () => {
  // Pinned as intentional-and-documented behavior, not a defect: pushing straight to the remote's
  // default branch is the one route this module cannot distinguish from "already reviewed and
  // merged," because from the remote's perspective it's indistinguishable from an MR having
  // landed. That's an accepted tradeoff (branch protection is the actual mitigation, not this
  // module), but a future change could silently narrow or widen it without anyone noticing unless
  // a test pins the current shape.
  const bare = await makeBareRemote();
  const seed = await makeSeedRepo(bare);
  const session = await cloneRepo(bare, "direct-push");
  try {
    const pinned = git(session, ["rev-parse", "HEAD"]);
    const pushedTip = await commitFile(session, "local.txt", "session work, pushed straight to main\n", "local commit");
    git(session, ["push", "-q", "origin", "main"]);
    git(session, ["fetch", "-q", "origin"]);

    const effective = await resolveEffectiveBaseline(session, pinned);
    assert.equal(effective, pushedTip);
    assert.notEqual(effective, pinned);
  } finally {
    await cleanup(bare, seed, session);
  }
});

test("no remote configured at all keeps the pinned baseline (not the same value as HEAD)", async () => {
  const repo = await mkdtemp(join(tmpdir(), "praxarch-upstream-noremote-"));
  try {
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    const pinned = await commitFile(repo, "file.txt", "content\n", "initial");
    // A commit after pinning makes `pinned` and `HEAD` distinct values. Without this, "returned
    // pinned" (correct) and "advanced onto HEAD" (a fail-open) both produce the same commit and
    // this assertion can't tell them apart — see MAJOR 1 in the verifier's finding on this file.
    const head = await commitFile(repo, "later.txt", "session work\n", "local commit after pinning");

    const effective = await resolveEffectiveBaseline(repo, pinned);
    assert.equal(effective, pinned);
    assert.notEqual(effective, head);
  } finally {
    await cleanup(repo);
  }
});

test("refs/remotes/<remote>/HEAD unset keeps the pinned baseline (not the same value as HEAD)", async () => {
  const bare = await makeBareRemote();
  const seed = await makeSeedRepo(bare);
  const repo = await cloneRepo(bare, "nohead");
  try {
    const pinned = git(repo, ["rev-parse", "HEAD"]);
    // Force the ref genuinely absent rather than relying on a fetch-without-clone path: on this
    // machine's git (2.54.0), `git init` + `git remote add` + `git fetch` sets
    // refs/remotes/origin/HEAD too (verified), so that path no longer reproduces the state this
    // test's name claims. `update-ref -d` reproduces the real conditions instead — a genuinely
    // deleted or never-created ref, e.g. a repo cloned on an old git and never re-fetched, or a
    // remote explicitly detached with `git remote set-head origin -d`.
    git(repo, ["update-ref", "-d", "refs/remotes/origin/HEAD"]);
    // A commit after pinning, same reasoning as the sibling "no remote" test above: `pinned` and
    // `HEAD` must be distinguishable values for this assertion to have teeth.
    const head = await commitFile(repo, "later.txt", "session work\n", "local commit after pinning");

    const effective = await resolveEffectiveBaseline(repo, pinned);
    assert.equal(effective, pinned);
    assert.notEqual(effective, head);
  } finally {
    await cleanup(bare, seed, repo);
  }
});

test("a fetch that brings a teammate's commit without merging it does not advance past the merge-base (merge-base step is load-bearing, not a redundant hop to the raw tip)", async () => {
  // No fixture up to this point ever leaves the remote-tracking tip strictly ahead of
  // merge-base(HEAD, tip) -- every prior scenario either never fetches, or fetches-and-merges in
  // the same beat. `fetch` alone (no merge, no pull) is exactly the shape that does: the session's
  // own HEAD stays behind the remote-tracking ref, so `tip` itself is not reachable from HEAD and
  // returning it directly (skipping merge-base) would hand back a commit the session never built
  // on -- unreachable from HEAD, and liable to understate the diff if that commit happens to touch
  // content the session also wrote locally.
  const bare = await makeBareRemote();
  const seed = await makeSeedRepo(bare);
  const session = await cloneRepo(bare, "fetch-no-merge");
  try {
    const pinned = git(session, ["rev-parse", "HEAD"]);
    await commitFile(session, "local.txt", "session work\n", "local commit");
    const teammateTip = await commitFile(seed, "teammate.txt", "teammate's own reviewed work\n", "teammate commit");
    git(seed, ["push", "-q", "origin", "main"]);
    git(session, ["fetch", "-q", "origin"]); // deliberately no merge/pull -- HEAD does not move

    const effective = await resolveEffectiveBaseline(session, pinned);
    assert.equal(effective, pinned);
    assert.notEqual(effective, teammateTip);
  } finally {
    await cleanup(bare, seed, session);
  }
});

test("HEAD and the remote-tracking tip sharing no common ancestor falls back to the pinned baseline, not HEAD (merge-base failure path is load-bearing)", async () => {
  // Two independently `git init`'d repos have disjoint root commits by construction -- no shared
  // history to find, so `git merge-base HEAD <tip>` genuinely fails (non-zero exit, no output)
  // rather than merely returning an unhelpful answer. `pinned` is an ancestor of the session's real
  // HEAD (ordinary local work), so a mutant that assigns the literal string `"HEAD"` on that catch
  // would pass the `--is-ancestor` guard (pinned is trivially an ancestor of the branch's own tip)
  // and return `"HEAD"` -- the caller's `git diff` would then measure nothing but working-tree
  // changes, dropping every commit the session made out of the diff. That failure shape has no
  // other test: it needs the merge-base call itself to throw, which no other fixture produces.
  const bare = await makeBareRemote();
  await makeSeedRepo(bare); // unrelated history, becomes origin/main's sole content below
  const session = await mkdtemp(join(tmpdir(), "praxarch-upstream-disjoint-"));
  try {
    execFileSync("git", ["init", "-q", "-b", "main", session]);
    git(session, ["config", "user.email", "test@example.com"]);
    git(session, ["config", "user.name", "Test"]);
    const pinned = await commitFile(session, "p.txt", "p\n", "pinned commit");
    const head = await commitFile(session, "h.txt", "h\n", "later commit, still session-local");
    git(session, ["remote", "add", "origin", bare]);
    git(session, ["fetch", "-q", "origin"]); // brings origin/main's disjoint history, sets origin/HEAD

    const effective = await resolveEffectiveBaseline(session, pinned);
    assert.equal(effective, pinned);
    assert.notEqual(effective, head);
    assert.notEqual(effective, "HEAD");
  } finally {
    await cleanup(bare, session);
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
