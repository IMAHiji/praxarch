import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEST_DIST_DIR } from "../test-support/dist-dir.js";

const script = join(TEST_DIST_DIR, "report", "report.js");

async function withPraxarchHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "praxarch-report-"));
  try {
    return await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

// Isolates the agent-bindings side of the report from whatever happens to be installed on the
// machine running the tests: every call gets its own (by default empty) agents directory unless
// a test explicitly asks for a populated one. Without this, "no delegations" and role-distribution
// tests would silently depend on the real ~/.claude/agents contents of whoever runs `pnpm test`.
async function withAgentsDir<T>(fn: (agentsDir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "praxarch-agents-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function logFilePath(home: string): string {
  const now = new Date();
  return join(home, "logs", `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}.jsonl`);
}

function run(home: string, agentsDir: string, args: string[] = [], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync("node", [script, ...args], {
    env: { ...process.env, PRAXARCH_HOME: home, PRAXARCH_AGENTS_DIR: agentsDir, ...env },
  }).toString("utf8");
}

test("reports 'no delegations' when the log directory doesn't exist", async () => {
  await withPraxarchHome(async (home) => {
    await withAgentsDir(async (agentsDir) => {
      const out = run(home, agentsDir);
      assert.match(out, /No delegations recorded/);
    });
  });
});

test("summarizes role distribution and verifier pass rate", async () => {
  await withPraxarchHome(async (home) => {
    await withAgentsDir(async (agentsDir) => {
      const logDir = join(home, "logs");
      await mkdir(logDir, { recursive: true });
      const file = logFilePath(home);
      const lines = [
        { at: "t1", sessionId: "s1", role: "mech-executor", model: "sonnet", batchId: null, verdict: null, criticalOrMajorCount: null },
        { at: "t2", sessionId: "s1", role: "verifier", model: "opus", batchId: null, verdict: "CONFIRMED", criticalOrMajorCount: 0 },
        { at: "t3", sessionId: "s2", role: "verifier", model: "opus", batchId: null, verdict: "REFUTED", criticalOrMajorCount: 1 },
        { at: "t4", sessionId: "s2", role: "executor", model: "opus", batchId: "batch-1", verdict: null, criticalOrMajorCount: null },
      ];
      await writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

      const out = run(home, agentsDir);
      assert.match(out, /Delegations: 4/);
      assert.match(out, /mech-executor: 1/);
      assert.match(out, /Verifier pass rate: 1\/2 \(50%\)/);
      assert.match(out, /Fan-out batches: 1/);
    });
  });
});

test("excludes fail-open event rows from delegation stats and reports the fail-open total", async () => {
  await withPraxarchHome(async (home) => {
    await withAgentsDir(async (agentsDir) => {
      const logDir = join(home, "logs");
      await mkdir(logDir, { recursive: true });
      const file = logFilePath(home);
      const lines = [
        { at: "t1", sessionId: "s1", role: "mech-executor", model: "sonnet", batchId: null, verdict: null, criticalOrMajorCount: null },
        { at: "t2", sessionId: "s1", event: "verifyGateFailOpen", reason: "loop-guard", detail: "2 consecutive blocks" },
        { at: "t3", sessionId: "s2", event: "verifyGateFailOpen", reason: "error", detail: "boom" },
      ];
      await writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

      const out = run(home, agentsDir);
      // Only the one real delegation counts — the two event rows must not inflate this or produce
      // an "undefined"/"unset" role bucket.
      assert.match(out, /Delegations: 1/);
      assert.doesNotMatch(out, /undefined/);
      assert.match(out, /Verify-gate fail-opens: 2/);
    });
  });
});

// --- Token spend section (acceptance criteria 1-5) ---

test("token spend: mixed legacy and token-bearing rows produce correct per-(role,resolvedModel) totals and unmeasured count", async () => {
  await withPraxarchHome(async (home) => {
    await withAgentsDir(async (agentsDir) => {
      await mkdir(join(home, "logs"), { recursive: true });
      const file = logFilePath(home);
      const lines = [
        // legacy row: no resolvedModel/totalTokens fields at all
        { at: "t1", sessionId: "s1", role: "mech-executor", model: "sonnet", batchId: null, verdict: null, criticalOrMajorCount: null },
        // token-bearing rows, two for the same (role, resolvedModel) pair
        { at: "t2", sessionId: "s1", role: "verifier", model: "opus", resolvedModel: "claude-opus-4", totalTokens: 1000, durationMs: 500, batchId: null, verdict: "CONFIRMED", criticalOrMajorCount: 0 },
        { at: "t3", sessionId: "s2", role: "verifier", model: "opus", resolvedModel: "claude-opus-4", totalTokens: 2000, durationMs: 700, batchId: null, verdict: "REFUTED", criticalOrMajorCount: 1 },
        { at: "t4", sessionId: "s2", role: "executor", model: "opus", resolvedModel: "claude-sonnet-4", totalTokens: 500, durationMs: 300, batchId: null, verdict: null, criticalOrMajorCount: null },
      ];
      await writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

      const out = run(home, agentsDir);
      assert.match(out, /verifier \(claude-opus-4\): 3000 tokens, 2 delegations, 86% of measured/);
      assert.match(out, /executor \(claude-sonnet-4\): 500 tokens, 1 delegations, 14% of measured/);
      assert.match(out, /1 delegations unmeasured \(pre-token-capture\)/);
    });
  });
});

test("token spend: all-legacy fixture reports nothing measured and leaves the rest of the report unchanged", async () => {
  await withPraxarchHome(async (home) => {
    await withAgentsDir(async (agentsDir) => {
      await mkdir(join(home, "logs"), { recursive: true });
      const file = logFilePath(home);
      const lines = [
        { at: "t1", sessionId: "s1", role: "mech-executor", model: "sonnet", batchId: null, verdict: null, criticalOrMajorCount: null },
        { at: "t2", sessionId: "s1", role: "verifier", model: "opus", batchId: null, verdict: "CONFIRMED", criticalOrMajorCount: 0 },
      ];
      await writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

      const out = run(home, agentsDir);
      assert.match(out, /Delegations: 2/);
      assert.match(out, /nothing measured in this window/);
      assert.match(out, /2 delegations unmeasured \(pre-token-capture\)/);
    });
  });
});

test("token spend: --session current restricts token totals to that session's rows", async () => {
  await withPraxarchHome(async (home) => {
    await withAgentsDir(async (agentsDir) => {
      await mkdir(join(home, "logs"), { recursive: true });
      const file = logFilePath(home);
      const lines = [
        { at: "t1", sessionId: "current-session", role: "verifier", model: "opus", resolvedModel: "claude-opus-4", totalTokens: 1000, durationMs: 500, batchId: null, verdict: "CONFIRMED", criticalOrMajorCount: 0 },
        { at: "t2", sessionId: "other-session", role: "verifier", model: "opus", resolvedModel: "claude-opus-4", totalTokens: 9000, durationMs: 500, batchId: null, verdict: "CONFIRMED", criticalOrMajorCount: 0 },
      ];
      await writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

      const out = run(home, agentsDir, ["--session", "current"], { CLAUDE_SESSION_ID: "current-session" });
      assert.match(out, /verifier \(claude-opus-4\): 1000 tokens, 1 delegations, 100% of measured/);
      assert.doesNotMatch(out, /9000/);
    });
  });
});

test("token spend: batch rows produce per-batch subtotals", async () => {
  await withPraxarchHome(async (home) => {
    await withAgentsDir(async (agentsDir) => {
      await mkdir(join(home, "logs"), { recursive: true });
      const file = logFilePath(home);
      const lines = [
        { at: "t1", sessionId: "s1", role: "mech-executor", model: "sonnet", resolvedModel: "claude-sonnet-4", totalTokens: 100, durationMs: 100, batchId: "batch-1", verdict: null, criticalOrMajorCount: null },
        { at: "t2", sessionId: "s1", role: "mech-executor", model: "sonnet", resolvedModel: "claude-sonnet-4", totalTokens: 200, durationMs: 100, batchId: "batch-1", verdict: null, criticalOrMajorCount: null },
        { at: "t3", sessionId: "s1", role: "mech-executor", model: "sonnet", batchId: "batch-1", verdict: null, criticalOrMajorCount: null },
      ];
      await writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

      const out = run(home, agentsDir);
      assert.match(out, /Fan-out batches: 1/);
      assert.match(out, /batch-1: 300 tokens \(2\/3 delegations measured\)/);
    });
  });
});

test("token spend: malformed totalTokens (string/negative/NaN) lands in unmeasured without crashing", async () => {
  await withPraxarchHome(async (home) => {
    await withAgentsDir(async (agentsDir) => {
      await mkdir(join(home, "logs"), { recursive: true });
      const file = logFilePath(home);
      const raw = [
        JSON.stringify({ at: "t1", sessionId: "s1", role: "executor", model: "opus", resolvedModel: "claude-opus-4", totalTokens: "not-a-number", batchId: null, verdict: null, criticalOrMajorCount: null }),
        JSON.stringify({ at: "t2", sessionId: "s1", role: "executor", model: "opus", resolvedModel: "claude-opus-4", totalTokens: -50, batchId: null, verdict: null, criticalOrMajorCount: null }),
        // literal JSON cannot express NaN; simulate the "unparseable numeric value" case directly.
        '{"at":"t3","sessionId":"s1","role":"executor","model":"opus","resolvedModel":"claude-opus-4","totalTokens":NaN,"batchId":null,"verdict":null,"criticalOrMajorCount":null}',
        JSON.stringify({ at: "t4", sessionId: "s1", role: "executor", model: "opus", resolvedModel: "claude-opus-4", totalTokens: 100, batchId: null, verdict: null, criticalOrMajorCount: null }),
      ];
      await writeFile(file, raw.join("\n") + "\n");

      const out = run(home, agentsDir);
      // t3's raw NaN literal isn't valid JSON, so JSON.parse fails and readJsonl skips the whole
      // line (see jsonl.ts) — leaving t1, t2 malformed-but-parseable, and t4 valid.
      assert.doesNotMatch(out, /praxarch report error/);
      assert.match(out, /executor \(claude-opus-4\): 100 tokens, 1 delegations, 100% of measured/);
      assert.match(out, /2 delegations unmeasured \(pre-token-capture\)/);
    });
  });
});

// --- Role bindings section (acceptance criteria 6-8) ---

test("role bindings: builds the binding table, flags a role with no model key as inherited", async () => {
  await withPraxarchHome(async (home) => {
    await withAgentsDir(async (agentsDir) => {
      await writeFile(
        join(agentsDir, "executor.md"),
        "---\nname: executor\nmodel: sonnet\n---\n\nbody text\n",
      );
      await writeFile(
        join(agentsDir, "explore.md"),
        "---\nname: explore\ndescription: no model key here\n---\n\nbody text\n",
      );

      const out = run(home, agentsDir);
      assert.match(out, /executor: bound sonnet/);
      assert.match(out, /explore: inherited \(no binding\)/);
    });
  });
});

test("role bindings: reconciles bound-but-unlogged, logged-but-unbound, and disagreeing bindings", async () => {
  await withPraxarchHome(async (home) => {
    await withAgentsDir(async (agentsDir) => {
      await writeFile(join(agentsDir, "verifier.md"), "---\nname: verifier\nmodel: opus\n---\n\nbody\n");
      await writeFile(join(agentsDir, "scout.md"), "---\nname: scout\nmodel: haiku\n---\n\nbody\n");

      await mkdir(join(home, "logs"), { recursive: true });
      const file = logFilePath(home);
      const lines = [
        // verifier bound opus, but this window only observed it running under a real sonnet model id.
        { at: "t1", sessionId: "s1", role: "verifier", model: "opus", resolvedModel: "claude-sonnet-5", totalTokens: 100, batchId: null, verdict: "CONFIRMED", criticalOrMajorCount: 0 },
        // legacy-role appears in the logs with no corresponding agent file.
        { at: "t2", sessionId: "s1", role: "legacy-role", model: "sonnet", batchId: null, verdict: null, criticalOrMajorCount: null },
      ];
      await writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

      const out = run(home, agentsDir);
      // scout is bound but never appears in the log window.
      assert.match(out, /scout: bound haiku \(unused in this window\)/);
      // verifier's current binding (opus) disagrees with what was actually observed (claude-sonnet-5)
      // — no observation agrees, the pre-existing "none agree" case.
      assert.match(out, /verifier: bound opus; observed claude-sonnet-5 in this window/);
      // legacy-role has no agent file at all.
      assert.match(out, /Unbound\/removed roles observed in logs: legacy-role/);
    });
  });
});

test("role bindings: modelAgrees uses real model-id shapes, not bare tier names", async () => {
  await withPraxarchHome(async (home) => {
    await withAgentsDir(async (agentsDir) => {
      // Finding 4 regression test: a bare tier name like "sonnet" would pass under both the old
      // exact-match implementation and the substring-containment fix, so it can't pin the fix.
      // "claude-opus-4-8" is a real resolvedModel shape and only agrees under substring containment.
      await writeFile(join(agentsDir, "verifier.md"), "---\nname: verifier\nmodel: opus\n---\n\nbody\n");

      await mkdir(join(home, "logs"), { recursive: true });
      const file = logFilePath(home);
      const lines = [
        { at: "t1", sessionId: "s1", role: "verifier", model: "opus", resolvedModel: "claude-opus-4-8", totalTokens: 100, batchId: null, verdict: "CONFIRMED", criticalOrMajorCount: 0 },
      ];
      await writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

      const out = run(home, agentsDir);
      assert.match(out, /verifier: bound opus/);
      assert.doesNotMatch(out, /verifier: bound opus; observed/);
    });
  });
});

test("role bindings: a role with mixed agreeing and disagreeing observations still surfaces the divergence, naming only the diverging model", async () => {
  await withPraxarchHome(async (home) => {
    await withAgentsDir(async (agentsDir) => {
      // Finding 2 regression test: previously the disagreement check only fired when NO observed
      // resolvedModel agreed with the binding. A role observed running under BOTH its bound model
      // and a stray divergent one must still surface the divergence.
      await writeFile(join(agentsDir, "executor.md"), "---\nname: executor\nmodel: sonnet\n---\n\nbody\n");

      await mkdir(join(home, "logs"), { recursive: true });
      const file = logFilePath(home);
      const lines = [
        { at: "t1", sessionId: "s1", role: "executor", model: "sonnet", resolvedModel: "claude-sonnet-5", totalTokens: 100, batchId: null, verdict: null, criticalOrMajorCount: null },
        { at: "t2", sessionId: "s1", role: "executor", model: "sonnet", resolvedModel: "claude-opus-4-8", totalTokens: 100, batchId: null, verdict: null, criticalOrMajorCount: null },
      ];
      await writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

      const out = run(home, agentsDir);
      // Only the diverging model (claude-opus-4-8) is named — the agreeing observation
      // (claude-sonnet-5) must not be listed alongside it as if it were also evidence of drift.
      assert.match(out, /executor: bound sonnet; observed claude-opus-4-8 in this window/);
      assert.doesNotMatch(out, /observed claude-opus-4-8, claude-sonnet-5/);
      assert.doesNotMatch(out, /observed claude-sonnet-5, claude-opus-4-8/);
    });
  });
});

test("role bindings: absent agents directory and a malformed agent file both degrade without crashing", async () => {
  await withPraxarchHome(async (home) => {
    // Absent agents directory case: point at a path that doesn't exist.
    const missingAgentsDir = join(tmpdir(), "praxarch-agents-does-not-exist");
    const outMissing = run(home, missingAgentsDir);
    assert.match(outMissing, /role bindings unavailable \(no agents directory at/i);
    assert.doesNotMatch(outMissing, /praxarch report error/);

    // Malformed agent file alongside a healthy one.
    await withAgentsDir(async (agentsDir) => {
      await writeFile(join(agentsDir, "healthy.md"), "---\nname: healthy\nmodel: sonnet\n---\n\nbody\n");
      await writeFile(join(agentsDir, "broken.md"), "no frontmatter block here at all\n");

      const out = run(home, agentsDir);
      assert.doesNotMatch(out, /praxarch report error/);
      assert.match(out, /healthy: bound sonnet/);
      assert.match(out, /Skipped malformed agent file\(s\): broken\.md/);
    });
  });
});

// --- Model provenance section (issue #24) ---------------------------------------------------
// #7 was filed off a hand-rolled count that read two disjoint sets (540 "inherited" rows, 163
// "general-purpose" rows, zero overlap) as if one were a subset of the other. These fixtures
// reproduce that exact shape and assert the #7 question — "do any general-purpose rows inherit?"
// — is answerable straight from this section's output, with no separate data-analysis pass.

test("model provenance: per-role dispatch count, explicit/inherited split, and distinct resolvedModel values", async () => {
  await withPraxarchHome(async (home) => {
    await withAgentsDir(async (agentsDir) => {
      await mkdir(join(home, "logs"), { recursive: true });
      const file = logFilePath(home);
      const lines = [
        { at: "t1", sessionId: "s1", role: "verifier", model: "inherited", resolvedModel: "claude-opus-4-8", batchId: null, verdict: "CONFIRMED", criticalOrMajorCount: 0 },
        { at: "t2", sessionId: "s1", role: "verifier", model: "inherited", resolvedModel: "claude-sonnet-5", batchId: null, verdict: "CONFIRMED", criticalOrMajorCount: 0 },
        { at: "t3", sessionId: "s2", role: "general-purpose", model: "sonnet", resolvedModel: "claude-sonnet-5", batchId: null, verdict: null, criticalOrMajorCount: null },
        { at: "t4", sessionId: "s2", role: "general-purpose", model: "sonnet", resolvedModel: "claude-sonnet-5", batchId: null, verdict: null, criticalOrMajorCount: null },
      ];
      await writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

      const out = run(home, agentsDir);
      assert.match(out, /Model provenance/);
      assert.match(out, /verifier: 2 dispatch\(es\), 0 explicit \/ 2 inherited, resolvedModel: claude-opus-4-8, claude-sonnet-5/);
      // The #7 question, answered directly: general-purpose rows are 100% explicit, zero inherited
      // — no general-purpose row inherits, straight from this line, no separate join required.
      assert.match(out, /general-purpose: 2 dispatch\(es\), 2 explicit \/ 0 inherited, resolvedModel: claude-sonnet-5/);
    });
  });
});

test("model provenance: a legacy row with no resolvedModel still counts toward the dispatch/split totals", async () => {
  await withPraxarchHome(async (home) => {
    await withAgentsDir(async (agentsDir) => {
      await mkdir(join(home, "logs"), { recursive: true });
      const file = logFilePath(home);
      const lines = [
        { at: "t1", sessionId: "s1", role: "mech-executor", model: "sonnet", batchId: null, verdict: null, criticalOrMajorCount: null },
      ];
      await writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

      const out = run(home, agentsDir);
      assert.match(out, /mech-executor: 1 dispatch\(es\), 1 explicit \/ 0 inherited, resolvedModel: none observed/);
    });
  });
});

test("model provenance: event rows (verifyGateFailOpen) are excluded from the section", async () => {
  await withPraxarchHome(async (home) => {
    await withAgentsDir(async (agentsDir) => {
      await mkdir(join(home, "logs"), { recursive: true });
      const file = logFilePath(home);
      const lines = [
        { at: "t1", sessionId: "s1", event: "verifyGateFailOpen", reason: "error", detail: "boom" },
      ];
      await writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

      const out = run(home, agentsDir);
      assert.match(out, /Model provenance/);
      assert.match(out, /no delegations in this window/);
    });
  });
});

test("model provenance: a record-verdict row (via: record-verdict, model: n/a) is excluded from dispatch counts", async () => {
  await withPraxarchHome(async (home) => {
    await withAgentsDir(async (agentsDir) => {
      await mkdir(join(home, "logs"), { recursive: true });
      const file = logFilePath(home);
      const lines = [
        { at: "t1", sessionId: "s1", role: "verifier", model: "inherited", resolvedModel: "claude-opus-4-8", batchId: null, verdict: "CONFIRMED", criticalOrMajorCount: 0 },
        {
          at: "t2",
          sessionId: "s1",
          role: "verifier",
          model: "n/a",
          resolvedModel: null,
          totalTokens: null,
          durationMs: null,
          batchId: null,
          verdict: "CONFIRMED",
          findingsCount: 0,
          criticalOrMajorCount: 0,
          via: "record-verdict",
        },
      ];
      await writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

      const out = run(home, agentsDir);
      assert.match(out, /Model provenance/);
      // Only the real dispatch counts — the record-verdict row is excluded, not bucketed as
      // "explicit" (model:"n/a" is neither a real explicit model nor "inherited").
      assert.match(out, /verifier: 1 dispatch\(es\), 0 explicit \/ 1 inherited, resolvedModel: claude-opus-4-8/);
    });
  });
});

test("role bindings: a dangling symlink agent file is skipped and named, not a report crash", async () => {
  await withPraxarchHome(async (home) => {
    await withAgentsDir(async (agentsDir) => {
      // Reproduces the real-world case: installed agent files are symlinks into the praxarch repo
      // (~/.claude/agents/*.md -> templates/agents/*.md); a moved/renamed checkout leaves a dangling
      // symlink, and readFile on it throws ENOENT. Before the fix, this crashed the whole report
      // before any output — including sections unrelated to role bindings — was written.
      await writeFile(join(agentsDir, "healthy.md"), "---\nname: healthy\nmodel: sonnet\n---\n\nbody\n");
      await symlink(join(agentsDir, "does-not-exist.md"), join(agentsDir, "dangling.md"));

      const out = run(home, agentsDir);
      assert.doesNotMatch(out, /praxarch report error/);
      assert.match(out, /healthy: bound sonnet/);
      assert.match(out, /Skipped malformed agent file\(s\): .*dangling\.md/);
    });
  });
});

test("counts subagentVerdict rows on their own line and never as delegations", async () => {
  await withPraxarchHome(async (home) => {
    await withAgentsDir(async (agentsDir) => {
      const logDir = join(home, "logs");
      await mkdir(logDir, { recursive: true });
      const file = logFilePath(home);
      const lines = [
        { at: "t1", sessionId: "s1", role: "mech-executor", model: "sonnet", batchId: null, verdict: null, criticalOrMajorCount: null },
        { at: "t2", sessionId: "s1", event: "subagentVerdict", role: "verifier", agentId: "a1", verdict: "CONFIRMED", findingsCount: 0, criticalOrMajorCount: 0 },
        { at: "t3", sessionId: "s1", event: "subagentVerdict", role: "verifier", agentId: "a2", verdict: "REFUTED", findingsCount: 2, criticalOrMajorCount: 1 },
      ];
      await writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

      const out = run(home, agentsDir);
      assert.match(out, /Delegations: 1/);
      assert.match(out, /Automatic verdicts \(SubagentStop\): 1\/2 \(50%\) CONFIRMED/);
      assert.doesNotMatch(out, /^ {2}verifier: /m);
    });
  });
});

test("a log of only subagentVerdict rows still renders a report", async () => {
  await withPraxarchHome(async (home) => {
    await withAgentsDir(async (agentsDir) => {
      const logDir = join(home, "logs");
      await mkdir(logDir, { recursive: true });
      const file = logFilePath(home);
      const lines = [
        { at: "t2", sessionId: "s1", event: "subagentVerdict", role: "verifier", agentId: "a1", verdict: "CONFIRMED", findingsCount: 0, criticalOrMajorCount: 0 },
        { at: "t3", sessionId: "s1", event: "subagentVerdict", role: "verifier", agentId: "a2", verdict: "REFUTED", findingsCount: 2, criticalOrMajorCount: 1 },
      ];
      await writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

      const out = run(home, agentsDir);
      assert.doesNotMatch(out, /No delegations recorded/);
      assert.match(out, /Automatic verdicts \(SubagentStop\): 1\/2/);
    });
  });
});
