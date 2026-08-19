import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { DiffCounts } from "./lib/git-diff.js";
import type { getMkfifoProbe as GetMkfifoProbe } from "./lib/fixtures/mkfifo-probe.js";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "..", "..", "dist", "hooks", "verify-gate.js");

// `which mkfifo` proves only that the binary is on PATH, not that mkfifo(2) actually works here
// -- a sandboxed CI runner can ship the binary while refusing the syscall. The FIFO-based
// end-to-end test below shares the same functional-probe implementation as git-diff.test.ts (see
// lib/fixtures/mkfifo-probe.ts) rather than duplicating a weaker guard. Imported from dist because
// a bare ".ts" specifier fails tsc (TS5097) since this project emits, and the sibling
// fixtures/*-runner.ts files are already executed from dist -- this sits where the build already
// handles it. `node --test` runs each test file in its own child process, so this file's probe
// call is its own cached-once execution, separate from git-diff.test.ts's -- still "once per
// process, not once per test" per file, just not shared across files.
const { getMkfifoProbe } = (await import(
  join(here, "..", "..", "dist", "hooks", "lib", "fixtures", "mkfifo-probe.js")
)) as { getMkfifoProbe: typeof GetMkfifoProbe };
const mkfifoProbeResult = await getMkfifoProbe();
const hasMkfifo = mkfifoProbeResult.ok;
const mkfifoSkipReason = mkfifoProbeResult.reason ?? "mkfifo not available on this platform";

// `diffStat` returns `DiffCounts | null` (null means "could not measure"). Every call site below
// expects a real measurement (a healthy repo, no simulated failure) and routes through this so a
// regression fails loudly instead of throwing on a destructure of null.
function assertMeasured(counts: DiffCounts | null): DiffCounts {
  assert.notEqual(counts, null, "expected diffStat to return real counts, not null, on this healthy-path call");
  return counts as DiffCounts;
}

// A fake `git` on PATH that behaves like the real one for --numstat and ls-files, but always
// fails `git status` outright — simulating a real, black-box failure of the call
// diffFingerprint's null contract exists to cover (see git-diff.test.ts for the unit-level
// version of this; that file also covers the maxBuffer-overflow variant).
async function makeFakeGitDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "praxarch-verifygate-fakegit-"));
  const realGit = execFileSync("which", ["git"]).toString("utf8").trim();
  const script2 = [
    "#!/bin/sh",
    'case "$*" in',
    `  *--numstat*) exec "${realGit}" "$@" ;;`,
    `  *ls-files*) exec "${realGit}" "$@" ;;`,
    '  status*) echo "fake git: status failed" >&2; exit 1 ;;',
    `  *) exec "${realGit}" "$@" ;;`,
    "esac",
  ].join("\n");
  await writeFile(join(dir, "git"), `${script2}\n`, "utf8");
  await chmod(join(dir, "git"), 0o755);
  return dir;
}

async function withFakeGitOnPath<T>(fn: (fakeGitDir: string) => Promise<T>): Promise<T> {
  const fakeGitDir = await makeFakeGitDir();
  try {
    return await fn(fakeGitDir);
  } finally {
    await rm(fakeGitDir, { recursive: true, force: true });
  }
}

// Same shape as makeFakeGitDir/withFakeGitOnPath above, but fails the --numstat probe itself
// (with `ls-files` and `status` passing through) rather than `status` -- the generic "diffStat's
// own measurement failed in a real repo, not a FIFO" case issue #2's null contract also covers.
async function makeFakeGitDirFailingNumstat(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "praxarch-verifygate-fakegit-numstat-"));
  const realGit = execFileSync("which", ["git"]).toString("utf8").trim();
  const script2 = [
    "#!/bin/sh",
    'case "$*" in',
    `  *--numstat*) echo "fake git: numstat probe failed" >&2; exit 1 ;;`,
    `  *) exec "${realGit}" "$@" ;;`,
    "esac",
  ].join("\n");
  await writeFile(join(dir, "git"), `${script2}\n`, "utf8");
  await chmod(join(dir, "git"), 0o755);
  return dir;
}

async function withFakeGitOnPathFailingNumstat<T>(fn: (fakeGitDir: string) => Promise<T>): Promise<T> {
  const fakeGitDir = await makeFakeGitDirFailingNumstat();
  try {
    return await fn(fakeGitDir);
  } finally {
    await rm(fakeGitDir, { recursive: true, force: true });
  }
}

interface Fixture {
  repo: string;
  home: string;
}

async function setupFixture(): Promise<Fixture> {
  const repo = await mkdtemp(join(tmpdir(), "praxarch-verifygate-repo-"));
  const home = await mkdtemp(join(tmpdir(), "praxarch-verifygate-home-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  await writeFile(join(repo, "file.txt"), "line\n".repeat(5));
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });
  return { repo, home };
}

async function teardownFixture(fixture: Fixture): Promise<void> {
  await rm(fixture.repo, { recursive: true, force: true });
  await rm(fixture.home, { recursive: true, force: true });
}

async function makeNonTrivialDiff(repo: string): Promise<void> {
  await writeFile(join(repo, "file.txt"), "changed line\n".repeat(100));
}

async function seedVerifierState(
  home: string,
  sessionId: string,
  verifier:
    | {
        verdict: string;
        criticalOrMajorCount: number;
        findingsCount: number;
        diffHash?: string | null;
        changedLines?: number | null;
        changedFiles?: number | null;
      }
    | null,
): Promise<void> {
  const stateDir = join(home, "state");
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    join(stateDir, `${sessionId}.json`),
    JSON.stringify({
      sessionId,
      startedAt: new Date().toISOString(),
      delegations: [],
      lastVerifier: verifier ? { ...verifier, recordedAt: new Date().toISOString() } : null,
    }),
  );
}

// Seeds arbitrary state fields directly, bypassing the hook's own read/write cycle — used to
// simulate stale/leftover disk state (e.g. a crashed session, or state predating this fix).
async function seedState(home: string, sessionId: string, fields: Record<string, unknown>): Promise<void> {
  const stateDir = join(home, "state");
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    join(stateDir, `${sessionId}.json`),
    JSON.stringify({
      sessionId,
      startedAt: new Date().toISOString(),
      delegations: [],
      lastVerifier: null,
      ...fields,
    }),
  );
}

function readState(home: string, sessionId: string): Promise<Record<string, unknown>> {
  return readFile(join(home, "state", `${sessionId}.json`), "utf8").then((raw) => JSON.parse(raw) as Record<string, unknown>);
}

