import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiffCounts } from "./lib/git-diff.js";
import type { getMkfifoProbe as GetMkfifoProbe } from "./lib/fixtures/mkfifo-probe.js";
import { TEST_DIST_DIR } from "../test-support/dist-dir.js";

const script = join(TEST_DIST_DIR, "hooks", "verify-gate.js");
const sessionInitScript = join(TEST_DIST_DIR, "hooks", "session-init.js");
const telemetryScript = join(TEST_DIST_DIR, "hooks", "telemetry.js");
const cli = join(TEST_DIST_DIR, "cli", "index.js");

// `which mkfifo` proves only that the binary is on PATH, not that mkfifo(2) actually works here
// -- a sandboxed CI runner can ship the binary while refusing the syscall. The FIFO-based
// end-to-end test below shares the same functional-probe implementation as git-diff.test.ts (see
// lib/fixtures/mkfifo-probe.ts) rather than duplicating a weaker guard. Resolved through
// TEST_DIST_DIR (not a hardcoded "dist" segment) so it comes from the scratch tree under
// `pnpm verify`, same as every other compiled-output import here — a bare ".ts" specifier fails
// tsc (TS5097) since this project emits, and the sibling fixtures/*-runner.ts files are already
// executed from compiled output the same way. `node --test` runs each test file in its own child
// process, so this file's probe call is its own cached-once execution, separate from
// git-diff.test.ts's -- still "once per process, not once per test" per file, just not shared
// across files.
const { getMkfifoProbe } = (await import(
  join(TEST_DIST_DIR, "hooks", "lib", "fixtures", "mkfifo-probe.js")
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

// Drives the real SessionStart hook so the untracked snapshot is written through the same code
// path production uses (`captureUntrackedBaseline` -> `writeUntrackedBaseline`), rather than the
// test hand-building the sidecar file and having to know its key format.
function runSessionInit(fixture: Fixture, sessionId: string): void {
  execFileSync("node", [sessionInitScript], {
    cwd: fixture.repo,
    input: JSON.stringify({
      session_id: sessionId,
      cwd: fixture.repo,
      hook_event_name: "SessionStart",
      source: "startup",
    }),
    env: { ...process.env, PRAXARCH_HOME: fixture.home },
  });
}

// Drives the real PostToolUse(Agent) hook so a checker-sourced lastVerifier record is written
// through the same code path production uses (telemetry.ts's extractTrailingJson/summarizeVerdict),
// rather than the test hand-seeding the state file's lastVerifier shape.
function runTelemetryVerdict(
  fixture: Fixture,
  sessionId: string,
  role: string,
  verdict: "CONFIRMED" | "REFUTED",
  findings: { severity: string; file: string; line: number; summary: string; failure_scenario: string }[] = [],
): void {
  const text = ["```json", JSON.stringify({ verdict, findings }), "```"].join("\n");
  execFileSync("node", [telemetryScript], {
    cwd: fixture.repo,
    input: JSON.stringify({
      session_id: sessionId,
      cwd: fixture.repo,
      hook_event_name: "PostToolUse",
      tool_name: "Agent",
      tool_input: { subagent_type: role, model: "sonnet" },
      tool_response: { status: "completed", content: [{ type: "text", text }] },
    }),
    env: { ...process.env, PRAXARCH_HOME: fixture.home },
  });
}

function verifierText(verdict: "CONFIRMED" | "REFUTED", findings: { severity: string }[] = []): string {
  return ["Some prose the resumed agent wrote before its verdict.", "```json", JSON.stringify({ verdict, findings }), "```"].join(
    "\n",
  );
}

// Real `praxarch record-verdict` invocation -- same reasoning as sessionInit above: the test must
// never have to know the untracked snapshot's on-disk key format, only that the recorded counts
// come out snapshot-aware.
function runRecordVerdict(fixture: Fixture, sessionId: string, text: string): { stdout: string; stderr: string; status: number } {
  const result = spawnSync("node", [cli, "record-verdict", "--session", sessionId, "--role", "verifier"], {
    cwd: fixture.repo,
    input: text,
    env: { ...process.env, PRAXARCH_HOME: fixture.home },
  });
  return {
    stdout: result.stdout?.toString("utf8") ?? "",
    stderr: result.stderr?.toString("utf8") ?? "",
    status: result.status ?? 1,
  };
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// issue #14 Part B: the block reason names the ref/branch this gate was built from — the compiled
// script under test ships with a real dist/hooks/build-info.json (written by `pnpm build`), so
// this exercises the actual read path, not a mock.
//
// CI checks this repo out detached, so build-info.json's `branch` is genuinely null there (a
// correct degrade, per build-info.test.ts's own detached-HEAD coverage) -- asserting a single
// permissive regex over "some rendering or other" would hide a regression in the interpolation.
// Instead this reads the real build-info.json alongside the compiled hook and asserts the exact
// shape formatBuildRef is documented to produce for whichever case is actually live: a named
// branch renders "branch@shortref", detached HEAD renders the bare short ref, either optionally
// suffixed " (dirty)".
test("a block names the git ref this gate was built from", async () => {
  const fixture = await setupFixture();
  try {
    await makeNonTrivialDiff(fixture.repo);
    const result = run(fixture, {
      session_id: "s1",
      cwd: fixture.repo,
      hook_event_name: "Stop",
    }) as { decision?: string; reason?: string };
    assert.equal(result.decision, "block");

    const buildInfo = JSON.parse(
      await readFile(join(TEST_DIST_DIR, "hooks", "build-info.json"), "utf8"),
    ) as { ref: string | null; branch: string | null; dirty: boolean | null };
    assert.ok(buildInfo.ref, "the compiled hook under test must ship a real build-info.json ref to assert against");
    const shortRef = buildInfo.ref.slice(0, 12);
    const dirtySuffix = buildInfo.dirty ? " (dirty)" : "";
    const expected = buildInfo.branch ? `${buildInfo.branch}@${shortRef}${dirtySuffix}` : `${shortRef}${dirtySuffix}`;
    assert.match(result.reason ?? "", new RegExp(`\\[praxarch built from ${escapeRegExp(expected)}\\]$`));
  } finally {
    await teardownFixture(fixture);
  }
});

// The stamp is a block-only diagnostic, not printed on every hook invocation — an allow must
// never carry it. Asserted against the whole serialized output, not just systemMessage: a
// regression that surfaced the suffix through hookSpecificOutput.additionalContext instead would
// pass unnoticed against systemMessage alone (it's undefined on a below-threshold allow, so
// `?? ""` made the old assertion trivially true regardless of where a leak showed up).
test("an allow never carries the build-ref suffix", async () => {
  const fixture = await setupFixture();
  try {
    await writeFile(join(fixture.repo, "file.txt"), "line\n".repeat(6));
    const result = run(fixture, {
      session_id: "s1",
      cwd: fixture.repo,
      hook_event_name: "Stop",
    }) as Record<string, unknown>;
    assert.equal(result["decision"], undefined);
    assert.doesNotMatch(JSON.stringify(result), /praxarch built from/);
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

// Issue #21 AC1: a checker-sourced verdict must satisfy verify-gate end-to-end, not just parse
// into session state in isolation -- drives the real telemetry.ts PostToolUse hook (subagent_type
// "checker") and then the real verify-gate.ts Stop hook against the state it wrote.
test("allows a non-trivial diff with a CONFIRMED checker record (end-to-end via telemetry hook)", async () => {
  const fixture = await setupFixture();
  try {
    await makeNonTrivialDiff(fixture.repo);
    runTelemetryVerdict(fixture, "s1", "checker", "CONFIRMED");
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

test("blocks a non-trivial diff with a REFUTED checker record (end-to-end via telemetry hook)", async () => {
  const fixture = await setupFixture();
  try {
    await makeNonTrivialDiff(fixture.repo);
    runTelemetryVerdict(fixture, "s1", "checker", "REFUTED", [
      { severity: "critical", file: "a.ts", line: 1, summary: "x", failure_scenario: "y" },
    ]);
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

// The waiver must START a line (WAIVER_PATTERN is ^-anchored, multiline) — see the new mid-sentence case below.
test("an explicit waiver in the final message bypasses the gate", async () => {
  const fixture = await setupFixture();
  try {
    await makeNonTrivialDiff(fixture.repo);
    const result = run(fixture, {
      session_id: "s1",
      cwd: fixture.repo,
      hook_event_name: "Stop",
      last_assistant_message: "Docs-only change.\nPRAXARCH_VERIFY_WAIVED: no behavior change, docs only.",
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
    const { diffStat, diffFingerprint } = (await import(join(TEST_DIST_DIR, "hooks", "lib", "git-diff.js"))) as typeof import("./lib/git-diff.js");
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
    const { diffStat, diffFingerprint } = (await import(join(TEST_DIST_DIR, "hooks", "lib", "git-diff.js"))) as typeof import("./lib/git-diff.js");
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
    const { diffStat, diffFingerprint } = (await import(join(TEST_DIST_DIR, "hooks", "lib", "git-diff.js"))) as typeof import("./lib/git-diff.js");
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
    const { diffStat, diffFingerprint } = (await import(join(TEST_DIST_DIR, "hooks", "lib", "git-diff.js"))) as typeof import("./lib/git-diff.js");
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
    const { diffStat, diffFingerprint } = (await import(join(TEST_DIST_DIR, "hooks", "lib", "git-diff.js"))) as typeof import("./lib/git-diff.js");
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
    const { diffStat, diffFingerprint } = (await import(join(TEST_DIST_DIR, "hooks", "lib", "git-diff.js"))) as typeof import("./lib/git-diff.js");
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
    const { diffStat, diffFingerprint } = (await import(join(TEST_DIST_DIR, "hooks", "lib", "git-diff.js"))) as typeof import("./lib/git-diff.js");
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
    const { diffStat, diffFingerprint } = (await import(join(TEST_DIST_DIR, "hooks", "lib", "git-diff.js"))) as typeof import("./lib/git-diff.js");
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
    const { diffStat, diffFingerprint } = (await import(join(TEST_DIST_DIR, "hooks", "lib", "git-diff.js"))) as typeof import("./lib/git-diff.js");
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
    // The session state *path* is a directory, so readSessionState's readFile hits EISDIR -- a
    // genuine (non-ENOENT) environment failure that still throws per issue #atomic-state-writes:
    // that fix quarantines corrupt *content* (unparseable/wrong-shaped JSON) instead of throwing,
    // so a truncated/malformed file can no longer stand in for "readSessionState throws" here.
    const stateDir = join(fixture.home, "state");
    await mkdir(join(stateDir, "s1.json"), { recursive: true });

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

// Task 5: end-to-end proof that verify-gate reads the SessionStart untracked snapshot from its
// sidecar store (not from state -- the field it once lived in, `state.baselineUntracked`, was
// removed for the hot-path reasons in untracked-baseline-store.ts) and uses it to stop charging
// pre-existing untracked content to the session. Driven through the real compiled hooks
// (session-init.js then verify-gate.js) so the test never has to know the snapshot's on-disk key
// format -- only dist/hooks/untracked.js and dist/hooks/untracked-baseline-store.js do.
test("verify-gate's untracked baseline snapshot: a pre-existing untracked file is excluded, the same file created after session-init is not (one pair, both directions)", async () => {
  const before = await setupFixture();
  const after = await setupFixture();
  try {
    // Direction 1: plan.md exists BEFORE session-init runs -- it is in the SessionStart snapshot,
    // so it must not count.
    await writeFile(join(before.repo, "plan.md"), "line\n".repeat(120));
    runSessionInit(before, "s1");
    const allowResult = run(before, { session_id: "s1", cwd: before.repo, hook_event_name: "Stop" }) as {
      decision?: string;
    };
    assert.equal(allowResult.decision, undefined, "a pre-existing untracked file must not be charged to the session");

    // Direction 2: plan.md is written AFTER session-init runs -- absent from the snapshot, so it
    // is genuinely new session work and must still count in full.
    runSessionInit(after, "s2");
    await writeFile(join(after.repo, "plan.md"), "line\n".repeat(120));
    const blockResult = run(after, { session_id: "s2", cwd: after.repo, hook_event_name: "Stop" }) as {
      decision?: string;
      reason?: string;
    };
    assert.equal(blockResult.decision, "block");
    assert.match(blockResult.reason ?? "", /changed 12\d lines/);
  } finally {
    await teardownFixture(before);
    await teardownFixture(after);
  }
});

// Task 5, acceptance criterion 2: the issue's "real severity" claim was that the inflated counts
// land in the RECORD, not just in the block message -- prove that at the record.
test("record-verdict's recorded changedLines/changedFiles are snapshot-aware, not inflated by a pre-existing untracked file", async () => {
  const fixture = await setupFixture();
  try {
    await writeFile(join(fixture.repo, "plan.md"), "line\n".repeat(120));
    runSessionInit(fixture, "s1");

    // A genuine, small tracked change -- the only thing the recorded counts should reflect.
    // file.txt starts as "line\n" x5 (setupFixture); a full-content replacement with 6 differing
    // lines shows up in `git diff --numstat` as 5 deletions + 6 insertions = 11, matching the
    // formula record-verdict.test.ts's own equivalent assertion uses.
    await writeFile(join(fixture.repo, "file.txt"), "changed line\n".repeat(6));

    const result = runRecordVerdict(fixture, "s1", verifierText("CONFIRMED"));
    assert.equal(result.status, 0, result.stderr);

    const state = await readState(fixture.home, "s1");
    const lastVerifier = state["lastVerifier"] as { changedLines: number | null; changedFiles: number | null };
    assert.equal(lastVerifier.changedFiles, 1, "the pre-existing untracked plan.md must not inflate the recorded file count");
    assert.equal(lastVerifier.changedLines, 11, "the pre-existing untracked plan.md must not inflate the recorded line count");
  } finally {
    await teardownFixture(fixture);
  }
});

// A real bare remote and clone, matching git-diff.test.ts's `makeBareRemoteWithClone` fixture
// shape exactly -- this is the only way `refs/remotes/origin/HEAD` gets set the way
// `resolveEffectiveBaseline` depends on for sub-case B.
async function makeBareRemoteWithClone(prefix: string): Promise<{ bare: string; seed: string; session: string }> {
  const bare = await mkdtemp(join(tmpdir(), `praxarch-verifygate-${prefix}-bare-`));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);

  const seed = await mkdtemp(join(tmpdir(), `praxarch-verifygate-${prefix}-seed-`));
  execFileSync("git", ["init", "-q", "-b", "main", seed]);
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: seed });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: seed });
  await writeFile(join(seed, "base.txt"), "base\n");
  execFileSync("git", ["add", "."], { cwd: seed });
  execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: seed });
  execFileSync("git", ["remote", "add", "origin", bare], { cwd: seed });
  execFileSync("git", ["push", "-q", "-u", "origin", "main"], { cwd: seed });

  const session = await mkdtemp(join(tmpdir(), `praxarch-verifygate-${prefix}-session-`));
  execFileSync("git", ["clone", "-q", bare, session]);
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: session });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: session });

  return { bare, seed, session };
}

// Task 8: the issue's headline symptom, reproduced and pinned end-to-end at the hook level.
// Observed report: 382/6 -> 539/16 purely from a `git pull` of already-verified upstream work,
// invalidating a standing verdict it had no business invalidating.
test("verify-gate sub-case B: a standing verdict survives a fast-forward pull of already-reviewed work, but still goes stale on genuinely new local work", async () => {
  const { bare, seed, session } = await makeBareRemoteWithClone("subcaseb");
  const home = await mkdtemp(join(tmpdir(), "praxarch-verifygate-subcaseb-home-"));
  const fixture: Fixture = { repo: session, home };
  try {
    // Step 1: session baseline B on the clone, then a genuine ~100-line local change, recorded as
    // a CONFIRMED verdict via the real record-verdict path (not hand-built state).
    runSessionInit(fixture, "s1");
    await writeFile(join(session, "local-work.txt"), "local\n".repeat(100));
    const recordResult = runRecordVerdict(fixture, "s1", verifierText("CONFIRMED"));
    assert.equal(recordResult.status, 0, recordResult.stderr);

    // Step 2: verify-gate allows -- the verdict was just recorded against the current tree.
    const afterRecord = run(fixture, { session_id: "s1", cwd: session, hook_event_name: "Stop" }) as {
      decision?: string;
    };
    assert.equal(afterRecord.decision, undefined, "a freshly recorded verdict must allow immediately");

    // Step 3: a ~160-line change is pushed from a second clone and pulled into the fixture repo,
    // moving HEAD and necessarily changing the fingerprint.
    await writeFile(join(seed, "upstream.txt"), "upstream\n".repeat(160));
    execFileSync("git", ["add", "."], { cwd: seed });
    execFileSync("git", ["commit", "-q", "-m", "already reviewed, merged upstream"], { cwd: seed });
    execFileSync("git", ["push", "-q", "origin", "main"], { cwd: seed });
    execFileSync("git", ["pull", "-q", "--ff-only", "origin", "main"], { cwd: session });

    // Step 4: verify-gate still allows -- the size delta from the effective baseline is ~0, so the
    // pull does not invalidate the standing verdict. Assert no "is stale" text at all.
    const afterPull = run(fixture, { session_id: "s1", cwd: session, hook_event_name: "Stop" }) as {
      decision?: string;
      reason?: string;
    };
    assert.equal(afterPull.decision, undefined, JSON.stringify(afterPull));
    assert.doesNotMatch(afterPull.reason ?? "", /is stale/);

    // Step 5: negative control -- a further ~100-line LOCAL change after the pull must still go
    // stale and block. Without this, step 4 would also pass for a gate that never expires
    // anything at all.
    await writeFile(join(session, "local-work-2.txt"), "more local\n".repeat(100));
    const afterLocalChange = run(fixture, { session_id: "s1", cwd: session, hook_event_name: "Stop" }) as {
      decision?: string;
      reason?: string;
    };
    assert.equal(afterLocalChange.decision, "block");
    assert.match(afterLocalChange.reason ?? "", /is stale/);
  } finally {
    await rm(bare, { recursive: true, force: true });
    await rm(seed, { recursive: true, force: true });
    await rm(session, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

// --- Issue #23: measurement anchor -------------------------------------------------------------

// Runs the compiled hook with an explicit cwd that is NOT necessarily `fixture.repo` -- the shape
// needed to simulate a hook/CLI invocation whose shell has `cd`'d somewhere other than where the
// session's baselines live.
function runAt(home: string, cwd: string, input: unknown): unknown {
  const stdout = execFileSync("node", [script], {
    cwd,
    input: JSON.stringify(input),
    env: { ...process.env, PRAXARCH_HOME: home },
  }).toString("utf8");
  return JSON.parse(stdout);
}

async function makeRepo(prefix: string): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), `praxarch-verifygate-${prefix}-`));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  await writeFile(join(repo, "file.txt"), "line\n".repeat(5));
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });
  return repo;
}

// Drives the real SessionStart hook with an explicit cwd (mirrors runSessionInit above, but that
// helper hardcodes fixture.repo as both the anchor cwd and PRAXARCH_HOME source).
function runSessionInitAt(home: string, cwd: string, sessionId: string): void {
  execFileSync("node", [sessionInitScript], {
    cwd,
    input: JSON.stringify({ session_id: sessionId, cwd, hook_event_name: "SessionStart", source: "startup" }),
    env: { ...process.env, PRAXARCH_HOME: home },
  });
}

// This pair is the issue's acceptance evidence: the second half (negative control) fails only
// while the first half passes if the anchor is actually doing the measurement work, not just
// present in the state file.
test("issue #23: verify-gate measures the session's anchored cwd, not the hook's current cwd", async () => {
  const home = await mkdtemp(join(tmpdir(), "praxarch-verifygate-anchor-home-"));
  const repoA = await makeRepo("anchor-a");
  const repoB = await makeRepo("anchor-b");
  try {
    // session-init runs in A (clean tree) -- this is where the anchor is recorded.
    runSessionInitAt(home, repoA, "s1");

    // B has a large uncommitted change, well past minChangedLines (80).
    await writeFile(join(repoB, "big.txt"), "line\n".repeat(200));

    // A gate run with cwd: B must still measure A (clean) and allow.
    const allowResult = runAt(home, repoB, { session_id: "s1", cwd: repoB, hook_event_name: "Stop" }) as {
      decision?: string;
    };
    assert.equal(
      allowResult.decision,
      undefined,
      `expected an allow (measuring anchored A, not cwd B): ${JSON.stringify(allowResult)}`,
    );

    // Negative control: strip the anchor from state (simulating a legacy session) and re-run the
    // identical B-cwd gate call -- this must now block, citing B's real line count, proving the
    // first result came from the anchor doing real work rather than some unrelated allow path.
    const statePath = join(home, "state", "s1.json");
    const state = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
    delete state["baselineCwd"];
    await writeFile(statePath, JSON.stringify(state), "utf8");

    const blockResult = runAt(home, repoB, { session_id: "s1", cwd: repoB, hook_event_name: "Stop" }) as {
      decision?: string;
      reason?: string;
    };
    assert.equal(blockResult.decision, "block", JSON.stringify(blockResult));
    assert.match(blockResult.reason ?? "", /changed \d+ lines across \d+ files/);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(repoA, { recursive: true, force: true });
    await rm(repoB, { recursive: true, force: true });
  }
});

test("issue #23: a dead anchor (recorded directory removed) blocks with the unmeasurable-anchor message, never falls back to the hook cwd", async () => {
  const home = await mkdtemp(join(tmpdir(), "praxarch-verifygate-deadanchor-home-"));
  const repoA = await mkdtemp(join(tmpdir(), "praxarch-verifygate-deadanchor-a-"));
  const repoB = await makeRepo("deadanchor-b");
  try {
    execFileSync("git", ["init", "-q"], { cwd: repoA });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoA });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repoA });
    await writeFile(join(repoA, "file.txt"), "line\n");
    execFileSync("git", ["add", "."], { cwd: repoA });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoA });

    runSessionInitAt(home, repoA, "s1");
    // A trivial change in B -- if the gate ever fell back to measuring B, this would allow. The
    // dead-anchor path must block regardless of B's own diff size.
    await writeFile(join(repoB, "file.txt"), "line\n".repeat(6));

    // Delete the anchor directory itself -- the state still names it, but it's now unreachable.
    await rm(repoA, { recursive: true, force: true });

    const result = runAt(home, repoB, { session_id: "s1", cwd: repoB, hook_event_name: "Stop" }) as {
      decision?: string;
      reason?: string;
    };
    assert.equal(result.decision, "block", JSON.stringify(result));
    assert.match(result.reason ?? "", /baseline directory .* is missing or unusable/);
    assert.doesNotMatch(result.reason ?? "", /changed \d+ lines across \d+ files/);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(repoB, { recursive: true, force: true });
  }
});

