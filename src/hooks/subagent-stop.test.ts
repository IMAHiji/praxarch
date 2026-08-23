import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { TEST_DIST_DIR } from "../test-support/dist-dir.js";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(TEST_DIST_DIR, "hooks", "subagent-stop.js");
const sessionInitScript = join(TEST_DIST_DIR, "hooks", "session-init.js");

async function withPraxarchHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "praxarch-subagent-stop-"));
  try {
    return await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function run(home: string, input: unknown): { status: number | null } {
  try {
    execFileSync("node", [script], {
      input: JSON.stringify(input),
      env: { ...process.env, PRAXARCH_HOME: home },
    });
    return { status: 0 };
  } catch (err) {
    return { status: (err as { status?: number }).status ?? null };
  }
}

function verdictText(verdict: "CONFIRMED" | "REFUTED"): string {
  return ["```json", JSON.stringify({ verdict, findings: [] }), "```"].join("\n");
}

async function readState(home: string, sessionId: string): Promise<Record<string, unknown>> {
  const statePath = join(home, "state", `${sessionId}.json`);
  return JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
}

async function readMonthlyLog(home: string): Promise<Record<string, unknown>[]> {
  const now = new Date();
  const path = join(home, "logs", `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}.jsonl`);
  const raw = await readFile(path, "utf8");
  return raw.split("\n").filter((l) => l.trim().length > 0).map((l) => JSON.parse(l) as Record<string, unknown>);
}

/**
 * When no verdict is parsed, the hook never calls `updateSessionState` at all (nothing to write)
 * — so the state file may not exist yet. Treat "no file" the same as "lastVerifier: null" for
 * these assertions; both mean "nothing was recorded".
 */
async function lastVerifierOrAbsent(home: string, sessionId: string): Promise<unknown> {
  try {
    const state = (await readState(home, sessionId)) as { lastVerifier?: unknown };
    return state.lastVerifier ?? null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

test("a verdict-bearing agent_type records lastVerifier", async () => {
  await withPraxarchHome(async (home) => {
    const result = run(home, {
      session_id: "s1",
      cwd: process.cwd(),
      hook_event_name: "SubagentStop",
      agent_id: "aaa111",
      agent_type: "verifier",
      last_assistant_message: verdictText("CONFIRMED"),
    });
    assert.equal(result.status, 0);

    const state = (await readState(home, "s1")) as { lastVerifier: { verdict: string } | null };
    assert.equal(state.lastVerifier?.verdict, "CONFIRMED");
  });
});

test("a role outside verdictRoles does not record", async () => {
  await withPraxarchHome(async (home) => {
    const result = run(home, {
      session_id: "s2",
      cwd: process.cwd(),
      hook_event_name: "SubagentStop",
      agent_id: "aaa222",
      agent_type: "mech-executor",
      last_assistant_message: verdictText("CONFIRMED"),
    });
    assert.equal(result.status, 0);
    assert.equal(await lastVerifierOrAbsent(home, "s2"), null);
  });
});

test("agent_type '' records nothing (never treated as a wildcard)", async () => {
  await withPraxarchHome(async (home) => {
    const result = run(home, {
      session_id: "s3",
      cwd: process.cwd(),
      hook_event_name: "SubagentStop",
      agent_id: "aaa333",
      agent_type: "",
      last_assistant_message: verdictText("CONFIRMED"),
    });
    assert.equal(result.status, 0);
    assert.equal(await lastVerifierOrAbsent(home, "s3"), null);
  });
});

test("malformed verdict value degrades to no-op without throwing", async () => {
  await withPraxarchHome(async (home) => {
    const badText = ["```json", JSON.stringify({ verdict: "MAYBE", findings: [] }), "```"].join("\n");
    const result = run(home, {
      session_id: "s4",
      cwd: process.cwd(),
      hook_event_name: "SubagentStop",
      agent_id: "aaa444",
      agent_type: "verifier",
      last_assistant_message: badText,
    });
    assert.equal(result.status, 0);
    assert.equal(await lastVerifierOrAbsent(home, "s4"), null);
  });
});

test("trailing prose after the closing fence: no verdict recorded, exits 0", async () => {
  await withPraxarchHome(async (home) => {
    const text = [
      "```json",
      JSON.stringify({ verdict: "CONFIRMED", findings: [] }),
      "```",
      "Thanks for reviewing!",
    ].join("\n");
    const result = run(home, {
      session_id: "s5",
      cwd: process.cwd(),
      hook_event_name: "SubagentStop",
      agent_id: "aaa555",
      agent_type: "verifier",
      last_assistant_message: text,
    });
    assert.equal(result.status, 0);
    assert.equal(await lastVerifierOrAbsent(home, "s5"), null);
  });
});

test("exits 0 even with a completely empty payload (internal-failure path)", async () => {
  await withPraxarchHome(async (home) => {
    const result = run(home, {});
    assert.equal(result.status, 0);
  });
});

// Regression pin for issue #15 itself: a dispatch-time PostToolUse(Agent) launch-receipt payload
// must never be treated as a report, even if this hook is ever mis-wired to receive one. Uses the
// same fixture telemetry.test.ts uses for the real dispatch shape.
test("regression: a PostToolUse(Agent) launch-receipt payload is never treated as a report", async () => {
  await withPraxarchHome(async (home) => {
    const fixture = JSON.parse(
      await readFile(join(here, "fixtures", "post-tool-use.agent.json"), "utf8"),
    ) as Record<string, unknown>;
    // Confirm this fixture actually carries the shape we're guarding against, so the assertion
    // below can't pass vacuously if the fixture ever changes.
    assert.equal(fixture["hook_event_name"], "PostToolUse");

    const result = run(home, fixture);
    assert.equal(result.status, 0);

    const sessionId = fixture["session_id"] as string;
    assert.equal(await lastVerifierOrAbsent(home, sessionId), null);
  });
});

test("updates the matching delegations[] entry in place by agentId, without a second row", async () => {
  await withPraxarchHome(async (home) => {
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(join(home, "state"), { recursive: true });
    await writeFile(
      join(home, "state", "s6.json"),
      JSON.stringify({
        sessionId: "s6",
        startedAt: new Date().toISOString(),
        delegations: [
          {
            role: "verifier",
            model: "inherited",
            resolvedModel: null,
            totalTokens: null,
            durationMs: null,
            at: new Date().toISOString(),
            agentId: "match-me",
          },
        ],
        lastVerifier: null,
        baselineHead: null,
      }),
      "utf8",
    );

    const result = run(home, {
      session_id: "s6",
      cwd: process.cwd(),
      hook_event_name: "SubagentStop",
      agent_id: "match-me",
      agent_type: "verifier",
      last_assistant_message: verdictText("CONFIRMED"),
    });
    assert.equal(result.status, 0);

    const state = (await readState(home, "s6")) as {
      delegations: { agentId: string; verdict: string | null }[];
    };
    assert.equal(state.delegations.length, 1);
    assert.equal(state.delegations[0]?.verdict, "CONFIRMED");
  });
});

// --- Issue #23 (verifier MAJOR 1): SubagentStop is the primary automatic writer of `lastVerifier`
// (issue #15) and must anchor its measurement the same way telemetry.ts/verify-gate.ts do -------

function runAt(home: string, cwd: string, input: unknown): { status: number | null } {
  try {
    execFileSync("node", [script], {
      cwd,
      input: JSON.stringify(input),
      env: { ...process.env, PRAXARCH_HOME: home },
    });
    return { status: 0 };
  } catch (err) {
    return { status: (err as { status?: number }).status ?? null };
  }
}

async function makeRepo(prefix: string): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), `praxarch-subagentstop-${prefix}-`));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  await writeFile(join(repo, "file.txt"), "line\n".repeat(5));
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });
  return repo;
}