async function readMonthlyLog(home: string): Promise<Record<string, unknown>[]> {
  const now = new Date();
  const path = join(
    home,
    "logs",
    `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}.jsonl`,
  );
  const raw = await readFile(path, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function run(fixture: Fixture, input: unknown, extraEnv: Record<string, string> = {}): unknown {
  const stdout = execFileSync("node", [script], {
    cwd: fixture.repo,
    input: JSON.stringify(input),
    env: { ...process.env, PRAXARCH_HOME: fixture.home, ...extraEnv },
  }).toString("utf8");
  return JSON.parse(stdout);
}

test("allows a trivial diff without requiring verification", async () => {
  const fixture = await setupFixture();
  try {
    await writeFile(join(fixture.repo, "file.txt"), "line\n".repeat(6));
    const result = run(fixture, {
      session_id: "s1",
      cwd: fixture.repo,
      hook_event_name: "Stop",
    }) as { decision?: string };
    assert.equal(result.decision, undefined);
  } finally {
    await teardownFixture(fixture);
  }
});

test("blocks a non-trivial diff with no verifier record", async () => {
  const fixture = await setupFixture();
  try {
    await makeNonTrivialDiff(fixture.repo);
    const result = run(fixture, {
      session_id: "s1",
      cwd: fixture.repo,
      hook_event_name: "Stop",
    }) as { decision?: string; reason?: string };
    assert.equal(result.decision, "block");
    assert.match(result.reason ?? "", /no verifier pass is on record/);
  } finally {
    await teardownFixture(fixture);
  }
});

test("block remediation interpolates the real session id, not a literal placeholder", async () => {
  const fixture = await setupFixture();
  try {
    await makeNonTrivialDiff(fixture.repo);
    const result = run(fixture, {
      session_id: "s1-distinctive",
      cwd: fixture.repo,
      hook_event_name: "Stop",
    }) as { hookSpecificOutput?: { additionalContext?: string } };
    const additionalContext = result.hookSpecificOutput?.additionalContext ?? "";
    assert.match(additionalContext, /record-verdict --session s1-distinctive --role <role>/);
    assert.doesNotMatch(additionalContext, /--session <id>/);
  } finally {
    await teardownFixture(fixture);
  }
});

test("allows a non-trivial diff with a CONFIRMED verifier record", async () => {
  const fixture = await setupFixture();
  try {
    await makeNonTrivialDiff(fixture.repo);
    await seedVerifierState(fixture.home, "s1", {
      verdict: "CONFIRMED",
      criticalOrMajorCount: 0,
      findingsCount: 0,
    });
    const result = run(fixture, {
      session_id: "s1",
      cwd: fixture.repo,
      hook_event_name: "Stop",
    }) as { decision?: string };
    assert.equal(result.decision, undefined);
  } finally {
    await teardownFixture(fixture);
  }
});

test("blocks a non-trivial diff with a REFUTED verifier record", async () => {
  const fixture = await setupFixture();
  try {
    await makeNonTrivialDiff(fixture.repo);
    await seedVerifierState(fixture.home, "s1", {
      verdict: "REFUTED",
      criticalOrMajorCount: 1,
      findingsCount: 1,
    });
    const result = run(fixture, {
      session_id: "s1",
      cwd: fixture.repo,
      hook_event_name: "Stop",
    }) as { decision?: string; reason?: string };
    assert.equal(result.decision, "block");
    assert.match(result.reason ?? "", /REFUTED with 1 critical\/major/);
  } finally {
    await teardownFixture(fixture);
  }
});

test("PRAXARCH_SKIP_VERIFY=1 bypasses the gate on a non-trivial diff", async () => {
  const fixture = await setupFixture();
  try {
    await makeNonTrivialDiff(fixture.repo);
    const result = run(
      fixture,
      { session_id: "s1", cwd: fixture.repo, hook_event_name: "Stop" },
      { PRAXARCH_SKIP_VERIFY: "1" },
    ) as { decision?: string };
    assert.equal(result.decision, undefined);
  } finally {
    await teardownFixture(fixture);
  }
});

test("fails open after two consecutive blocks in one stop cycle (loop guard)", async () => {
  const fixture = await setupFixture();
  try {
    await makeNonTrivialDiff(fixture.repo);
    const stop = (active: boolean): { decision?: string; systemMessage?: string } =>
      run(fixture, {
        session_id: "s1",
        cwd: fixture.repo,
        hook_event_name: "Stop",
        stop_hook_active: active,
      }) as { decision?: string; systemMessage?: string };

    assert.equal(stop(false).decision, "block");
    assert.equal(stop(true).decision, "block");
    const third = stop(true);
    assert.equal(third.decision, undefined);
    assert.match(third.systemMessage ?? "", /failing open/);

    // A fresh stop cycle (stop_hook_active back to false) blocks again from scratch.
    assert.equal(stop(false).decision, "block");
  } finally {
    await teardownFixture(fixture);
  }
});

async function seedBaselineHead(
  home: string,
  sessionId: string,
  baselineHead: string | null,
): Promise<void> {
  const stateDir = join(home, "state");
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    join(stateDir, `${sessionId}.json`),
    JSON.stringify({
      sessionId,
      startedAt: new Date().toISOString(),
      delegations: [],
      lastVerifier: null,
      baselineHead,
    }),
  );
}

test("blocks a non-trivial change that was committed during the session", async () => {
  const fixture = await setupFixture();
  try {
    const initHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: fixture.repo })
      .toString("utf8")
      .trim();
    await seedBaselineHead(fixture.home, "s1", initHead);

    await makeNonTrivialDiff(fixture.repo);
    execFileSync("git", ["add", "."], { cwd: fixture.repo });
    execFileSync("git", ["commit", "-q", "-m", "non-trivial change"], { cwd: fixture.repo });

    const result = run(fixture, {
      session_id: "s1",
      cwd: fixture.repo,
      hook_event_name: "Stop",
    }) as { decision?: string };
    assert.equal(result.decision, "block");
  } finally {
    await teardownFixture(fixture);
  }
});

test("blocks a non-trivial change consisting only of untracked new files", async () => {
  const fixture = await setupFixture();
  try {
    for (let i = 0; i < 3; i += 1) {
      await writeFile(join(fixture.repo, `untracked-${i}.txt`), "new line\n".repeat(40));
    }
    const result = run(fixture, {
      session_id: "s1",
      cwd: fixture.repo,
      hook_event_name: "Stop",
    }) as { decision?: string };
    assert.equal(result.decision, "block");
  } finally {
    await teardownFixture(fixture);
  }
});