test("issue #23: record-verdict records the anchored repo's counts, not the CLI's own cwd", async () => {
  const home = await mkdtemp(join(tmpdir(), "praxarch-verifygate-recordverdict-anchor-home-"));
  const repoA = await makeRepo("rv-anchor-a");
  const repoB = await makeRepo("rv-anchor-b");
  try {
    // A is clean; the anchor is recorded there.
    runSessionInitAt(home, repoA, "s1");

    // B has a large uncommitted change.
    await writeFile(join(repoB, "big.txt"), "line\n".repeat(200));

    const result = spawnSync("node", [cli, "record-verdict", "--session", "s1", "--role", "verifier"], {
      cwd: repoB,
      input: verifierText("CONFIRMED"),
      env: { ...process.env, PRAXARCH_HOME: home },
    });
    assert.equal(result.status, 0, result.stderr?.toString("utf8"));

    const state = JSON.parse(await readFile(join(home, "state", "s1.json"), "utf8")) as {
      lastVerifier?: { changedLines?: number | null; changedFiles?: number | null } | null;
    };
    assert.equal(state.lastVerifier?.changedLines, 0, JSON.stringify(state.lastVerifier));
    assert.equal(state.lastVerifier?.changedFiles, 0, JSON.stringify(state.lastVerifier));
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(repoA, { recursive: true, force: true });
    await rm(repoB, { recursive: true, force: true });
  }
});

