import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

test("logs a delegation record and updates session state", async () => {
  await withPraxarchHome(async (home) => {
    run(home, {
      session_id: "s1",
      cwd: process.cwd(),
      hook_event_name: "PostToolUse",
      tool_name: "Agent",
      tool_input: { subagent_type: "mech-executor", model: "sonnet" },
      tool_output: { type: "text", text: "done" },
    });

    const now = new Date();
    const logPath = join(
      home,
      "logs",
      `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}.jsonl`,
    );
    const logContent = await readFile(logPath, "utf8");
    const record = JSON.parse(logContent.trim()) as { role: string; model: string };
    assert.equal(record.role, "mech-executor");
    assert.equal(record.model, "sonnet");

    const statePath = join(home, "state", "s1.json");
    const state = JSON.parse(await readFile(statePath, "utf8")) as { delegations: unknown[] };
    assert.equal(state.delegations.length, 1);
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
      tool_output: { type: "text", text: verifierText },
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
      tool_output: { type: "text", text: verifierText },
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