test("blocks a non-trivial change of only untracked files in a repo with no commits", async () => {
  const repo = await mkdtemp(join(tmpdir(), "praxarch-verifygate-repo-"));
  const home = await mkdtemp(join(tmpdir(), "praxarch-verifygate-home-"));
  const fixture: Fixture = { repo, home };
  try {
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
    for (let i = 0; i < 3; i += 1) {
      await writeFile(join(repo, `untracked-${i}.txt`), "new line\n".repeat(60));
    }
    const result = run(fixture, {
      session_id: "s1",
      cwd: fixture.repo,
      hook_event_name: "Stop",
    }) as { decision?: string };
    assert.equal(result.decision, "block");
  } finally {
    await teardownFixture(fixture);
  }
});

test("an explicit waiver in the final message bypasses the gate", async () => {
  const fixture = await setupFixture();
  try {
    await makeNonTrivialDiff(fixture.repo);
    const result = run(fixture, {
      session_id: "s1",
      cwd: fixture.repo,
      hook_event_name: "Stop",
      last_assistant_message: "Docs-only change. PRAXARCH_VERIFY_WAIVED: no behavior change, docs only.",
    }) as { decision?: string };
    assert.equal(result.decision, undefined);
  } finally {
    await teardownFixture(fixture);
  }
});

// --- Counter scoping (issue #1, defect 1) ------------------------------------------------------
//
// Each case below seeds a stale counter of 2 (as if left by a dead/crashed process, or predating
// this fix) with stop_hook_active: true — the ternary that used to gate reading the persisted
// counter would trust that stale value and fail open immediately. After the fix, an allow path
// must clear it, so a *follow-up* call that should genuinely block does so rather than
// immediately failing open on stale state.

test("counter is reset to 0 after PRAXARCH_SKIP_VERIFY allows a non-trivial diff", async () => {
  const fixture = await setupFixture();
  try {
    await makeNonTrivialDiff(fixture.repo);
    await seedState(fixture.home, "s1", { verifyGateConsecutiveBlocks: 2 });
    const first = run(
      fixture,
      { session_id: "s1", cwd: fixture.repo, hook_event_name: "Stop", stop_hook_active: true },
      { PRAXARCH_SKIP_VERIFY: "1" },
    ) as { decision?: string };
    assert.equal(first.decision, undefined);

    const second = run(fixture, {
      session_id: "s1",
      cwd: fixture.repo,
      hook_event_name: "Stop",
      stop_hook_active: true,
    }) as { decision?: string };
    assert.equal(second.decision, "block");
  } finally {
    await teardownFixture(fixture);
  }
});

test("counter is reset to 0 after a waiver allows a non-trivial diff", async () => {
  const fixture = await setupFixture();
  try {
    await makeNonTrivialDiff(fixture.repo);
    await seedState(fixture.home, "s1", { verifyGateConsecutiveBlocks: 2 });
    const first = run(fixture, {
      session_id: "s1",
      cwd: fixture.repo,
      hook_event_name: "Stop",
      stop_hook_active: true,
      last_assistant_message: "PRAXARCH_VERIFY_WAIVED: docs only",
    }) as { decision?: string };
    assert.equal(first.decision, undefined);

    // The waiver covers the diff it was granted against, so move the tree before asserting that a
    // genuine block still fires — otherwise this would be testing waiver stickiness, not the
    // counter reset it exists to cover.
    await writeFile(join(fixture.repo, "more.txt"), "new work\n".repeat(100));
    const second = run(fixture, {
      session_id: "s1",
      cwd: fixture.repo,
      hook_event_name: "Stop",
      stop_hook_active: true,
    }) as { decision?: string };
    assert.equal(second.decision, "block");
  } finally {
    await teardownFixture(fixture);
  }
});

// --- Waiver stickiness --------------------------------------------------------------------------
//
// The gate measures the session's cumulative diff against baselineHead, so a waiver that only
// allowed a single stop re-blocked on every later stop for the rest of the session — including
// turns that changed nothing, and including turns whose work was already committed and pushed. A
// waiver now stands until the diff it was granted against actually moves.

test("a waiver still stands on a later stop when the diff has not moved", async () => {
  const fixture = await setupFixture();
  try {
    await makeNonTrivialDiff(fixture.repo);
    const first = run(fixture, {
      session_id: "s1",
      cwd: fixture.repo,
      hook_event_name: "Stop",
      last_assistant_message: "PRAXARCH_VERIFY_WAIVED: docs only",
    }) as { decision?: string };
    assert.equal(first.decision, undefined);

    // No waiver in this message, and nothing changed in the tree.
    const second = run(fixture, {
      session_id: "s1",
      cwd: fixture.repo,
      hook_event_name: "Stop",
      last_assistant_message: "Both PRs are open and green.",
    }) as { decision?: string };
    assert.equal(second.decision, undefined);
  } finally {
    await teardownFixture(fixture);
  }
});

test("a waiver stops applying once the diff moves", async () => {
  const fixture = await setupFixture();
  try {
    await makeNonTrivialDiff(fixture.repo);
    run(fixture, {
      session_id: "s1",
      cwd: fixture.repo,
      hook_event_name: "Stop",
      last_assistant_message: "PRAXARCH_VERIFY_WAIVED: docs only",
    });

    await writeFile(join(fixture.repo, "more.txt"), "unverified new work\n".repeat(100));
    const after = run(fixture, {
      session_id: "s1",
      cwd: fixture.repo,
      hook_event_name: "Stop",
      last_assistant_message: "Done.",
    }) as { decision?: string };
    assert.equal(after.decision, "block");
  } finally {
    await teardownFixture(fixture);
  }
});

test("a waiver granted in one session does not leak into another", async () => {
  const fixture = await setupFixture();
  try {
    await makeNonTrivialDiff(fixture.repo);
    run(fixture, {
      session_id: "s1",
      cwd: fixture.repo,
      hook_event_name: "Stop",
      last_assistant_message: "PRAXARCH_VERIFY_WAIVED: docs only",
    });

    const other = run(fixture, {
      session_id: "s2",
      cwd: fixture.repo,
      hook_event_name: "Stop",
      last_assistant_message: "Done.",
    }) as { decision?: string };
    assert.equal(other.decision, "block");
  } finally {
    await teardownFixture(fixture);
  }
});