// MAJOR 2 (verifier refutation): a session anchored to a plain, non-repo directory that then does
// real work inside a real git repo (the shell `cd`'d in) must not launder that work through
// `diffStat`'s own `{0, 0}`-on-non-repo allow -- the gate must block, citing the repo's own line
// count, exactly as an unanchored gate would.
test("issue #23 / MAJOR 2: anchor is a non-repo directory, hook cwd IS a repo with real changes -> BLOCKS (never launders through {0,0})", async () => {
  const home = await mkdtemp(join(tmpdir(), "praxarch-verifygate-nonrepoanchor-home-"));
  const nonRepoAnchor = await mkdtemp(join(tmpdir(), "praxarch-verifygate-nonrepoanchor-a-"));
  const repoB = await makeRepo("nonrepoanchor-b");
  try {
    // session-init runs in a directory that is never a git repo -- the anchor itself is
    // recorded, but it names a non-repo path.
    runSessionInitAt(home, nonRepoAnchor, "s1");

    // B is a real repo with a large uncommitted change, well past minChangedLines (80).
    await writeFile(join(repoB, "big.txt"), "line\n".repeat(200));

    const result = runAt(home, repoB, { session_id: "s1", cwd: repoB, hook_event_name: "Stop" }) as {
      decision?: string;
      reason?: string;
    };
    assert.equal(result.decision, "block", JSON.stringify(result));
    assert.match(result.reason ?? "", /baseline directory .* is missing or unusable/);
    assert.doesNotMatch(result.reason ?? "", /changed \d+ lines across \d+ files/);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(nonRepoAnchor, { recursive: true, force: true });
    await rm(repoB, { recursive: true, force: true });
  }
});

