import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { TEST_DIST_DIR } from "../test-support/dist-dir.js";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(TEST_DIST_DIR, "hooks", "route-guard.js");
const knownRolesProject = join(here, "fixtures", "known-roles-project");
const reviewRolesProject = join(here, "fixtures", "review-roles-project");
const malformedConfigProject = join(here, "fixtures", "malformed-config-project");
const strictFalseProject = join(here, "fixtures", "strict-false-project");

async function run(
  input: unknown,
  env?: Record<string, string>,
): Promise<{ decision: string; systemMessage?: string; stdout: unknown }> {
  const stdout = execFileSync("node", [script], {
    input: JSON.stringify(input),
    env: { ...process.env, ...HERMETIC_ENV, ...env },
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

// Isolates the hook from this machine's real ~/.claude/praxarch: its global config.json, whose
// knownRoles/securityKeywords would otherwise leak into fixture-based assertions, and its monthly
// log, which every deny and warning now appends a row to (issue #19). run() applies this by
// default, so no spawn writes to the real log or into the fixture tree. The directory starts
// empty, so there's no config.json in it.
const SCRATCH_HOME = mkdtempSync(join(tmpdir(), "praxarch-routeguard-scratch-"));
after(() => rmSync(SCRATCH_HOME, { recursive: true, force: true }));
const HERMETIC_ENV = { PRAXARCH_HOME: SCRATCH_HOME };

// Exact security-keyword messages (issue #1): the hard deny, now with the ad-hoc opus hint, and
// the warn-only message an ad-hoc opus call gets instead.
const securityDeny = (role: string, keyword = "credential*"): string =>
  `praxarch route-guard: blocked — this delegation looks security-sensitive (matched keyword "${keyword}") ` +
  `but subagent_type is "${role}", not "security-executor". Route auth/secrets/crypto/validation work ` +
  `to security-executor per the orchestration policy; if this isn't security work, an ad-hoc dispatch ` +
  `(no defined role) with model "opus" gets a warning instead of a block.`;
const securityWarning = (role: string, keyword = "credential*"): string =>
  `praxarch route-guard: warning — this delegation looks security-sensitive (matched keyword "${keyword}") ` +
  `but is going to "${role}"; if it touches auth/secrets/crypto/trust-boundary validation, route it to ` +
  `security-executor instead.`;

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

test("issue #1: a defined role hard-denies a security-flavored delegation (executor, no role-name override)", async () => {
  const { decision, systemMessage } = await run(
    {
      session_id: "s1",
      cwd: process.cwd(),
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_input: { subagent_type: "executor", prompt: "audit the credential rotation logic" },
    },
    HERMETIC_ENV,
  );
  assert.equal(decision, "deny");
  assert.equal(systemMessage, securityDeny("executor"));
});

test("still hard-denies a security-flavored delegation to mech-executor, with the ad-hoc opus hint", async () => {
  const { decision, systemMessage } = await run(
    {
      session_id: "s1",
      cwd: process.cwd(),
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_input: { subagent_type: "mech-executor", prompt: "audit the credential rotation logic" },
    },
    HERMETIC_ENV,
  );
  assert.equal(decision, "deny");
  assert.equal(systemMessage, securityDeny("mech-executor"));
});

test("ad-hoc dispatch on sonnet still denies on a security keyword match (below the security tier)", async () => {
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

// The issue #8 fall-through is kept: a pending security warning never survives a later deny, and
// never short-circuits the explicit-model-override or ad-hoc-no-model rules that run after it.
// Under the ad-hoc-opus rule no later deny can currently apply to a warned call; these pin that
// the security check itself denies every defined role and every ad-hoc call below the tier.

test("issue #1: a defined role can't buy warn-only by passing model opus: executor + model opus + keyword hard-denies", async () => {
  const { decision, systemMessage } = await run(
    {
      session_id: "s1",
      cwd: process.cwd(),
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_input: { subagent_type: "executor", model: "opus", prompt: "audit the credential rotation logic" },
    },
    HERMETIC_ENV,
  );
  assert.equal(decision, "deny");
  assert.equal(systemMessage, securityDeny("executor"));
});

test("issue #1: ad-hoc dispatch with no model hard-denies on a security keyword", async () => {
  const { decision, systemMessage } = await run(
    {
      session_id: "s1",
      cwd: process.cwd(),
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_input: { subagent_type: "general-purpose", prompt: "audit the credential rotation logic" },
    },
    HERMETIC_ENV,
  );
  assert.equal(decision, "deny");
  assert.equal(systemMessage, securityDeny("general-purpose"));
});

test("strict:false does not double-print or misbehave on the warn path: single message, allow", async () => {
  const { decision, systemMessage } = await run(
    {
      session_id: "s1",
      cwd: strictFalseProject,
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_input: { subagent_type: "general-purpose", model: "opus", prompt: "audit the credential rotation logic" },
    },
    HERMETIC_ENV,
  );
  assert.equal(decision, "allow");
  assert.equal(systemMessage, securityWarning("general-purpose"));
});

test("issue #1: ad-hoc general-purpose on opus gets warn-only on a security keyword", async () => {
  const { decision, systemMessage, stdout } = await run(
    {
      session_id: "s1",
      cwd: process.cwd(),
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_input: { subagent_type: "general-purpose", model: "opus", prompt: "audit the credential rotation logic" },
    },
    HERMETIC_ENV,
  );
  const parsed = stdout as { hookSpecificOutput: { permissionDecisionReason?: string } };
  assert.equal(decision, "allow");
  assert.equal(systemMessage, securityWarning("general-purpose"));
  assert.match(parsed.hookSpecificOutput.permissionDecisionReason ?? "", /route it to security-executor instead/);
});

test("issue #1: a full opus model id counts as the security tier", async () => {
  const { decision, systemMessage } = await run(
    {
      session_id: "s1",
      cwd: process.cwd(),
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_input: {
        subagent_type: "general-purpose",
        model: "claude-opus-4-8",
        prompt: "audit the credential rotation logic",
      },
    },
    HERMETIC_ENV,
  );
  assert.equal(decision, "allow");
  assert.equal(systemMessage, securityWarning("general-purpose"));
});

// Issue #18: the security tier is a rank, not a substring. fable outranks opus, so an ad-hoc fable
// call warns like an opus one. The sonnet, haiku and non-string denies are pinned by the tests
// around this one.
test("issue #18: ad-hoc fable, short name or full id, warns like opus on a security keyword", async () => {
  for (const model of ["fable", "claude-fable-5-1", "claude-fable-5-1[1m]"]) {
    const { decision, systemMessage } = await run(
      {
        session_id: "s1",
        cwd: process.cwd(),
        hook_event_name: "PreToolUse",
        tool_name: "Agent",
        tool_input: { subagent_type: "general-purpose", model, prompt: "review auth flow" },
      },
      HERMETIC_ENV,
    );
    assert.equal(decision, "allow", `expected warn-only for model: ${model}`);
    assert.equal(systemMessage, securityWarning("general-purpose", "auth"), `model: ${model}`);
  }
});

test("issue #18: a defined role can't buy warn-only by passing model fable either", async () => {
  const { decision, systemMessage } = await run(
    {
      session_id: "s1",
      cwd: process.cwd(),
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_input: { subagent_type: "executor", model: "fable", prompt: "review auth flow" },
    },
    HERMETIC_ENV,
  );
  assert.equal(decision, "deny");
  assert.equal(systemMessage, securityDeny("executor", "auth"));
});

test("issue #1: ad-hoc on haiku or model inherit still hard-denies", async () => {
  for (const model of ["haiku", "inherit"]) {
    const { decision, systemMessage } = await run(
      {
        session_id: "s1",
        cwd: process.cwd(),
        hook_event_name: "PreToolUse",
        tool_name: "Agent",
        tool_input: { subagent_type: "general-purpose", model, prompt: "audit the credential rotation logic" },
      },
      HERMETIC_ENV,
    );
    assert.equal(decision, "deny", `expected deny for model: ${model}`);
    assert.equal(systemMessage, securityDeny("general-purpose"), `model: ${model}`);
  }
});

test("issue #1: a config knownRole passing model opus still hard-denies", async () => {
  const { decision, systemMessage } = await run(
    {
      session_id: "s1",
      cwd: knownRolesProject,
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_input: { subagent_type: "spec-writer", model: "opus", prompt: "audit the credential rotation logic" },
    },
    HERMETIC_ENV,
  );
  assert.equal(decision, "deny");
  assert.equal(systemMessage, securityDeny("spec-writer"));
});

// tool_input is untrusted stdin JSON: a non-string model must take the hard deny, not throw into
// the crash handler's fail-open allow. Its own scratch home, so a crash's guard-crash row (or this
// test's deny rows) stays out of the shared one.
test("issue #1: a non-string model on an ad-hoc keyword hit hard-denies instead of crashing open", async () => {
  const home = await mkdtemp(join(tmpdir(), "praxarch-routeguard-home-"));
  try {
    for (const model of [null, 123, ["opus"], true, {}]) {
      const { decision, systemMessage } = await run(
        {
          session_id: "s1",
          cwd: process.cwd(),
          hook_event_name: "PreToolUse",
          tool_name: "Agent",
          tool_input: { subagent_type: "general-purpose", model, prompt: "audit the credential rotation logic" },
        },
        { PRAXARCH_HOME: home },
      );
      assert.equal(decision, "deny", `expected deny for model: ${JSON.stringify(model)}`);
      assert.equal(systemMessage, securityDeny("general-purpose"), `model: ${JSON.stringify(model)}`);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("issue #1: the security tier matches case-insensitively", async () => {
  for (const model of ["Opus", "OPUS"]) {
    const { decision, systemMessage } = await run(
      {
        session_id: "s1",
        cwd: process.cwd(),
        hook_event_name: "PreToolUse",
        tool_name: "Agent",
        tool_input: { subagent_type: "general-purpose", model, prompt: "audit the credential rotation logic" },
      },
      HERMETIC_ENV,
    );
    assert.equal(decision, "allow", `expected warn-only for model: ${model}`);
    assert.equal(systemMessage, securityWarning("general-purpose"), `model: ${model}`);
  }
});

test("issue #1: an ad-hoc opus call with no subagent_type warns as going to \"unset\"", async () => {
  const { decision, systemMessage } = await run(
    {
      session_id: "s1",
      cwd: process.cwd(),
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_input: { model: "opus", prompt: "audit the credential rotation logic" },
    },
    HERMETIC_ENV,
  );
  assert.equal(decision, "allow");
  assert.equal(systemMessage, securityWarning("unset"));
});

test("issue #1: the warn tier matches security-executor's shipped binding", async () => {
  const template = await readFile(join(here, "..", "..", "templates", "agents", "security-executor.md"), "utf8");
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(template)?.[1] ?? "";
  const model = /^model:\s*(\S+)\s*$/m.exec(frontmatter)?.[1];
  assert.ok(model, "templates/agents/security-executor.md has no model: in its frontmatter");
  const { decision, systemMessage } = await run(
    {
      session_id: "s1",
      cwd: process.cwd(),
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_input: { subagent_type: "general-purpose", model, prompt: "audit the credential rotation logic" },
    },
    HERMETIC_ENV,
  );
  assert.equal(decision, "allow", `security-executor is bound to "${model}", which should warn, not deny`);
  assert.equal(systemMessage, securityWarning("general-purpose"));

  // Issue #18: every tier at or above the security tier warns, so the warn above no longer proves
  // the security tier IS the binding. The tier one rank below it must still deny.
  const { TIER_ORDER, tierOf } = (await import(
    join(TEST_DIST_DIR, "hooks", "lib", "tiers.js")
  )) as typeof import("./lib/tiers.js");
  const bound = tierOf(model);
  assert.ok(bound, `security-executor's model "${model}" is not a known tier`);
  const below = TIER_ORDER[TIER_ORDER.indexOf(bound) - 1];
  if (below !== undefined) {
    const { decision: belowDecision } = await run(
      {
        session_id: "s1",
        cwd: process.cwd(),
        hook_event_name: "PreToolUse",
        tool_name: "Agent",
        tool_input: { subagent_type: "general-purpose", model: below, prompt: "audit the credential rotation logic" },
      },
      HERMETIC_ENV,
    );
    assert.equal(belowDecision, "deny", `"${below}" is below security-executor's "${model}" and should deny`);
  }
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

// --- Deny/warn audit rows (issue #19) -----------------------------------------------------------
// Every deny and every soft-deny warning appends one row, so the security keywords can be tuned on
// logged false positives. Plain allows write nothing. Each case gets a fresh home so "exactly one
// row" counts only its own spawn.

function agentCall(sessionId: string, toolInput: Record<string, unknown>, cwd = process.cwd()): unknown {
  return { session_id: sessionId, cwd, hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: toolInput };
}

async function decideAndReadLog(
  input: unknown,
): Promise<{ decision: string; rows: Record<string, unknown>[] }> {
  const home = await mkdtemp(join(tmpdir(), "praxarch-routeguard-home-"));
  try {
    const { decision } = await run(input, { PRAXARCH_HOME: home });
    const rows = await readMonthlyLog(home).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return [];
      throw err;
    });
    return { decision, rows };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

// Pins the full row: the exact key set, so a row can't quietly grow a field (like the prompt)
// without a test noticing. `at` is checked for shape and then dropped.
function assertOneRow(rows: Record<string, unknown>[], expected: Record<string, unknown>): void {
  assert.equal(rows.length, 1, `expected exactly one row, got ${JSON.stringify(rows)}`);
  const { at, ...rest } = rows[0] ?? {};
  assert.ok(typeof at === "string" && !Number.isNaN(Date.parse(at)), `bad at: ${String(at)}`);
  assert.deepEqual(rest, expected);
}

test("issue #19: a security-keyword deny writes one routeGuardDenied row", async () => {
  const { decision, rows } = await decideAndReadLog(
    agentCall("s-log-kw", { subagent_type: "mech-executor", prompt: "audit the credential rotation logic" }),
  );
  assert.equal(decision, "deny");
  assertOneRow(rows, {
    sessionId: "s-log-kw",
    event: "routeGuardDenied",
    subagentType: "mech-executor",
    rule: "security-keyword",
    matchedKeyword: "credential*",
    strict: true,
  });
});

test("issue #19: an explicit-model-on-role deny writes one row, with matchedKeyword null even when a keyword also matched", async () => {
  for (const [sessionId, toolInput] of [
    ["s-log-model-1", { subagent_type: "executor", model: "sonnet", prompt: "refactor the widget module" }],
    // security-executor skips the keyword check, so "jwt"/"secret" matching here didn't cause the
    // deny; logging it would count as a keyword false positive that never happened.
    ["s-log-model-2", { subagent_type: "security-executor", model: "opus", prompt: "rotate the JWT secret" }],
  ] as const) {
    const { decision, rows } = await decideAndReadLog(agentCall(sessionId, toolInput));
    assert.equal(decision, "deny", sessionId);
    assertOneRow(rows, {
      sessionId,
      event: "routeGuardDenied",
      subagentType: toolInput.subagent_type,
      rule: "explicit-model-on-role",
      matchedKeyword: null,
      strict: true,
    });
  }
});

test("issue #19: an ad-hoc-no-model deny writes one row; a missing subagent_type logs as null", async () => {
  for (const [sessionId, toolInput, subagentType] of [
    ["s-log-adhoc-1", { subagent_type: "general-purpose", prompt: "look into the bug" }, "general-purpose"],
    ["s-log-adhoc-2", { prompt: "look into the bug" }, null],
  ] as const) {
    const { decision, rows } = await decideAndReadLog(agentCall(sessionId, toolInput));
    assert.equal(decision, "deny", sessionId);
    assertOneRow(rows, {
      sessionId,
      event: "routeGuardDenied",
      subagentType,
      rule: "ad-hoc-no-model",
      matchedKeyword: null,
      strict: true,
    });
  }
});

test("issue #19: a soft-deny warning writes one routeGuardWarned row", async () => {
  const { decision, rows } = await decideAndReadLog(
    agentCall("s-log-warn", {
      subagent_type: "general-purpose",
      model: "opus",
      prompt: "audit the credential rotation logic",
    }),
  );
  assert.equal(decision, "allow");
  assertOneRow(rows, {
    sessionId: "s-log-warn",
    event: "routeGuardWarned",
    subagentType: "general-purpose",
    rule: "security-keyword",
    matchedKeyword: "credential*",
    strict: true,
  });
});

// strict:false emits a would-be deny as an allow; the row must still say it was a deny, and say
// it wasn't enforced.
test("issue #19: under strict:false a deny is emitted as an allow but still logs routeGuardDenied with strict false", async () => {
  const { decision, rows } = await decideAndReadLog(
    agentCall("s-log-lax", { subagent_type: "general-purpose", prompt: "look into the bug" }, strictFalseProject),
  );
  assert.equal(decision, "allow");
  assertOneRow(rows, {
    sessionId: "s-log-lax",
    event: "routeGuardDenied",
    subagentType: "general-purpose",
    rule: "ad-hoc-no-model",
    matchedKeyword: null,
    strict: false,
  });
});

test("issue #19: plain allows write no row at all", async () => {
  const home = await mkdtemp(join(tmpdir(), "praxarch-routeguard-home-"));
  try {
    for (const input of [
      { session_id: "s-log-allow", cwd: process.cwd(), hook_event_name: "PreToolUse", tool_name: "Read", tool_input: {} },
      agentCall("s-log-allow", { subagent_type: "executor", prompt: "refactor the widget module" }),
      agentCall("s-log-allow", { subagent_type: "general-purpose", model: "sonnet", prompt: "look into the bug" }),
      agentCall("s-log-allow", { subagent_type: "verifier", prompt: "review the credential rotation diff" }),
      agentCall("s-log-allow", { subagent_type: "security-executor", prompt: "rotate the JWT secret" }),
    ]) {
      const { decision } = await run(input, { PRAXARCH_HOME: home });
      assert.equal(decision, "allow", JSON.stringify(input));
    }
    await assert.rejects(stat(join(home, "logs")), { code: "ENOENT" });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// The append runs after the decision is on stdout. If its failure escaped, main().catch would emit
// a second (allow) object after the real one. So a failed write must leave stdout byte-identical
// to a successful one. `logs` is a plain file, so mkdir fails, while config.json is still a clean
// ENOENT. Pointing PRAXARCH_HOME itself at a file would also add a config warning to the output.
test("issue #19: a log-write failure leaves the emitted decision byte-identical", async () => {
  const goodHome = await mkdtemp(join(tmpdir(), "praxarch-routeguard-home-"));
  const badHome = await mkdtemp(join(tmpdir(), "praxarch-routeguard-badlogs-"));
  await writeFile(join(badHome, "logs"), "not a directory");
  try {
    for (const [event, input] of [
      ["routeGuardDenied", agentCall("s-log-fail", { subagent_type: "mech-executor", prompt: "audit the credential rotation logic" })],
      ["routeGuardDenied", agentCall("s-log-fail", { subagent_type: "executor", model: "sonnet", prompt: "refactor the widget module" })],
      ["routeGuardDenied", agentCall("s-log-fail", { subagent_type: "general-purpose", prompt: "look into the bug" })],
      ["routeGuardWarned", agentCall("s-log-fail", { subagent_type: "general-purpose", model: "opus", prompt: "audit the credential rotation logic" })],
    ] as const) {
      const spawnWith = (home: string) =>
        spawnSync("node", [script], {
          input: JSON.stringify(input),
          env: { ...process.env, PRAXARCH_HOME: home },
          encoding: "utf8",
        });
      const good = spawnWith(goodHome);
      const bad = spawnWith(badHome);
      assert.equal(bad.status, 0, bad.stderr);
      assert.equal(bad.stdout, good.stdout, `${event}: stdout changed when the log write failed`);
      // Proves the write was attempted and failed, so the equality above isn't vacuous.
      assert.match(bad.stderr, new RegExp(`could not append the ${event} audit row`));
    }
  } finally {
    await rm(goodHome, { recursive: true, force: true });
    await rm(badHome, { recursive: true, force: true });
  }
});

// --- Password-hashing terms (issue #1) ----------------------------------------------------------

async function securityDecisionFor(prompt: string, cwd = process.cwd()): Promise<{ decision: string; systemMessage?: string }> {
  return run(
    {
      session_id: "s1",
      cwd,
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_input: { subagent_type: "general-purpose", model: "sonnet", prompt },
    },
    HERMETIC_ENV,
  );
}

// Each prompt contains no other built-in keyword, so dropping any one term from the list flips its
// prompt to allow; the exact message pins which term matched.
test("issue #1: password-hashing terms match on the bare word, each on its own", async () => {
  const failures: string[] = [];
  for (const [keyword, prompt] of [
    ["bcrypt*", "Migrate to bcryptjs"],
    ["argon2*", "Switch the user table to argon2id"],
    ["scrypt", "Use scrypt for the KDF"],
    ["pbkdf2", "Raise the pbkdf2 iteration count"],
  ] as const) {
    const { decision, systemMessage } = await securityDecisionFor(prompt);
    if (decision !== "deny" || systemMessage !== securityDeny("general-purpose", keyword)) {
      failures.push(`${keyword} (${decision}): ${prompt}`);
    }
  }
  assert.deepEqual(failures, []);
});
