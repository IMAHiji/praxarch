import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { TEST_DIST_DIR } from "../test-support/dist-dir.js";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(TEST_DIST_DIR, "hooks", "route-guard.js");
const knownRolesProject = join(here, "fixtures", "known-roles-project");
const reviewRolesProject = join(here, "fixtures", "review-roles-project");
const malformedConfigProject = join(here, "fixtures", "malformed-config-project");
const softDenyRolesProject = join(here, "fixtures", "soft-deny-roles-project");
const malformedSoftDenyProject = join(here, "fixtures", "malformed-soft-deny-project");
const softDenyAdhocProject = join(here, "fixtures", "soft-deny-adhoc-project");
const strictFalseProject = join(here, "fixtures", "strict-false-project");

async function run(
  input: unknown,
  env?: Record<string, string>,
): Promise<{ decision: string; systemMessage?: string; stdout: unknown }> {
  const stdout = execFileSync("node", [script], {
    input: JSON.stringify(input),
    env: env ? { ...process.env, ...env } : process.env,
  }).toString("utf8");
  const parsed = JSON.parse(stdout) as {
    hookSpecificOutput: { permissionDecision: string };
    systemMessage?: string;
  };
  return {
    decision: parsed.hookSpecificOutput.permissionDecision,
    ...(parsed.systemMessage !== undefined ? { systemMessage: parsed.systemMessage } : {}),
    stdout: parsed,
  };
}

// Isolates the hook from this machine's real global config (~/.claude/praxarch/config.json),
// whose knownRoles/securityKeywords would otherwise leak into fixture-based assertions.
const HERMETIC_ENV = { PRAXARCH_HOME: join(knownRolesProject, "no-such-praxarch-home") };

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
    tool_input: { subagent_type: "mech-executor", prompt: "rotate the JWT secret handling in auth.ts" },
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
      subagent_type: "mech-executor",
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
      tool_input: { subagent_type: "mech-executor", prompt },
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

// Issue #21: checker is a builtin role (sonnet-tier verdict role, verifier's re-verify
// counterpart) — same known-role and review-exemption treatment as verifier.
test("allows a checker delegation with no explicit model (known builtin role)", async () => {
  const { decision } = await run({
    session_id: "s1",
    cwd: process.cwd(),
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    tool_input: { subagent_type: "checker", prompt: "re-verify the fix against the prior findings" },
  });
  assert.equal(decision, "allow");
});

test("denies a checker delegation that passes an explicit model", async () => {
  const { decision } = await run({
    session_id: "s1",
    cwd: process.cwd(),
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    tool_input: {
      subagent_type: "checker",
      model: "sonnet",
      prompt: "re-verify the fix against the prior findings",
    },
  });
  assert.equal(decision, "deny");
});

