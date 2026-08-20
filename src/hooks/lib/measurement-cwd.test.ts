import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEST_DIST_DIR } from "../../test-support/dist-dir.js";

// Imports the compiled output, not the sibling .ts source — matches the convention in
// git-diff.test.ts / config.test.ts: tests resolve modules the way Node does at runtime.
const { resolveMeasurementCwd } = (await import(
  join(TEST_DIST_DIR, "hooks", "lib", "measurement-cwd.js")
)) as typeof import("./measurement-cwd.js");

test("legacy session (baselineCwd undefined) resolves to the hook cwd", async () => {
  const hookCwd = "/wherever/the/shell/is";
  assert.equal(await resolveMeasurementCwd(undefined, hookCwd), hookCwd);
});

test("a live anchor resolves to the anchor, not the hook cwd", async () => {
  const anchor = await mkdtemp(join(tmpdir(), "praxarch-measurement-cwd-"));
  try {
    assert.equal(await resolveMeasurementCwd(anchor, "/somewhere/else"), anchor);
  } finally {
    await rm(anchor, { recursive: true, force: true });
  }
});

test("a dead anchor (directory removed) resolves to null, never the hook cwd", async () => {
  const anchor = await mkdtemp(join(tmpdir(), "praxarch-measurement-cwd-dead-"));
  await rm(anchor, { recursive: true, force: true });
  assert.equal(await resolveMeasurementCwd(anchor, "/somewhere/else"), null);
});

function initRepo(dir: string): void {
  execFileSync("git", ["init", "-q"], { cwd: dir });
}

// MAJOR 2: a live-but-non-repo anchor must not silently reach diffStat's own `{0, 0}`-on-non-repo
// allow when the hook cwd IS a real repo -- that's the exact divergence (laundering) shape a
// worktree `cd` produces, just one level up (anchor recorded outside any repo, work then done
// inside one). See measurement-cwd.ts's doc comment for the full branch table.
test("anchor exists but is not a repo, hook cwd IS a repo -> null (fail closed, the divergence case)", async () => {
  const anchor = await mkdtemp(join(tmpdir(), "praxarch-measurement-cwd-nonrepo-anchor-"));
  const hookRepo = await mkdtemp(join(tmpdir(), "praxarch-measurement-cwd-hookrepo-"));
  try {
    initRepo(hookRepo);
    assert.equal(await resolveMeasurementCwd(anchor, hookRepo), null);
  } finally {
    await rm(anchor, { recursive: true, force: true });
    await rm(hookRepo, { recursive: true, force: true });
  }
});

// The benign carve-out: neither cwd is a repo, so there's genuinely nothing to launder -- this
// must keep returning the anchor (diffStat's own `{0, 0}` allow handles it from there), not start
// failing closed for a session that never touched git at all.
test("anchor exists but is not a repo, hook cwd is ALSO not a repo -> resolves to the anchor (benign, preserves today's {0,0} allow)", async () => {
  const anchor = await mkdtemp(join(tmpdir(), "praxarch-measurement-cwd-nonrepo-anchor2-"));
  const hookNonRepo = await mkdtemp(join(tmpdir(), "praxarch-measurement-cwd-nonrepo-hook-"));
  try {
    assert.equal(await resolveMeasurementCwd(anchor, hookNonRepo), anchor);
  } finally {
    await rm(anchor, { recursive: true, force: true });
    await rm(hookNonRepo, { recursive: true, force: true });
  }
});

test("anchor exists and IS a repo -> resolves to the anchor regardless of the hook cwd's repo-ness", async () => {
  const anchor = await mkdtemp(join(tmpdir(), "praxarch-measurement-cwd-repo-anchor-"));
  try {
    initRepo(anchor);
    assert.equal(await resolveMeasurementCwd(anchor, "/somewhere/not/a/repo"), anchor);
  } finally {
    await rm(anchor, { recursive: true, force: true });
  }
});