// The benign carve-out: a session that never enters a repo at all -- anchor and hook cwd both
// non-repo directories -- keeps today's {0,0}-allow behavior rather than becoming an unwaivable
// permanent block for a session that did nothing gate-relevant.
test("issue #23 / MAJOR 2: anchor is a non-repo directory, hook cwd is ALSO not a repo -> allows (benign, preserves {0,0})", async () => {
  const home = await mkdtemp(join(tmpdir(), "praxarch-verifygate-nonrepoboth-home-"));
  const nonRepoAnchor = await mkdtemp(join(tmpdir(), "praxarch-verifygate-nonrepoboth-a-"));
  const nonRepoHookCwd = await mkdtemp(join(tmpdir(), "praxarch-verifygate-nonrepoboth-b-"));
  try {
    runSessionInitAt(home, nonRepoAnchor, "s1");

    const result = runAt(home, nonRepoHookCwd, {
      session_id: "s1",
      cwd: nonRepoHookCwd,
      hook_event_name: "Stop",
    }) as { decision?: string };
    assert.equal(result.decision, undefined, JSON.stringify(result));
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(nonRepoAnchor, { recursive: true, force: true });
    await rm(nonRepoHookCwd, { recursive: true, force: true });
  }
});

// Regression pin: a corrupt state file used to throw out of main() into the crash handler, which
// emits an allow — a permanent, silent gate disable for the rest of that session.
test("a corrupt session-state file blocks (fails closed) instead of crash-failing open", async () => {
  const fixture = await setupFixture();
  try {
    await makeNonTrivialDiff(fixture.repo);
    await mkdir(join(fixture.home, "state"), { recursive: true });
    await writeFile(join(fixture.home, "state", "sCorrupt.json"), '{"sessionId":"sCorrupt","delegations":[');

    const result = run(fixture, {
      session_id: "sCorrupt",
      cwd: fixture.repo,
      hook_event_name: "Stop",
    }) as { decision?: string };
    assert.equal(result.decision, "block");

    const log = await readMonthlyLog(fixture.home).catch(() => []);
    assert.equal(
      log.filter((r) => r["event"] === "verifyGateFailOpen" && r["reason"] === "error").length,
      0,
      "a corrupt state file must not produce a crash fail-open row",
    );
  } finally {
    await teardownFixture(fixture);
  }
});

test("a waiver quoted mid-sentence does not waive the gate", async () => {
  const fixture = await setupFixture();
  try {
    await makeNonTrivialDiff(fixture.repo);
    const result = run(fixture, {
      session_id: "s1",
      cwd: fixture.repo,
      hook_event_name: "Stop",
      last_assistant_message: 'I was told to state "PRAXARCH_VERIFY_WAIVED: <reason>" if verification doesn\'t apply.',
    }) as { decision?: string };
    assert.equal(result.decision, "block");
  } finally {
    await teardownFixture(fixture);
  }
});

test("a CONFIRMED verdict with a capitalised critical finding still blocks", async () => {
  const fixture = await setupFixture();
  try {
    await makeNonTrivialDiff(fixture.repo);
    runTelemetryVerdict(fixture, "sSev", "verifier", "CONFIRMED", [
      { severity: "Critical", file: "f.ts", line: 1, summary: "s", failure_scenario: "x" },
    ]);
    const result = run(fixture, { session_id: "sSev", cwd: fixture.repo, hook_event_name: "Stop" }) as {
      decision?: string;
    };
    assert.equal(result.decision, "block");
  } finally {
    await teardownFixture(fixture);
  }
});
