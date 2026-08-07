import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "..", "..", "dist", "hooks", "telemetry.js");

async function withPraxarchHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "praxarch-telemetry-"));
  try {
    return await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function run(home: string, input: unknown): void {
  execFileSync("node", [script], {
    input: JSON.stringify(input),
    env: { ...process.env, PRAXARCH_HOME: home },
  });
}

function monthlyLogPath(home: string): string {
  const now = new Date();
  return join(
    home,
    "logs",
    `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}.jsonl`,
  );
}

test("logs a delegation record and updates session state", async () => {
  await withPraxarchHome(async (home) => {
    run(home, {
      session_id: "s1",
      cwd: process.cwd(),
      hook_event_name: "PostToolUse",
      tool_name: "Agent",
      tool_input: { subagent_type: "mech-executor", model: "sonnet" },
      tool_response: { status: "completed", content: [{ type: "text", text: "done" }] },
    });

    const logContent = await readFile(monthlyLogPath(home), "utf8");
    const record = JSON.parse(logContent.trim()) as { role: string; model: string };
    assert.equal(record.role, "mech-executor");
    assert.equal(record.model, "sonnet");

    const statePath = join(home, "state", "s1.json");
    const state = JSON.parse(await readFile(statePath, "utf8")) as { delegations: unknown[] };
    assert.equal(state.delegations.length, 1);
  });
});

test("records resolved model, tokens, and duration from a real captured payload", async () => {
  await withPraxarchHome(async (home) => {
    const fixture = JSON.parse(
      await readFile(join(here, "fixtures", "post-tool-use.agent.json"), "utf8"),
    ) as Record<string, unknown>;
    run(home, fixture);

    const logContent = await readFile(monthlyLogPath(home), "utf8");
    const record = JSON.parse(logContent.trim()) as {
      role: string;
      model: string;
      resolvedModel: string | null;
      totalTokens: number | null;
      durationMs: number | null;
    };
    assert.equal(record.role, "scout");
    assert.equal(record.model, "inherited");
    assert.equal(record.resolvedModel, "claude-haiku-4-5-20251001");
    assert.equal(record.totalTokens, 8225);
    assert.equal(record.durationMs, 2937);
  });
});

test("parses a verifier's trailing JSON verdict into session state", async () => {
  await withPraxarchHome(async (home) => {
    const verifierText = [
      "Reviewed the change, ran the tests, no issues found.",
      "",
      "```json",
      JSON.stringify({ verdict: "CONFIRMED", findings: [] }),
      "```",
    ].join("\n");

    run(home, {
      session_id: "s1",
      cwd: process.cwd(),
      hook_event_name: "PostToolUse",
      tool_name: "Agent",
      tool_input: { subagent_type: "verifier", model: "opus" },
      tool_response: { status: "completed", content: [{ type: "text", text: verifierText }] },
    });

    const statePath = join(home, "state", "s1.json");
    const state = JSON.parse(await readFile(statePath, "utf8")) as {
      lastVerifier: { verdict: string; criticalOrMajorCount: number } | null;
    };
    assert.equal(state.lastVerifier?.verdict, "CONFIRMED");
    assert.equal(state.lastVerifier?.criticalOrMajorCount, 0);
  });
});

test("counts critical/major findings from a REFUTED verdict", async () => {
  await withPraxarchHome(async (home) => {
    const verifierText = [
      "```json",
      JSON.stringify({
        verdict: "REFUTED",
        findings: [
          { severity: "critical", file: "a.ts", line: 1, summary: "x", failure_scenario: "y" },
          { severity: "minor", file: "b.ts", line: 2, summary: "x", failure_scenario: "y" },
        ],
      }),
      "```",
    ].join("\n");

    run(home, {
      session_id: "s1",
      cwd: process.cwd(),
      hook_event_name: "PostToolUse",
      tool_name: "Agent",
      tool_input: { subagent_type: "verifier", model: "opus" },
      tool_response: { status: "completed", content: [{ type: "text", text: verifierText }] },
    });

    const statePath = join(home, "state", "s1.json");
    const state = JSON.parse(await readFile(statePath, "utf8")) as {
      lastVerifier: { verdict: string; criticalOrMajorCount: number; findingsCount: number };
    };
    assert.equal(state.lastVerifier?.verdict, "REFUTED");
    assert.equal(state.lastVerifier?.criticalOrMajorCount, 1);
    assert.equal(state.lastVerifier?.findingsCount, 2);
  });
});

test("records a verdict from a config-added verdictRole", async () => {
  await withPraxarchHome(async (home) => {
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({ verifyGate: { verdictRoles: ["plan-reviewer"] } }),
    );
    const reviewText = [
      "Task 1: OK",
      "Unplanned changes: none",
      "",
      "```json",
      JSON.stringify({ verdict: "CONFIRMED", findings: [] }),
      "```",
    ].join("\n");

    run(home, {
      session_id: "s1",
      cwd: process.cwd(),
      hook_event_name: "PostToolUse",
      tool_name: "Agent",
      tool_input: { subagent_type: "plan-reviewer" },
      tool_response: { status: "completed", content: [{ type: "text", text: reviewText }] },
    });

    const statePath = join(home, "state", "s1.json");
    const state = JSON.parse(await readFile(statePath, "utf8")) as {
      lastVerifier: { verdict: string; criticalOrMajorCount: number } | null;
    };
    assert.equal(state.lastVerifier?.verdict, "CONFIRMED");
    assert.equal(state.lastVerifier?.criticalOrMajorCount, 0);
  });
});

test("ignores a verdict block from a role outside verdictRoles", async () => {
  await withPraxarchHome(async (home) => {
    const reviewText = ["```json", JSON.stringify({ verdict: "CONFIRMED", findings: [] }), "```"].join(
      "\n",
    );

    run(home, {
      session_id: "s1",
      cwd: process.cwd(),
      hook_event_name: "PostToolUse",
      tool_name: "Agent",
      tool_input: { subagent_type: "plan-reviewer" },
      tool_response: { status: "completed", content: [{ type: "text", text: reviewText }] },
    });

    const statePath = join(home, "state", "s1.json");
    const state = JSON.parse(await readFile(statePath, "utf8")) as {
      lastVerifier?: { verdict: string } | null;
    };
    assert.ok(!state.lastVerifier);
  });
});

test("ignores non-Agent tool calls", async () => {
  await withPraxarchHome(async (home) => {
    run(home, {
      session_id: "s1",
      cwd: process.cwd(),
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_input: {},
    });
    await assert.rejects(readFile(join(home, "state", "s1.json"), "utf8"));
  });
});