test("counter is reset to 0 after a trivial diff allows", async () => {
  const fixture = await setupFixture();
  try {
    await seedState(fixture.home, "s1", { verifyGateConsecutiveBlocks: 2 });
    const first = run(fixture, {
      session_id: "s1",
      cwd: fixture.repo,
      hook_event_name: "Stop",
      stop_hook_active: true,
    }) as { decision?: string };
    assert.equal(first.decision, undefined);

    await makeNonTrivialDiff(fixture.repo);
    const second = run(fixture, {
      session_id: "s1",
      cwd: fixture.repo,
      hook_event_name: "Stop",
      stop_hook_active: true,
    }) as { decision?: string };
    assert.equal(second.decision, "block");
  } finally {
    await teardownFixture(fixture);
  }
});

test("counter is reset to 0 after a CONFIRMED verifier pass allows", async () => {
  const fixture = await setupFixture();
  try {
    await makeNonTrivialDiff(fixture.repo);
    await seedState(fixture.home, "s1", {
      verifyGateConsecutiveBlocks: 2,
      lastVerifier: { verdict: "CONFIRMED", criticalOrMajorCount: 0, findingsCount: 0, recordedAt: new Date().toISOString() },
    });
    const first = run(fixture, {
      session_id: "s1",
      cwd: fixture.repo,
      hook_event_name: "Stop",
      stop_hook_active: true,
    }) as { decision?: string };
    assert.equal(first.decision, undefined);

    // Verifier record no longer covers the diff (REFUTED) — the next block must still enforce,
    // not immediately fail open on the stale counter. Patched directly (not via a fresh seed) so
    // the counter written by round 1 above survives into round 2.
    const state = await readState(fixture.home, "s1");
    state["lastVerifier"] = { verdict: "REFUTED", criticalOrMajorCount: 1, findingsCount: 1, recordedAt: new Date().toISOString() };
    await writeFile(join(fixture.home, "state", "s1.json"), JSON.stringify(state));
    const second = run(fixture, {
      session_id: "s1",
      cwd: fixture.repo,
      hook_event_name: "Stop",
      stop_hook_active: true,
    }) as { decision?: string };
    assert.equal(second.decision, "block");
  } finally {
    await teardownFixture(fixture);
  }
});

test("the loop-guard fail-open does NOT reset the counter — once tripped, stays tripped for the rest of the cycle", async () => {
  const fixture = await setupFixture();
  try {
    // Same tree throughout — the tree-changed reset (tested separately below) must not apply
    // here, isolating the loop-guard's own bounded "2 blocks then quiet" behaviour.
    await makeNonTrivialDiff(fixture.repo);
    const stop = (active: boolean): { decision?: string; systemMessage?: string } =>
      run(fixture, {
        session_id: "s1",
        cwd: fixture.repo,
        hook_event_name: "Stop",
        stop_hook_active: active,
      }) as { decision?: string; systemMessage?: string };

    assert.equal(stop(true).decision, "block");
    assert.equal(stop(true).decision, "block");
    const failOpen = stop(true);
    assert.equal(failOpen.decision, undefined);
    assert.match(failOpen.systemMessage ?? "", /failing open/);

    // Clearing on fail-open would turn the bounded guarantee into block, block, allow forever —
    // a further call in the SAME cycle, on the SAME unsatisfiable diff, must fail open again,
    // not re-block.
    const stillFailingOpen = stop(true);
    assert.equal(stillFailingOpen.decision, undefined);
    assert.match(stillFailingOpen.systemMessage ?? "", /failing open/);

    // Only the stop_hook_active: false cycle boundary clears it.
    const freshCycle = stop(false);
    assert.equal(freshCycle.decision, "block");
  } finally {
    await teardownFixture(fixture);
  }
});

test("counter is reset when stop_hook_active is false even though persisted state holds 2", async () => {
  const fixture = await setupFixture();
  try {
    await makeNonTrivialDiff(fixture.repo);
    await seedState(fixture.home, "s1", { verifyGateConsecutiveBlocks: 2 });
    const result = run(fixture, {
      session_id: "s1",
      cwd: fixture.repo,
      hook_event_name: "Stop",
      stop_hook_active: false,
    }) as { decision?: string };
    assert.equal(result.decision, "block");
    const state = await readState(fixture.home, "s1");
    assert.equal(state["verifyGateConsecutiveBlocks"], 1);
  } finally {
    await teardownFixture(fixture);
  }
});

test("stale-state regression: a cycle whose first real enforcement point sees stop_hook_active true still enforces", async () => {
  const fixture = await setupFixture();
  try {
    // Stale counter left on disk from a dead/earlier cycle.
    await seedState(fixture.home, "s1", { verifyGateConsecutiveBlocks: 2 });

    // Round 1: this hook's own diff is trivial, so it allows — but stop_hook_active is false
    // (Claude Code's contract guarantees the very first round of any new stop attempt is), so
    // the stale counter is discarded regardless of the allow/block outcome.
    const round1 = run(fixture, {
      session_id: "s1",
      cwd: fixture.repo,
      hook_event_name: "Stop",
      stop_hook_active: false,
    }) as { decision?: string };
    assert.equal(round1.decision, undefined);

    // Round 2: a different Stop hook (not simulated here) blocked, so Claude Code retries with
    // stop_hook_active true — this is verify-gate's first real enforcement decision in this
    // cycle. The pre-fix bug would read the stale 2 (never cleared by round 1's allow) and fail
    // open immediately, without ever having blocked once in this cycle.
    await makeNonTrivialDiff(fixture.repo);
    const round2 = run(fixture, {
      session_id: "s1",
      cwd: fixture.repo,
      hook_event_name: "Stop",
      stop_hook_active: true,
    }) as { decision?: string; systemMessage?: string };
    assert.equal(round2.decision, "block");
  } finally {
    await teardownFixture(fixture);
  }
});

test("a stale block counter cannot suppress enforcement of a tree that has since changed — a new diff needs its own 2 blocks", async () => {
  const fixture = await setupFixture();
  try {
    const stop = (): { decision?: string; systemMessage?: string } =>
      run(fixture, {
        session_id: "s1",
        cwd: fixture.repo,
        hook_event_name: "Stop",
        stop_hook_active: true,
      }) as { decision?: string; systemMessage?: string };

    // Two blocks on diff A trip the guard right up to the edge.
    await makeNonTrivialDiff(fixture.repo);
    assert.equal(stop().decision, "block");
    assert.equal(stop().decision, "block");

    // The tree changes — new, unverified work the guard hasn't seen yet. The persisted count
    // must not carry over: this diff gets its own fresh count, not an inherited fail-open.
    await writeFile(join(fixture.repo, "different-work.txt"), "line\n".repeat(200));
    const afterChange = stop();
    assert.equal(afterChange.decision, "block");

    // Same (new) tree again — now genuinely 2 blocks against THIS diff — fails open.
    const secondBlockOnNewTree = stop();
    assert.equal(secondBlockOnNewTree.decision, "block");
    const thirdOnNewTree = stop();
    assert.equal(thirdOnNewTree.decision, undefined);
    assert.match(thirdOnNewTree.systemMessage ?? "", /failing open/);
  } finally {
    await teardownFixture(fixture);
  }
});

