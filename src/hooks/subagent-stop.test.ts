import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "..", "..", "dist", "hooks", "subagent-stop.js");

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