function runSessionInitAt(home: string, cwd: string, sessionId: string): void {
  execFileSync("node", [sessionInitScript], {
    cwd,
    input: JSON.stringify({ session_id: sessionId, cwd, hook_event_name: "SessionStart", source: "startup" }),
    env: { ...process.env, PRAXARCH_HOME: home },
  });
}

// This pair mirrors verify-gate.test.ts's own issue #23 acceptance evidence: the negative control
// (anchor stripped) must produce B's real counts, so the first result's 0/0 provably came from the
// anchor doing real work, not some unrelated no-op path.
test("issue #23 / MAJOR 1: records the anchor's counts, not the hook cwd's, on a SubagentStop verdict", async () => {
  await withPraxarchHome(async (home) => {
    const repoA = await makeRepo("anchor-a");
    const repoB = await makeRepo("anchor-b");
    try {
      // session-init runs in A (clean tree) -- this is where the anchor is recorded.
      runSessionInitAt(home, repoA, "s1");

      // B has a large uncommitted change; if this hook ever measured the hook cwd instead of the
      // anchor, the recorded counts would reflect it.
      await writeFile(join(repoB, "big.txt"), "line\n".repeat(200));

      const result = runAt(home, repoB, {
        session_id: "s1",
        cwd: repoB,
        hook_event_name: "SubagentStop",
        agent_id: "aaa-anchor",
        agent_type: "verifier",
        last_assistant_message: verdictText("CONFIRMED"),
      });
      assert.equal(result.status, 0);

      const state = (await readState(home, "s1")) as {
        lastVerifier: { changedLines: number | null; changedFiles: number | null; diffHash: string | null } | null;
      };
      assert.equal(state.lastVerifier?.changedLines, 0, JSON.stringify(state.lastVerifier));
      assert.equal(state.lastVerifier?.changedFiles, 0, JSON.stringify(state.lastVerifier));

      // Negative control: strip the anchor (simulating a legacy session) and re-run the identical
      // B-cwd call -- this must now record B's real (large) counts, proving the first result came
      // from the anchor doing real work.
      const statePath = join(home, "state", "s1.json");
      const state2 = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
      delete state2["baselineCwd"];
      await writeFile(statePath, JSON.stringify(state2), "utf8");

      const result2 = runAt(home, repoB, {
        session_id: "s1",
        cwd: repoB,
        hook_event_name: "SubagentStop",
        agent_id: "aaa-anchor-2",
        agent_type: "verifier",
        last_assistant_message: verdictText("CONFIRMED"),
      });
      assert.equal(result2.status, 0);

      const state3 = (await readState(home, "s1")) as {
        lastVerifier: { changedLines: number | null; changedFiles: number | null } | null;
      };
      assert.ok(
        (state3.lastVerifier?.changedLines ?? 0) >= 200,
        `expected B's large diff to be recorded once the anchor is gone: ${JSON.stringify(state3.lastVerifier)}`,
      );
    } finally {
      await rm(repoA, { recursive: true, force: true });
      await rm(repoB, { recursive: true, force: true });
    }
  });
});