test("allows a security-flavored delegation to checker (review role, same exemption as verifier)", async () => {
  const { decision } = await run({
    session_id: "s1",
    cwd: process.cwd(),
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    tool_input: {
      subagent_type: "checker",
      prompt: "Re-verify the JWT secret rotation and authentication fix against the prior findings.",
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

test("treats a config-extended knownRole as defined: no explicit model → allow", async () => {
  const { decision } = await run(
    {
      session_id: "s1",
      cwd: knownRolesProject,
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_input: { subagent_type: "spec-writer", prompt: "decompose the dashboard feature into a plan" },
    },
    HERMETIC_ENV,
  );
  assert.equal(decision, "allow");
});

test("applies the no-explicit-model rule to config-extended knownRoles", async () => {
  const { decision } = await run(
    {
      session_id: "s1",
      cwd: knownRolesProject,
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_input: {
        subagent_type: "spec-writer",
        model: "sonnet",
        prompt: "decompose the dashboard feature into a plan",
      },
    },
    HERMETIC_ENV,
  );
  assert.equal(decision, "deny");
});

test("exempts config-listed review roles from the security redirect", async () => {
  const { decision } = await run(
    {
      session_id: "s1",
      cwd: reviewRolesProject,
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_input: {
        subagent_type: "pr-review-toolkit:silent-failure-hunter",
        prompt: "Review the JWT secret rotation and authentication changes for swallowed errors.",
      },
    },
    HERMETIC_ENV,
  );
  assert.equal(decision, "allow");
});

test("security redirect still applies to non-review roles under a reviewRoles config", async () => {
  const { decision } = await run(
    {
      session_id: "s1",
      cwd: reviewRolesProject,
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_input: { subagent_type: "mech-executor", prompt: "rotate the JWT secret handling in auth.ts" },
    },
    HERMETIC_ENV,
  );
  assert.equal(decision, "deny");
});

test("still denies a role absent from both builtin and config knownRoles", async () => {
  const { decision } = await run(
    {
      session_id: "s1",
      cwd: knownRolesProject,
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_input: { subagent_type: "ghost-role", prompt: "build task 3 from the plan file" },
    },
    HERMETIC_ENV,
  );
  assert.equal(decision, "deny");
});

test("malformed project config does not disable the guard: defined-role delegation with explicit model is still denied, and the warning surfaces", async () => {
  const { decision, systemMessage } = await run(
    {
      session_id: "s1",
      cwd: malformedConfigProject,
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_input: { subagent_type: "executor", model: "sonnet", prompt: "refactor the widget module" },
    },
    HERMETIC_ENV,
  );
  assert.equal(decision, "deny");
  assert.match(systemMessage ?? "", /praxarch\.json is unreadable or not valid JSON/);
});

test("soft-denies (warns, does not block) a security-flavored delegation to executor", async () => {
  const { decision, systemMessage, stdout } = await run({
    session_id: "s1",
    cwd: process.cwd(),
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    tool_input: { subagent_type: "executor", prompt: "audit the credential rotation logic" },
  });
  const parsed = stdout as { hookSpecificOutput: { permissionDecisionReason?: string } };
  assert.equal(decision, "allow");
  assert.equal(
    systemMessage,
    'praxarch route-guard: warning — this delegation looks security-sensitive (matched keyword ' +
      '"credential*") but is going to "executor"; if it touches auth/secrets/crypto/trust-boundary ' +
      "validation, route it to security-executor instead.",
  );
  assert.match(parsed.hookSpecificOutput.permissionDecisionReason ?? "", /route it to security-executor instead/);
});

test("still hard-denies a security-flavored delegation to mech-executor, message unchanged from today", async () => {
  const { decision, systemMessage } = await run({
    session_id: "s1",
    cwd: process.cwd(),
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    tool_input: { subagent_type: "mech-executor", prompt: "audit the credential rotation logic" },
  });
  assert.equal(decision, "deny");
  assert.equal(
    systemMessage,
    'praxarch route-guard: blocked — this delegation looks security-sensitive (matched keyword ' +
      '"credential*") but subagent_type is "mech-executor", not "security-executor". Route ' +
      "auth/secrets/crypto/validation work to security-executor per the orchestration policy.",
  );
});

test("ad-hoc dispatch with explicit model still denies on a security keyword match (soft-deny does not apply)", async () => {
  const { decision } = await run({
    session_id: "s1",
    cwd: process.cwd(),
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    tool_input: {
      subagent_type: "general-purpose",
      model: "sonnet",
      prompt: "audit the credential rotation logic",
    },
  });
  assert.equal(decision, "deny");
});

test("review-role exemption wins outright over soft-deny: verifier gets a plain allow, no warning layered on", async () => {
  const { decision, systemMessage } = await run({
    session_id: "s1",
    cwd: process.cwd(),
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    tool_input: { subagent_type: "verifier", prompt: "audit the credential rotation logic" },
  });
  assert.equal(decision, "allow");
  assert.equal(systemMessage, undefined);
});

test("config softDenyRoles extends the warn set additively: implementer also gets warn-only", async () => {
  const { decision, systemMessage } = await run(
    {
      session_id: "s1",
      cwd: softDenyRolesProject,
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_input: { subagent_type: "implementer", prompt: "audit the credential rotation logic" },
    },
    HERMETIC_ENV,
  );
  assert.equal(decision, "allow");
  assert.match(systemMessage ?? "", /is going to "implementer"/);
});

test("malformed softDenyRoles config value warns and falls back to the default [\"executor\"]", async () => {
  const { decision, systemMessage } = await run(
    {
      session_id: "s1",
      cwd: malformedSoftDenyProject,
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_input: { subagent_type: "executor", prompt: "audit the credential rotation logic" },
    },
    HERMETIC_ENV,
  );
  assert.equal(decision, "allow");
  assert.match(systemMessage ?? "", /routeGuard\.softDenyRoles must be an array of strings/);
  assert.match(systemMessage ?? "", /is going to "executor"/);
});

// Regression coverage for the soft-deny-as-bypass bug (GitLab issue #8): a security-keyword
// match against a softDenyRoles member must not short-circuit the explicit-model-override or
// ad-hoc-no-model rules that run later in the chain — the warning is only ever surfaced when
// nothing else in the chain would deny the delegation.

test("explicit-model-override deny wins over a soft-deny warning: executor + model + keyword denies, not a warning-allow", async () => {
  const { decision, systemMessage } = await run({
    session_id: "s1",
    cwd: process.cwd(),
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    tool_input: { subagent_type: "executor", model: "haiku", prompt: "audit the credential rotation logic" },
  });
  assert.equal(decision, "deny");
  assert.equal(
    systemMessage,
    'praxarch route-guard: blocked — delegation to defined role "executor" passes explicit model ' +
      '"haiku", which overrides the role\'s frontmatter binding and defeats tiered routing. Omit ' +
      "model — role→model bindings live in the agent file.",
  );
});

test("ad-hoc-no-model deny wins over a soft-deny warning: a softDenyRoles role outside knownRoles, dispatched ad-hoc with no model, still denies", async () => {
  const { decision, systemMessage } = await run(
    {
      session_id: "s1",
      cwd: softDenyAdhocProject,
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_input: { subagent_type: "plugin:reviewer", prompt: "audit the credential rotation logic" },
    },
    HERMETIC_ENV,
  );
  assert.equal(decision, "deny");
  assert.match(systemMessage ?? "", /ad-hoc fan-out Agent call/);
  assert.doesNotMatch(systemMessage ?? "", /security-executor instead/);
});

test("strict:false does not double-print or misbehave on the soft-deny path: single message, allow", async () => {
  const { decision, systemMessage } = await run(
    {
      session_id: "s1",
      cwd: strictFalseProject,
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_input: { subagent_type: "executor", prompt: "audit the credential rotation logic" },
    },
    HERMETIC_ENV,
  );
  assert.equal(decision, "allow");
  assert.equal(
    systemMessage,
    'praxarch route-guard: warning — this delegation looks security-sensitive (matched keyword ' +
      '"credential*") but is going to "executor"; if it touches auth/secrets/crypto/trust-boundary ' +
      "validation, route it to security-executor instead.",
  );
});

// --- Crash-visibility (issue #24) ---------------------------------------------------------------
// Before #24, a route-guard crash allowed and wrote only a stderr line no one sees — issue #7's
// "did the guard crash and fail open?" hypothesis was permanently unfalsifiable as a result. These
// pin the guard-crash JSONL row alongside the untouched fail-open contract.

async function readMonthlyLog(home: string): Promise<Record<string, unknown>[]> {
  const now = new Date();
  const path = join(home, "logs", `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}.jsonl`);
  const raw = await readFile(path, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

// tool_input: null forces main()'s `const { subagent_type, ... } = input.tool_input` destructure
// to throw a real TypeError — a fault injected past input-parsing (session_id is already known),
// deliberately not simulated via a mocked catch handler.
function crashInput(sessionId: string): unknown {
  return {
    session_id: sessionId,
    cwd: process.cwd(),
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    tool_input: null,
  };
}

test("a route-guard crash still allows and appends a guard-crash row to the monthly JSONL", async () => {
  const home = await mkdtemp(join(tmpdir(), "praxarch-routeguard-home-"));
  try {
    const { decision } = await run(crashInput("s-crash-1"), { PRAXARCH_HOME: home });
    assert.equal(decision, "allow");

    const log = await readMonthlyLog(home);
    const crashRows = log.filter((r) => r["event"] === "guard-crash");
    assert.equal(crashRows.length, 1);
    assert.equal(crashRows[0]?.["hook"], "route-guard");
    assert.equal(crashRows[0]?.["sessionId"], "s-crash-1");
    assert.match(String(crashRows[0]?.["error"]), /destructure/i);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a route-guard crash still allows even when the guard-crash row write also fails", async () => {
  // PRAXARCH_HOME pointed at a plain file (not a directory): appendJsonl's mkdir(dirname(logPath))
  // fails with ENOTDIR, so the row write itself fails. The original crash must not be masked and
  // fail-open must not become fail-closed because logging failed on top of it.
  const homeFile = await mkdtemp(join(tmpdir(), "praxarch-routeguard-badhome-"));
  const notADir = join(homeFile, "not-a-directory");
  await writeFile(notADir, "not a directory");
  try {
    const { decision } = await run(crashInput("s-crash-2"), { PRAXARCH_HOME: notADir });
    assert.equal(decision, "allow");
  } finally {
    await rm(homeFile, { recursive: true, force: true });
  }
});