test("an unknown current hash does not reset the block counter (avoids an infinite-loop vector)", async () => {
  const fixture = await setupFixture();
  try {
    await makeNonTrivialDiff(fixture.repo);
    const stop = (extraEnv: Record<string, string> = {}): { decision?: string; systemMessage?: string } =>
      run(
        fixture,
        { session_id: "s1", cwd: fixture.repo, hook_event_name: "Stop", stop_hook_active: true },
        extraEnv,
      ) as { decision?: string; systemMessage?: string };

    assert.equal(stop().decision, "block");
    assert.equal(stop().decision, "block");

    // Third call: the current diff can't be hashed at all. If unknown reset the counter, this
    // would block again (fresh count) instead of failing open — handing back the exact
    // infinite-loop vector the guard exists to prevent.
    await withFakeGitOnPath(async (fakeGitDir) => {
      const failOpen = stop({ PATH: `${fakeGitDir}:${process.env["PATH"] ?? ""}` });
      assert.equal(failOpen.decision, undefined);
      assert.match(failOpen.systemMessage ?? "", /failing open/);
    });
  } finally {
    await teardownFixture(fixture);
  }
});

// --- Verdict expiry (issue #1, defect 2) -------------------------------------------------------

test("CONFIRMED verdict whose fingerprint matches the current tree allows", async () => {
  const fixture = await setupFixture();
  try {
    await makeNonTrivialDiff(fixture.repo);
    const { diffStat, diffFingerprint } = (await import(join(here, "..", "..", "dist", "hooks", "lib", "git-diff.js"))) as typeof import("./lib/git-diff.js");
    const { changedLines, changedFiles } = assertMeasured(await diffStat(fixture.repo, [], null));
    const hash = await diffFingerprint(fixture.repo);
    await seedVerifierState(fixture.home, "s1", {
      verdict: "CONFIRMED",
      criticalOrMajorCount: 0,
      findingsCount: 0,
      diffHash: hash,
      changedLines,
      changedFiles,
    });
    const result = run(fixture, {
      session_id: "s1",
      cwd: fixture.repo,
      hook_event_name: "Stop",
    }) as { decision?: string };
    assert.equal(result.decision, undefined);
  } finally {
    await teardownFixture(fixture);
  }
});

test("CONFIRMED verdict with a differing hash but a below-threshold size delta still allows", async () => {
  const fixture = await setupFixture();
  try {
    await makeNonTrivialDiff(fixture.repo);
    const { diffStat, diffFingerprint } = (await import(join(here, "..", "..", "dist", "hooks", "lib", "git-diff.js"))) as typeof import("./lib/git-diff.js");
    const { changedLines, changedFiles } = assertMeasured(await diffStat(fixture.repo, [], null));
    const hash = await diffFingerprint(fixture.repo);
    await seedVerifierState(fixture.home, "s1", {
      verdict: "CONFIRMED",
      criticalOrMajorCount: 0,
      findingsCount: 0,
      diffHash: hash,
      changedLines,
      changedFiles,
    });

    // A small post-review fixup: hash changes, but the delta stays under both thresholds
    // (default minChangedLines 80, minChangedFiles 3).
    await writeFile(join(fixture.repo, "small-fixup.txt"), "one more line\n");

    const result = run(fixture, {
      session_id: "s1",
      cwd: fixture.repo,
      hook_event_name: "Stop",
    }) as { decision?: string };
    assert.equal(result.decision, undefined);
  } finally {
    await teardownFixture(fixture);
  }
});

test("CONFIRMED verdict with a differing hash and a threshold-clearing size delta blocks as stale", async () => {
  const fixture = await setupFixture();
  try {
    await makeNonTrivialDiff(fixture.repo);
    const { diffStat, diffFingerprint } = (await import(join(here, "..", "..", "dist", "hooks", "lib", "git-diff.js"))) as typeof import("./lib/git-diff.js");
    const { changedLines, changedFiles } = assertMeasured(await diffStat(fixture.repo, [], null));
    const hash = await diffFingerprint(fixture.repo);
    await seedVerifierState(fixture.home, "s1", {
      verdict: "CONFIRMED",
      criticalOrMajorCount: 0,
      findingsCount: 0,
      diffHash: hash,
      changedLines,
      changedFiles,
    });

    // Substantial further work after the verdict was recorded — clears minChangedLines (80).
    await writeFile(join(fixture.repo, "more-work.txt"), "line\n".repeat(100));

    const result = run(fixture, {
      session_id: "s1",
      cwd: fixture.repo,
      hook_event_name: "Stop",
    }) as { decision?: string; reason?: string };
    assert.equal(result.decision, "block");
    assert.match(result.reason ?? "", /stale/);
  } finally {
    await teardownFixture(fixture);
  }
});

test("a zero file-count delta still reads as a real change, not as nothing happened", async () => {
  const fixture = await setupFixture();
  try {
    await makeNonTrivialDiff(fixture.repo);
    const { diffStat, diffFingerprint } = (await import(join(here, "..", "..", "dist", "hooks", "lib", "git-diff.js"))) as typeof import("./lib/git-diff.js");
    const { changedLines, changedFiles } = assertMeasured(await diffStat(fixture.repo, [], null));
    const hash = await diffFingerprint(fixture.repo);
    await seedVerifierState(fixture.home, "s1", {
      verdict: "REFUTED",
      criticalOrMajorCount: 1,
      findingsCount: 1,
      diffHash: hash,
      changedLines,
      changedFiles,
    });

    // Substantial further work, but all to the SAME file that was already changed -- the file
    // count doesn't grow (fileDelta stays 0), only the line count does. This is the case that
    // used to render as "... across 0 files changed", which reads as if nothing changed even
    // though the line count says otherwise.
    await writeFile(join(fixture.repo, "file.txt"), "changed line\n".repeat(1027));

    const result = run(fixture, {
      session_id: "s1",
      cwd: fixture.repo,
      hook_event_name: "Stop",
    }) as { decision?: string; reason?: string };
    assert.equal(result.decision, "block");
    assert.match(result.reason ?? "", /stale — \d+ lines? changed and the file count grew by 0 since it was recorded/);
  } finally {
    await teardownFixture(fixture);
  }
});