// Dead-anchor null-record test: a recorded-but-now-missing anchor must record `diffHash: null` /
// `changedLines: null` / `changedFiles: null` -- never falling back to the hook cwd (which would
// silently measure B instead), and never crashing.
test("issue #23 / MAJOR 1: a dead anchor records diffHash/changedLines/changedFiles as null, never falls back to the hook cwd", async () => {
  await withPraxarchHome(async (home) => {
    const repoA = await mkdtemp(join(tmpdir(), "praxarch-subagentstop-deadanchor-a-"));
    const repoB = await makeRepo("deadanchor-b");
    try {
      execFileSync("git", ["init", "-q"], { cwd: repoA });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoA });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: repoA });
      await writeFile(join(repoA, "file.txt"), "line\n");
      execFileSync("git", ["add", "."], { cwd: repoA });
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoA });

      runSessionInitAt(home, repoA, "s1");

      // Delete the anchor directory itself -- the state still names it, but it's now unreachable.
      await rm(repoA, { recursive: true, force: true });

      const result = runAt(home, repoB, {
        session_id: "s1",
        cwd: repoB,
        hook_event_name: "SubagentStop",
        agent_id: "aaa-dead",
        agent_type: "verifier",
        last_assistant_message: verdictText("CONFIRMED"),
      });
      assert.equal(result.status, 0);

      const state = (await readState(home, "s1")) as {
        lastVerifier: { diffHash: string | null; changedLines: number | null; changedFiles: number | null } | null;
      };
      assert.equal(state.lastVerifier?.diffHash, null);
      assert.equal(state.lastVerifier?.changedLines, null);
      assert.equal(state.lastVerifier?.changedFiles, null);
      // The invariant verify-gate depends on: the key is present-and-null, never absent.
      const raw = JSON.parse(await readFile(join(home, "state", "s1.json"), "utf8")) as Record<string, unknown>;
      const lastVerifier = raw["lastVerifier"] as Record<string, unknown>;
      assert.ok("diffHash" in lastVerifier, "diffHash key must be present, not dropped");
    } finally {
      await rm(repoB, { recursive: true, force: true });
    }
  });
});

// --- Issue #25: subagent-stop appends its own `subagentVerdict` JSONL row ------------------------

test("a recorded verdict appends exactly one subagentVerdict row", async () => {
  await withPraxarchHome(async (home) => {
    const result = run(home, {
      session_id: "j1",
      cwd: process.cwd(),
      hook_event_name: "SubagentStop",
      agent_id: "aaa111",
      agent_type: "verifier",
      last_assistant_message: verdictText("CONFIRMED"),
    });
    assert.equal(result.status, 0);

    const rows = await readMonthlyLog(home);
    assert.equal(rows.length, 1);
    const row = rows[0] as Record<string, unknown>;
    assert.equal(row["event"], "subagentVerdict");
    assert.equal(row["sessionId"], "j1");
    assert.equal(row["role"], "verifier");
    assert.equal(row["agentId"], "aaa111");
    assert.equal(row["verdict"], "CONFIRMED");
    assert.equal(row["findingsCount"], 0);
    assert.equal(row["criticalOrMajorCount"], 0);
    assert.ok("diffHash" in row);
  });
});

test("a role outside verdictRoles appends no row", async () => {
  await withPraxarchHome(async (home) => {
    const result = run(home, {
      session_id: "j2",
      cwd: process.cwd(),
      hook_event_name: "SubagentStop",
      agent_id: "aaa222",
      agent_type: "mech-executor",
      last_assistant_message: verdictText("CONFIRMED"),
    });
    assert.equal(result.status, 0);
    await assert.rejects(readMonthlyLog(home), (err: unknown) => (err as NodeJS.ErrnoException).code === "ENOENT");
  });
});

test("a malformed verdict appends no row", async () => {
  await withPraxarchHome(async (home) => {
    const badText = ["```json", JSON.stringify({ verdict: "MAYBE", findings: [] }), "```"].join("\n");
    const result = run(home, {
      session_id: "j3",
      cwd: process.cwd(),
      hook_event_name: "SubagentStop",
      agent_id: "aaa333",
      agent_type: "verifier",
      last_assistant_message: badText,
    });
    assert.equal(result.status, 0);
    await assert.rejects(readMonthlyLog(home), (err: unknown) => (err as NodeJS.ErrnoException).code === "ENOENT");
  });
});
