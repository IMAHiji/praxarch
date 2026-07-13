import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "..", "..", "dist", "hooks", "verify-gate.js");

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
  verifier: { verdict: string; criticalOrMajorCount: number; findingsCount: number } | null,
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