test("a negative file delta alongside a positive line delta reads as English, not '-1 lines' or 'grew by -1'", async () => {
  const fixture = await setupFixture();
  try {
    // Two files present when the (REFUTED) verdict was recorded.
    await writeFile(join(fixture.repo, "extra.txt"), "line\n".repeat(50));
    await makeNonTrivialDiff(fixture.repo);
    const { diffStat, diffFingerprint } = (await import(join(here, "..", "..", "dist", "hooks", "lib", "git-diff.js"))) as typeof import("./lib/git-diff.js");
    const { changedLines, changedFiles } = assertMeasured(await diffStat(fixture.repo, [], null));
    const hash = await diffFingerprint(fixture.repo);
    await seedVerifierState(fixture.home, "s1", {
      verdict: "REFUTED",
      criticalOrMajorCount: 1,
      findingsCount: 1,
      diffHash: hash,
      changedLines,
      changedFiles,
    });

    // One of the two files is removed (fileDelta negative), but the remaining file grows enough
    // to clear minChangedLines on its own (lineDelta positive) -- exactly the mixed-sign case
    // that used to render as "the file count grew by -1" and, for a lineDelta of -1, "-1 lines".
    await rm(join(fixture.repo, "extra.txt"));
    await writeFile(join(fixture.repo, "file.txt"), "changed line\n".repeat(300));

    const result = run(fixture, {
      session_id: "s1",
      cwd: fixture.repo,
      hook_event_name: "Stop",
    }) as { decision?: string; reason?: string };
    assert.equal(result.decision, "block");
    assert.match(result.reason ?? "", /stale — \d+ lines? changed and the file count shrank by 1 since it was recorded/);
    assert.doesNotMatch(result.reason ?? "", /grew by -/);
  } finally {
    await teardownFixture(fixture);
  }
});

test("a legacy CONFIRMED verdict — diffHash key entirely absent, not present-as-null — allows, unchanged", async () => {
  const fixture = await setupFixture();
  try {
    await makeNonTrivialDiff(fixture.repo);
    // No diffHash key at all — this is what a record written before this feature existed
    // actually looks like on disk. `diffHash: null` is a DIFFERENT, non-legacy case (see the
    // "unverifiable" test below): a record telemetry attempted and failed to fingerprint.
    await seedVerifierState(fixture.home, "s1", {
      verdict: "CONFIRMED",
      criticalOrMajorCount: 0,
      findingsCount: 0,
    });
    const result = run(fixture, {
      session_id: "s1",
      cwd: fixture.repo,
      hook_event_name: "Stop",
    }) as { decision?: string };
    assert.equal(result.decision, undefined);
  } finally {
    await teardownFixture(fixture);
  }
});

test("reverted work (negative delta) with a differing hash still allows", async () => {
  const fixture = await setupFixture();
  try {
    // Large non-trivial diff, recorded by the verifier.
    await writeFile(join(fixture.repo, "file.txt"), "changed line\n".repeat(100));
    const { diffStat, diffFingerprint } = (await import(join(here, "..", "..", "dist", "hooks", "lib", "git-diff.js"))) as typeof import("./lib/git-diff.js");
    const { changedLines, changedFiles } = assertMeasured(await diffStat(fixture.repo, [], null));
    const hash = await diffFingerprint(fixture.repo);
    await seedVerifierState(fixture.home, "s1", {
      verdict: "CONFIRMED",
      criticalOrMajorCount: 0,
      findingsCount: 0,
      diffHash: hash,
      changedLines,
      changedFiles,
    });

    // Some work reverted since the pass — still non-trivial, hash differs, but the delta versus
    // the recorded snapshot is negative, not >= threshold.
    await writeFile(join(fixture.repo, "file.txt"), "changed line\n".repeat(90));

    const result = run(fixture, {
      session_id: "s1",
      cwd: fixture.repo,
      hook_event_name: "Stop",
    }) as { decision?: string };
    assert.equal(result.decision, undefined);
  } finally {
    await teardownFixture(fixture);
  }
});


test("a record with diffHash explicitly null (telemetry attempted and failed to fingerprint) does NOT get the legacy free pass", async () => {
  const fixture = await setupFixture();
  try {
    await makeNonTrivialDiff(fixture.repo);
    // diffHash present but null, AND changedLines/changedFiles also null -- the worst case
    // (diffStat's own fingerprint attempt failed entirely). The delta compares against 0, so any
    // non-trivial current diff (guaranteed at this point in the gate) clears the threshold.
    await seedVerifierState(fixture.home, "s1", {
      verdict: "CONFIRMED",
      criticalOrMajorCount: 0,
      findingsCount: 0,
      diffHash: null,
      changedLines: null,
      changedFiles: null,
    });
    const result = run(fixture, {
      session_id: "s1",
      cwd: fixture.repo,
      hook_event_name: "Stop",
    }) as { decision?: string; reason?: string };
    assert.equal(result.decision, "block");
    assert.match(result.reason ?? "", /stale/);
  } finally {
    await teardownFixture(fixture);
  }
});

test("a stale REFUTED verdict is reported with its own verdict, not hardcoded CONFIRMED", async () => {
  const fixture = await setupFixture();
  try {
    await writeFile(join(fixture.repo, "file.txt"), "changed line\n".repeat(100));
    const { diffStat, diffFingerprint } = (await import(join(here, "..", "..", "dist", "hooks", "lib", "git-diff.js"))) as typeof import("./lib/git-diff.js");
    const { changedLines, changedFiles } = assertMeasured(await diffStat(fixture.repo, [], null));
    const hash = await diffFingerprint(fixture.repo);
    await seedVerifierState(fixture.home, "s1", {
      verdict: "REFUTED",
      criticalOrMajorCount: 1,
      findingsCount: 1,
      diffHash: hash,
      changedLines,
      changedFiles,
    });

    // Substantial further work -- clears minChangedLines (80) -- makes this ALSO stale, on top
    // of already being REFUTED.
    await writeFile(join(fixture.repo, "more-work.txt"), "line\n".repeat(100));

    const result = run(fixture, {
      session_id: "s1",
      cwd: fixture.repo,
      hook_event_name: "Stop",
    }) as { decision?: string; reason?: string };
    assert.equal(result.decision, "block");
    assert.match(result.reason ?? "", /\(REFUTED\) is stale/);
    assert.doesNotMatch(result.reason ?? "", /\(CONFIRMED\) is stale/);
  } finally {
    await teardownFixture(fixture);
  }
});

