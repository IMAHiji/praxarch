import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
      JSON.stringify({ verifyGate: { verdictRoles: ["spec-reviewer"] } }),
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
      tool_input: { subagent_type: "spec-reviewer" },
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
      tool_input: { subagent_type: "ghost-role" },
      tool_response: { status: "completed", content: [{ type: "text", text: reviewText }] },
    });

    const statePath = join(home, "state", "s1.json");
    const state = JSON.parse(await readFile(statePath, "utf8")) as {
      lastVerifier?: { verdict: string } | null;
    };
    assert.ok(!state.lastVerifier);
  });
});

test("stores a diff fingerprint (hash + counts) alongside a parsed verdict", async () => {
  await withPraxarchHome(async (home) => {
    const repo = await mkdtemp(join(tmpdir(), "praxarch-telemetry-repo-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: repo });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
      await writeFile(join(repo, "file.txt"), "line\n".repeat(5));
      execFileSync("git", ["add", "."], { cwd: repo });
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });
      await writeFile(join(repo, "file.txt"), "changed line\n".repeat(5));

      const verifierText = ["```json", JSON.stringify({ verdict: "CONFIRMED", findings: [] }), "```"].join(
        "\n",
      );

      run(home, {
        session_id: "s1",
        cwd: repo,
        hook_event_name: "PostToolUse",
        tool_name: "Agent",
        tool_input: { subagent_type: "verifier", model: "opus" },
        tool_response: { status: "completed", content: [{ type: "text", text: verifierText }] },
      });

      const statePath = join(home, "state", "s1.json");
      const state = JSON.parse(await readFile(statePath, "utf8")) as {
        lastVerifier: {
          diffHash: string | null;
          changedLines: number | null;
          changedFiles: number | null;
        };
      };
      assert.equal(typeof state.lastVerifier.diffHash, "string");
      assert.ok((state.lastVerifier.diffHash ?? "").length > 0);
      assert.equal(state.lastVerifier.changedLines, 10);
      assert.equal(state.lastVerifier.changedFiles, 1);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

test("stores nulls (without throwing) when the fingerprint can't be computed, but keeps the valid verdict fields", async () => {
  await withPraxarchHome(async (home) => {
    const repo = await mkdtemp(join(tmpdir(), "praxarch-telemetry-fpfail-repo-"));
    const fakeGitDir = await mkdtemp(join(tmpdir(), "praxarch-telemetry-fakegit-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: repo });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
      await writeFile(join(repo, "file.txt"), "line\n".repeat(5));
      execFileSync("git", ["add", "."], { cwd: repo });
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });
      await writeFile(join(repo, "file.txt"), "changed line\n".repeat(5));

      const realGit = execFileSync("which", ["git"]).toString("utf8").trim();
      // Fails `git status` — the call diffFingerprint's null contract depends on — while leaving
      // --numstat and ls-files (diffStat's calls) working, so the counts below still come through.
      const fakeGitScript = [
        "#!/bin/sh",
        'case "$*" in',
        `  *--numstat*) exec "${realGit}" "$@" ;;`,
        `  *ls-files*) exec "${realGit}" "$@" ;;`,
        '  status*) echo "fake git: status failed" >&2; exit 1 ;;',
        `  *) exec "${realGit}" "$@" ;;`,
        "esac",
      ].join("\n");
      await writeFile(join(fakeGitDir, "git"), `${fakeGitScript}\n`, "utf8");
      await execFileSync("chmod", ["755", join(fakeGitDir, "git")]);

      const verifierText = ["```json", JSON.stringify({ verdict: "CONFIRMED", findings: [] }), "```"].join(
        "\n",
      );

      execFileSync("node", [script], {
        input: JSON.stringify({
          session_id: "s1",
          cwd: repo,
          hook_event_name: "PostToolUse",
          tool_name: "Agent",
          tool_input: { subagent_type: "verifier", model: "opus" },
          tool_response: { status: "completed", content: [{ type: "text", text: verifierText }] },
        }),
        env: { ...process.env, PRAXARCH_HOME: home, PATH: `${fakeGitDir}:${process.env["PATH"] ?? ""}` },
      });

      const statePath = join(home, "state", "s1.json");
      const state = JSON.parse(await readFile(statePath, "utf8")) as {
        lastVerifier: {
          verdict: string;
          diffHash: string | null;
          changedLines: number | null;
          changedFiles: number | null;
        };
      };
      // The verdict itself and the counts (from --numstat, unaffected by the status failure) are
      // still recorded correctly — only the hash comes back null.
      assert.equal(state.lastVerifier.verdict, "CONFIRMED");
      assert.equal(state.lastVerifier.diffHash, null);
      assert.equal(state.lastVerifier.changedLines, 10);
      assert.equal(state.lastVerifier.changedFiles, 1);
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(fakeGitDir, { recursive: true, force: true });
    }
  });
});

test("a corrupt session state file does not lose the delegation log row (JSONL append happens before state is touched)", async () => {
  await withPraxarchHome(async (home) => {
    const stateDir = join(home, "state");
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "s1.json"), "{ not valid json");

    const verifierText = ["```json", JSON.stringify({ verdict: "CONFIRMED", findings: [] }), "```"].join(
      "\n",
    );

    // readSessionState will throw on this corrupt file (non-ENOENT JSON.parse error) — main()'s
    // outer catch swallows it (telemetry must stay non-blocking), but the delegation row must
    // already be on disk by the time that happens.
    run(home, {
      session_id: "s1",
      cwd: process.cwd(),
      hook_event_name: "PostToolUse",
      tool_name: "Agent",
      tool_input: { subagent_type: "verifier", model: "opus" },
      tool_response: { status: "completed", content: [{ type: "text", text: verifierText }] },
    });

    const logContent = await readFile(monthlyLogPath(home), "utf8");
    const record = JSON.parse(logContent.trim()) as { role: string; verdict: string };
    assert.equal(record.role, "verifier");
    assert.equal(record.verdict, "CONFIRMED");
  });
});

test("never shells out to git at all when no verdict was parsed (role not in verdictRoles)", async () => {
  await withPraxarchHome(async (home) => {
    const repo = await mkdtemp(join(tmpdir(), "praxarch-telemetry-nogit-repo-"));
    const logDir = await mkdtemp(join(tmpdir(), "praxarch-telemetry-nogit-log-"));
    const logPath = join(logDir, "invocations.log");
    await writeFile(logPath, "");
    // A fake `git` that logs every invocation and otherwise behaves like the real one -- used to
    // assert diffStat/diffFingerprint are never reached for a non-verdict role, not just that the
    // hash comes back null (round 2's deleted counting-shim coverage gap).
    const realGit = execFileSync("which", ["git"]).toString("utf8").trim();
    const fakeGitDir = await mkdtemp(join(tmpdir(), "praxarch-telemetry-fakegit2-"));
    const fakeGitScript = ["#!/bin/sh", `echo "$*" >> "${logPath}"`, `exec "${realGit}" "$@"`].join("\n");
    await writeFile(join(fakeGitDir, "git"), `${fakeGitScript}\n`, "utf8");
    await execFileSync("chmod", ["755", join(fakeGitDir, "git")]);
    try {
      execFileSync("git", ["init", "-q"], { cwd: repo });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
      await writeFile(join(repo, "file.txt"), "line\n".repeat(5));
      execFileSync("git", ["add", "."], { cwd: repo });
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });

      execFileSync("node", [script], {
        input: JSON.stringify({
          session_id: "s1",
          cwd: repo,
          hook_event_name: "PostToolUse",
          tool_name: "Agent",
          tool_input: { subagent_type: "mech-executor", model: "sonnet" },
          tool_response: { status: "completed", content: [{ type: "text", text: "done, no verdict" }] },
        }),
        env: { ...process.env, PRAXARCH_HOME: home, PATH: `${fakeGitDir}:${process.env["PATH"] ?? ""}` },
      });

      const log = await readFile(logPath, "utf8");
      assert.equal(log.trim(), "", `expected no git invocation at all, got: ${log}`);
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(logDir, { recursive: true, force: true });
      await rm(fakeGitDir, { recursive: true, force: true });
    }
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
