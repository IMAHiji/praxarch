import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "..", "..", "dist", "hooks", "route-guard.js");

async function run(input: unknown): Promise<{ decision: string; stdout: unknown }> {
  const stdout = execFileSync("node", [script], { input: JSON.stringify(input) }).toString("utf8");
  const parsed = JSON.parse(stdout) as {
    hookSpecificOutput: { permissionDecision: string };
  };
  return { decision: parsed.hookSpecificOutput.permissionDecision, stdout: parsed };
}

test("allows non-Agent tool calls unconditionally", async () => {
  const { decision } = await run({
    session_id: "s1",
    cwd: process.cwd(),
    hook_event_name: "PreToolUse",
    tool_name: "Read",
    tool_input: {},
  });
  assert.equal(decision, "allow");
});

test("allows a known-role delegation with no explicit model", async () => {
  const { decision } = await run({
    session_id: "s1",
    cwd: process.cwd(),
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    tool_input: { subagent_type: "executor", prompt: "refactor the widget module" },
  });
  assert.equal(decision, "allow");
});

test("denies an ad-hoc fan-out call with no explicit model", async () => {
  const { decision } = await run({
    session_id: "s1",
    cwd: process.cwd(),
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    tool_input: { subagent_type: "general-purpose", prompt: "look into the bug" },
  });
  assert.equal(decision, "deny");
});

test("allows an ad-hoc fan-out call with explicit model", async () => {
  const { decision } = await run({
    session_id: "s1",
    cwd: process.cwd(),
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    tool_input: { subagent_type: "general-purpose", model: "sonnet", prompt: "look into the bug" },
  });
  assert.equal(decision, "allow");
});

test("denies a security-flavored delegation not routed to security-executor", async () => {
  const { decision } = await run({
    session_id: "s1",
    cwd: process.cwd(),
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    tool_input: { subagent_type: "executor", prompt: "rotate the JWT secret handling in auth.ts" },
  });
  assert.equal(decision, "deny");
});

test("does not flag 'author'/'authored' as security-sensitive", async () => {
  const { decision } = await run({
    session_id: "s1",
    cwd: process.cwd(),
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    tool_input: {
      subagent_type: "executor",
      prompt: "Update the CHANGELOG authors section; each entry was authored by a Co-Authored-By trailer.",
    },
  });
  assert.equal(decision, "allow");
});

test("flags stem-matched keywords like 'authentication' and 'encrypted'", async () => {
  for (const prompt of ["add authentication to the endpoint", "store the file encrypted at rest"]) {
    const { decision } = await run({
      session_id: "s1",
      cwd: process.cwd(),
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_input: { subagent_type: "executor", prompt },
    });
    assert.equal(decision, "deny", `expected deny for: ${prompt}`);
  }
});

test("allows a security-flavored delegation to verifier (review role, verify-gate needs it)", async () => {
  const { decision } = await run({
    session_id: "s1",
    cwd: process.cwd(),
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    tool_input: {
      subagent_type: "verifier",
      prompt: "Review the JWT secret rotation and authentication changes for correctness.",
    },
  });
  assert.equal(decision, "allow");
});

test("denies a defined-role delegation that passes an explicit model", async () => {
  const { decision } = await run({
    session_id: "s1",
    cwd: process.cwd(),
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    tool_input: { subagent_type: "executor", model: "sonnet", prompt: "refactor the widget module" },
  });
  assert.equal(decision, "deny");
});

test("allows a security-flavored delegation routed to security-executor", async () => {
  const { decision } = await run({
    session_id: "s1",
    cwd: process.cwd(),
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    tool_input: { subagent_type: "security-executor", prompt: "rotate the JWT secret handling" },
  });
  assert.equal(decision, "allow");
});