test("an unhashable current diff (patch fetch failed) is treated as unknown, not fresh -- blocks when the size delta clears the threshold", async () => {
  const fixture = await setupFixture();
  try {
    await makeNonTrivialDiff(fixture.repo);
    const { diffStat, diffFingerprint } = (await import(join(here, "..", "..", "dist", "hooks", "lib", "git-diff.js"))) as typeof import("./lib/git-diff.js");
    const { changedLines, changedFiles } = assertMeasured(await diffStat(fixture.repo, [], null));
    const hash = await diffFingerprint(fixture.repo);
    await seedVerifierState(fixture.home, "s1", {
      verdict: "CONFIRMED",
      criticalOrMajorCount: 0,
      findingsCount: 0,
      diffHash: hash,
      changedLines,
      changedFiles,
    });

    // Substantial further work -- clears minChangedLines (80).
    await writeFile(join(fixture.repo, "more-work.txt"), "line\n".repeat(100));

    await withFakeGitOnPath(async (fakeGitDir) => {
      const result = run(
        fixture,
        {
          session_id: "s1",
          cwd: fixture.repo,
          hook_event_name: "Stop",
        },
        { PATH: `${fakeGitDir}:${process.env["PATH"] ?? ""}` },
      ) as { decision?: string; reason?: string };
      assert.equal(result.decision, "block");
      assert.match(result.reason ?? "", /stale/);
    });
  } finally {
    await teardownFixture(fixture);
  }
});

test("an unhashable current diff still allows when the size delta stays below both thresholds", async () => {
  const fixture = await setupFixture();
  try {
    await makeNonTrivialDiff(fixture.repo);
    const { diffStat, diffFingerprint } = (await import(join(here, "..", "..", "dist", "hooks", "lib", "git-diff.js"))) as typeof import("./lib/git-diff.js");
    const { changedLines, changedFiles } = assertMeasured(await diffStat(fixture.repo, [], null));
    const hash = await diffFingerprint(fixture.repo);
    await seedVerifierState(fixture.home, "s1", {
      verdict: "CONFIRMED",
      criticalOrMajorCount: 0,
      findingsCount: 0,
      diffHash: hash,
      changedLines,
      changedFiles,
    });

    // Small post-review fixup -- stays under both thresholds.
    await writeFile(join(fixture.repo, "small-fixup.txt"), "one more line\n");

    await withFakeGitOnPath(async (fakeGitDir) => {
      const result = run(
        fixture,
        {
          session_id: "s1",
          cwd: fixture.repo,
          hook_event_name: "Stop",
        },
        { PATH: `${fakeGitDir}:${process.env["PATH"] ?? ""}` },
      ) as { decision?: string };
      assert.equal(result.decision, undefined);
    });
  } finally {
    await teardownFixture(fixture);
  }
});

test("a null current hash against a recorded null diffHash is still stale, not treated as matching -- kills the `currentHash === null ||` mutant", async () => {
  // Both sides of the equality are null here. `verifierHash !== currentHash` alone would read
  // `null !== null` as false and let the verdict pass -- deleting `currentHash === null ||` from
  // the stale condition survives the rest of the suite (round 4's finding) because every other
  // test either has a real currentHash or a real verifierHash, never both null at once.
  const fixture = await setupFixture();
  try {
    await makeNonTrivialDiff(fixture.repo);
    await seedVerifierState(fixture.home, "s1", {
      verdict: "CONFIRMED",
      criticalOrMajorCount: 0,
      findingsCount: 0,
      diffHash: null,
      changedLines: 0,
      changedFiles: 0,
    });

    await withFakeGitOnPath(async (fakeGitDir) => {
      const result = run(
        fixture,
        {
          session_id: "s1",
          cwd: fixture.repo,
          hook_event_name: "Stop",
        },
        { PATH: `${fakeGitDir}:${process.env["PATH"] ?? ""}` },
      ) as { decision?: string; reason?: string };
      assert.equal(result.decision, "block");
      assert.match(result.reason ?? "", /stale/);
    });
  } finally {
    await teardownFixture(fixture);
  }
});

// --- Fail-open visibility (issue #1, defect 3) -------------------------------------------------

test("the loop-guard fail-open is logged to the monthly JSONL", async () => {
  const fixture = await setupFixture();
  try {
    await makeNonTrivialDiff(fixture.repo);
    const stop = (active: boolean): unknown =>
      run(fixture, { session_id: "s1", cwd: fixture.repo, hook_event_name: "Stop", stop_hook_active: active });

    stop(true);
    stop(true);
    const failOpen = stop(true) as { decision?: string; systemMessage?: string };
    assert.equal(failOpen.decision, undefined);

    const log = await readMonthlyLog(fixture.home);
    const failOpenEntries = log.filter((r) => r["event"] === "verifyGateFailOpen");
    assert.equal(failOpenEntries.length, 1);
    assert.equal(failOpenEntries[0]?.["reason"], "loop-guard");
    assert.equal(failOpenEntries[0]?.["sessionId"], "s1");
  } finally {
    await teardownFixture(fixture);
  }
});

test("a verify-gate crash is logged to the monthly JSONL and surfaced via systemMessage", async () => {
  const fixture = await setupFixture();
  try {
    // Corrupt the session state file so readSessionState throws a real (non-ENOENT) error,
    // simulating a crash after the input has already been parsed (so sessionId is known).
    const stateDir = join(fixture.home, "state");
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "s1.json"), "{ not valid json");

    const result = run(fixture, {
      session_id: "s1",
      cwd: fixture.repo,
      hook_event_name: "Stop",
    }) as { decision?: string; systemMessage?: string };
    assert.equal(result.decision, undefined);
    assert.match(result.systemMessage ?? "", /verify-gate/i);

    const log = await readMonthlyLog(fixture.home);
    const failOpenEntries = log.filter((r) => r["event"] === "verifyGateFailOpen");
    assert.equal(failOpenEntries.length, 1);
    assert.equal(failOpenEntries[0]?.["reason"], "error");
    assert.equal(failOpenEntries[0]?.["sessionId"], "s1");
  } finally {
    await teardownFixture(fixture);
  }
});

// --- Cycle-total backstop (round-2 critical: churn defeats the per-diff counter) ---------------

test("under continuous tree churn between every round, an unsatisfiable gate still terminates in a bounded fail-open", async () => {
  const fixture = await setupFixture();
  try {
    let last: { decision?: string; systemMessage?: string } = {};
    let rounds = 0;
    // A different file touched before every single round -- the per-diff counter
    // (verifyGateConsecutiveBlocks) resets on every one of these, since the tree has moved. Only
    // the never-reset-by-tree-movement cycle counter can terminate this.
    for (; rounds < 20; rounds += 1) {
      await writeFile(join(fixture.repo, `churn-${rounds}.txt`), "line\n".repeat(200));
      last = run(fixture, {
        session_id: "s1",
        cwd: fixture.repo,
        hook_event_name: "Stop",
        stop_hook_active: true,
      }) as { decision?: string; systemMessage?: string };
      if (last.decision === undefined) break;
    }
    // MAX_CYCLE_BLOCKS is 5 -- the gate must fail open well before 20 rounds of continuous churn.
    assert.ok(rounds < 10, `expected a bounded fail-open, but the gate blocked through ${rounds} rounds`);
    assert.equal(last.decision, undefined);
    assert.match(last.systemMessage ?? "", /failing open/);
    assert.match(last.systemMessage ?? "", /cycle/i);
  } finally {
    await teardownFixture(fixture);
  }
});

test("the two fail-open reasons -- consecutive-block and per-cycle ceiling -- are distinguishable in the message and the JSONL row", async () => {
  const fixture = await setupFixture();
  try {
    // Consecutive-block fail-open: same diff, unchanged, throughout.
    await makeNonTrivialDiff(fixture.repo);
    const stopSame = (): { decision?: string; systemMessage?: string } =>
      run(fixture, {
        session_id: "s1",
        cwd: fixture.repo,
        hook_event_name: "Stop",
        stop_hook_active: true,
      }) as { decision?: string; systemMessage?: string };
    stopSame();
    stopSame();
    const consecutiveFailOpen = stopSame();
    assert.equal(consecutiveFailOpen.decision, undefined);
    assert.match(consecutiveFailOpen.systemMessage ?? "", /unchanged diff/);

    // Fresh session: per-cycle ceiling fail-open under continuous churn.
    for (let i = 0; i < 6; i += 1) {
      await writeFile(join(fixture.repo, `churn2-${i}.txt`), "line\n".repeat(200));
      run(fixture, {
        session_id: "s2",
        cwd: fixture.repo,
        hook_event_name: "Stop",
        stop_hook_active: true,
      });
    }
    await writeFile(join(fixture.repo, "churn2-last.txt"), "line\n".repeat(200));
    const cycleFailOpen = run(fixture, {
      session_id: "s2",
      cwd: fixture.repo,
      hook_event_name: "Stop",
      stop_hook_active: true,
    }) as { decision?: string; systemMessage?: string };
    assert.equal(cycleFailOpen.decision, undefined);
    assert.match(cycleFailOpen.systemMessage ?? "", /cycle ceiling/);

    const log = await readMonthlyLog(fixture.home);
    const reasons = new Set(
      log.filter((r) => r["event"] === "verifyGateFailOpen").map((r) => r["reason"]),
    );
    assert.ok(reasons.has("loop-guard"), "expected a plain loop-guard fail-open reason");
    assert.ok(reasons.has("loop-guard-cycle"), "expected a loop-guard-cycle fail-open reason");
  } finally {
    await teardownFixture(fixture);
  }
});

// --- Issue #2: diffStat null-on-failure -----------------------------------------------------

test(
  "original repro: a FIFO replacing a tracked file plus a genuine large change elsewhere blocks with the could-not-measure message, not a silent allow",
  { skip: hasMkfifo ? false : mkfifoSkipReason },
  async () => {
    const fixture = await setupFixture();
    try {
      const realChangePath = join(fixture.repo, "real-change.txt");
      const victimPath = join(fixture.repo, "victim.txt");
      await writeFile(realChangePath, "line\n".repeat(5));
      await writeFile(victimPath, "line\n".repeat(5));
      execFileSync("git", ["add", "."], { cwd: fixture.repo });
      execFileSync("git", ["commit", "-q", "-m", "add fixture files"], { cwd: fixture.repo });

      // A genuine, sizeable change -- pre-fix, this used to be reported as zeros once the FIFO
      // below made the whole numstat probe fail, and verify-gate allowed with no verdict on record.
      await writeFile(realChangePath, "changed line\n".repeat(500));

      await rm(victimPath);
      execFileSync("mkfifo", [victimPath]);

      const result = run(fixture, {
        session_id: "s1",
        cwd: fixture.repo,
        hook_event_name: "Stop",
      }) as { decision?: string; reason?: string };

      assert.equal(result.decision, "block", "an unmeasurable diff must never silently allow");
      assert.match(result.reason ?? "", /could not be measured/);
    } finally {
      await teardownFixture(fixture);
    }
  },
);

test("a non-git cwd still allows a trivial-reading diff -- {0, 0} stays fail-open, unaffected by the null contract", async () => {
  const repo = await mkdtemp(join(tmpdir(), "praxarch-verifygate-nogit-"));
  const home = await mkdtemp(join(tmpdir(), "praxarch-verifygate-nogit-home-"));
  const fixture: Fixture = { repo, home };
  try {
    const result = run(fixture, {
      session_id: "s1",
      cwd: fixture.repo,
      hook_event_name: "Stop",
    }) as { decision?: string };
    assert.equal(result.decision, undefined, "a cwd that isn't a git repo has nothing to gate on and must allow");
  } finally {
    await teardownFixture(fixture);
  }
});

test("a numstat failure in a real repo (not a FIFO, not a non-repo cwd) also blocks with the could-not-measure message", async () => {
  const fixture = await setupFixture();
  try {
    await makeNonTrivialDiff(fixture.repo);
    await withFakeGitOnPathFailingNumstat(async (fakeGitDir) => {
      const result = run(
        fixture,
        { session_id: "s1", cwd: fixture.repo, hook_event_name: "Stop" },
        { PATH: `${fakeGitDir}:${process.env["PATH"] ?? ""}` },
      ) as { decision?: string; reason?: string };
      assert.equal(result.decision, "block");
      assert.match(result.reason ?? "", /could not be measured/);
    });
  } finally {
    await teardownFixture(fixture);
  }
});
