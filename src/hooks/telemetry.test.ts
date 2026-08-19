import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
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

test("stores null changedLines/changedFiles (not zeros, and without throwing) when diffStat's own measurement fails", async () => {
  // Issue #2: diffStat now returns null (not {0, 0}) when its own numstat probe fails inside a
  // real repo. telemetry's try/catch around diffStat used to assume a thrown exception was the
  // only failure mode; a null return without a throw must also leave both fields null, not crash
  // on a destructure of null and not silently record zeros.
  await withPraxarchHome(async (home) => {
    const repo = await mkdtemp(join(tmpdir(), "praxarch-telemetry-statfail-repo-"));
    const fakeGitDir = await mkdtemp(join(tmpdir(), "praxarch-telemetry-fakegit-numstat-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: repo });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
      await writeFile(join(repo, "file.txt"), "line\n".repeat(5));
      execFileSync("git", ["add", "."], { cwd: repo });
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });
      await writeFile(join(repo, "file.txt"), "changed line\n".repeat(5));

      const realGit = execFileSync("which", ["git"]).toString("utf8").trim();
      // Fails --numstat itself (the diffStat probe) while leaving `status` working, so the hash
      // still comes through -- isolating the diffStat-specific null path from the diffFingerprint
      // one the test above already covers.
      const fakeGitScript = [
        "#!/bin/sh",
        'case "$*" in',
        `  *--numstat*) echo "fake git: numstat probe failed" >&2; exit 1 ;;`,
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
      // The verdict and hash (unaffected by the numstat failure) are still recorded -- only the
      // counts come back null.
      assert.equal(state.lastVerifier.verdict, "CONFIRMED");
      assert.equal(typeof state.lastVerifier.diffHash, "string");
      assert.equal(state.lastVerifier.changedLines, null);
      assert.equal(state.lastVerifier.changedFiles, null);
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

// --- Interleaving tests (issue #4: telemetry's write must merge, not clobber, a concurrent
// verify-gate write that lands between telemetry's own read and write) -------------------------
//
// The seam: `diffStat`/`diffFingerprint` shell out to `git`, and telemetry's read-to-write window
// spans those calls. Putting a fake `git` earlier on PATH lets a test land an arbitrary
// verify-gate-shaped write *during* that window with no changes to production code.
//
// The residual window (after the hoist in this fix) is `readSessionState` -> `diffStat` -> the
// merge-write — `diffFingerprint` (the `git status` call) now runs *before* the read, so it is
// outside the window and must not be where the injection fires. `diffStat` calls `git diff
// --numstat` (via `trackedDiff`) first, and that call happens after the read — so the fake
// matches on `--numstat` appearing in argv, not on "first invocation", and fires the injected
// write there. Matching on argv (rather than counting calls) also means this doesn't quietly
// break again if the git-call order is ever reshuffled — the seam only fires when Node is really
// about to run `git diff --numstat`, wherever that lands in the sequence.
function initGitRepo(repo: string): void {
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
}

async function buildInterleavingGit(
  fakeGitDir: string,
  injectScriptPath: string,
  markerPath: string,
): Promise<void> {
  const realGit = execFileSync("which", ["git"]).toString("utf8").trim();
  const script = [
    "#!/bin/sh",
    'case "$*" in',
    "  *--numstat*)",
    `    if [ ! -f "${markerPath}" ]; then`,
    `      touch "${markerPath}"`,
    `      node "${injectScriptPath}"`,
    "    fi",
    `    exec "${realGit}" "$@"`,
    "    ;;",
    `  *) exec "${realGit}" "$@" ;;`,
    "esac",
  ].join("\n");
  await writeFile(join(fakeGitDir, "git"), `${script}\n`, "utf8");
  execFileSync("chmod", ["755", join(fakeGitDir, "git")]);
}

// Reads the (possibly not-yet-created) session state file, applies `mutate`, and writes the whole
// object back — the same whole-object write shape verify-gate's real read-modify-write cycles use.
function injectScriptSource(statePath: string, sessionId: string, mutateSource: string): string {
  return [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    `const STATE_PATH = ${JSON.stringify(statePath)};`,
    `const SESSION_ID = ${JSON.stringify(sessionId)};`,
    "let state;",
    "try {",
    "  state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));",
    "} catch {",
    "  state = { sessionId: SESSION_ID, startedAt: new Date().toISOString(), delegations: [], lastVerifier: null, baselineHead: null };",
    "}",
    mutateSource,
    "fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });",
    "fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));",
  ].join("\n");
}

function verdictText(verdict: "CONFIRMED" | "REFUTED"): string {
  return ["```json", JSON.stringify({ verdict, findings: [] }), "```"].join("\n");
}

async function withInterleavingSetup(
  mutateSource: string,
  fn: (ctx: { home: string; repo: string; statePath: string }) => Promise<void>,
): Promise<void> {
  await withPraxarchHome(async (home) => {
    const repo = await mkdtemp(join(tmpdir(), "praxarch-telemetry-interleave-repo-"));
    const fakeGitDir = await mkdtemp(join(tmpdir(), "praxarch-telemetry-interleave-git-"));
    const statePath = join(home, "state", "s1.json");
    const injectScriptPath = join(fakeGitDir, "inject.cjs");
    const markerPath = join(fakeGitDir, "fired");
    try {
      initGitRepo(repo);
      await writeFile(join(repo, "file.txt"), "line\n".repeat(5));
      execFileSync("git", ["add", "."], { cwd: repo });
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });
      await writeFile(join(repo, "file.txt"), "changed line\n".repeat(5));

      await writeFile(injectScriptPath, injectScriptSource(statePath, "s1", mutateSource), "utf8");
      await buildInterleavingGit(fakeGitDir, injectScriptPath, markerPath);

      execFileSync("node", [script], {
        input: JSON.stringify({
          session_id: "s1",
          cwd: repo,
          hook_event_name: "PostToolUse",
          tool_name: "Agent",
          tool_input: { subagent_type: "verifier", model: "opus" },
          tool_response: { status: "completed", content: [{ type: "text", text: verdictText("CONFIRMED") }] },
        }),
        env: { ...process.env, PRAXARCH_HOME: home, PATH: `${fakeGitDir}:${process.env["PATH"] ?? ""}` },
      });

      await fn({ home, repo, statePath });
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(fakeGitDir, { recursive: true, force: true });
    }
  });
}

test("merges a verify-gate counter increment that lands between telemetry's read and write", async () => {
  await withInterleavingSetup("state.verifyGateConsecutiveBlocks = 5;", async ({ statePath }) => {
    const state = JSON.parse(await readFile(statePath, "utf8")) as {
      verifyGateConsecutiveBlocks?: number;
      delegations: unknown[];
      lastVerifier: { verdict: string } | null;
    };
    assert.equal(state.verifyGateConsecutiveBlocks, 5, "the concurrent counter increment must survive");
    assert.equal(state.delegations.length, 1, "telemetry's own delegation must still be recorded");
    assert.equal(state.lastVerifier?.verdict, "CONFIRMED");
  });
});

test("merges a verify-gate clearBlockCounters reset that lands between telemetry's read and write", async () => {
  const mutate = [
    "state.verifyGateConsecutiveBlocks = 7;",
    "state.verifyGateBlockHash = 'deadbeef';",
    "state.verifyGateCycleBlocks = 3;",
    "fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });",
    "fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));",
    // Second write, inside the same injected script invocation, mimics clearBlockCounters
    // clearing what it just set — both writes land inside telemetry's window.
    "state.verifyGateConsecutiveBlocks = 0;",
    "state.verifyGateBlockHash = null;",
    "state.verifyGateCycleBlocks = 0;",
  ].join("\n");
  await withInterleavingSetup(mutate, async ({ statePath }) => {
    const state = JSON.parse(await readFile(statePath, "utf8")) as {
      verifyGateConsecutiveBlocks?: number;
      verifyGateBlockHash?: string | null;
      verifyGateCycleBlocks?: number;
      delegations: unknown[];
      lastVerifier: { verdict: string } | null;
    };
    assert.equal(state.verifyGateConsecutiveBlocks, 0);
    assert.equal(state.verifyGateBlockHash, null);
    assert.equal(state.verifyGateCycleBlocks, 0);
    assert.equal(state.delegations.length, 1);
    assert.equal(state.lastVerifier?.verdict, "CONFIRMED");
  });
});

test("merges a verify-gate waiver hash write that lands between telemetry's read and write", async () => {
  await withInterleavingSetup("state.verifyGateWaivedHash = 'waivedhash123';", async ({ statePath }) => {
    const state = JSON.parse(await readFile(statePath, "utf8")) as {
      verifyGateWaivedHash?: string;
      delegations: unknown[];
      lastVerifier: { verdict: string } | null;
    };
    assert.equal(state.verifyGateWaivedHash, "waivedhash123");
    assert.equal(state.delegations.length, 1);
    assert.equal(state.lastVerifier?.verdict, "CONFIRMED");
  });
});

test("two verdict-recording telemetry runs racing each other: last verdict wins, both delegations survive", async () => {
  await withPraxarchHome(async (home) => {
    const repo = await mkdtemp(join(tmpdir(), "praxarch-telemetry-race-repo-"));
    const fakeGitDir = await mkdtemp(join(tmpdir(), "praxarch-telemetry-race-git-"));
    const startedMarker = join(fakeGitDir, "a-started");
    const goMarker = join(fakeGitDir, "b-done");
    try {
      initGitRepo(repo);
      await writeFile(join(repo, "file.txt"), "line\n".repeat(5));
      execFileSync("git", ["add", "."], { cwd: repo });
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });
      await writeFile(join(repo, "file.txt"), "changed line\n".repeat(5));

      // Run A's fake `git`: A's `diffFingerprint` call (git status, before the read) runs
      // normally, so A actually reads state first. Only A's `diffStat` call — `git diff
      // --numstat`, which runs after the read — signals it has started and blocks until B has
      // fully completed, so B's write is guaranteed to land inside A's real read-to-write window,
      // not before A has read at all.
      const realGit = execFileSync("which", ["git"]).toString("utf8").trim();
      const aGitScript = [
        "#!/bin/sh",
        'case "$*" in',
        "  *--numstat*)",
        `    if [ ! -f "${startedMarker}" ]; then`,
        `      touch "${startedMarker}"`,
        `      while [ ! -f "${goMarker}" ]; do sleep 0.05; done`,
        "    fi",
        `    exec "${realGit}" "$@"`,
        "    ;;",
        `  *) exec "${realGit}" "$@" ;;`,
        "esac",
      ].join("\n");
      await writeFile(join(fakeGitDir, "git"), `${aGitScript}\n`, "utf8");
      execFileSync("chmod", ["755", join(fakeGitDir, "git")]);

      const runA = new Promise<void>((resolve, reject) => {
        const child = spawn("node", [script], {
          env: { ...process.env, PRAXARCH_HOME: home, PATH: `${fakeGitDir}:${process.env["PATH"] ?? ""}` },
        });
        child.stdin.end(
          JSON.stringify({
            session_id: "s1",
            cwd: repo,
            hook_event_name: "PostToolUse",
            tool_name: "Agent",
            tool_input: { subagent_type: "verifier", model: "opus" },
            tool_response: { status: "completed", content: [{ type: "text", text: verdictText("CONFIRMED") }] },
          }),
        );
        child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`A exited ${code}`))));
        child.on("error", reject);
      });

      // Wait for A to be mid-window (blocked in its fake git), then run B to full completion on
      // the real, unmodified PATH — B's read, write, and exit all happen while A is parked.
      const deadline = Date.now() + 5000;
      while (!existsSync(startedMarker)) {
        if (Date.now() > deadline) throw new Error("A never reached its git call");
        await new Promise((r) => setTimeout(r, 20));
      }

      execFileSync("node", [script], {
        input: JSON.stringify({
          session_id: "s1",
          cwd: repo,
          hook_event_name: "PostToolUse",
          tool_name: "Agent",
          tool_input: { subagent_type: "verifier", model: "opus" },
          tool_response: { status: "completed", content: [{ type: "text", text: verdictText("REFUTED") }] },
        }),
        env: { ...process.env, PRAXARCH_HOME: home },
      });

      await writeFile(goMarker, "go");
      await runA;

      const statePath = join(home, "state", "s1.json");
      const state = JSON.parse(await readFile(statePath, "utf8")) as {
        delegations: unknown[];
        lastVerifier: { verdict: string } | null;
      };
      assert.equal(state.delegations.length, 2, "both racing runs' delegations must survive");
      // A (CONFIRMED) is the one that finishes last, since B ran to completion entirely inside
      // A's window — its verdict must be the one left standing.
      assert.equal(state.lastVerifier?.verdict, "CONFIRMED");
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(fakeGitDir, { recursive: true, force: true });
    }
  });
});

test("diffHash invariant: a merged record's diffHash is present-and-null after a failed fingerprint, never absent", async () => {
  await withPraxarchHome(async (home) => {
    const repo = await mkdtemp(join(tmpdir(), "praxarch-telemetry-diffhash-repo-"));
    const fakeGitDir = await mkdtemp(join(tmpdir(), "praxarch-telemetry-diffhash-git-"));
    const statePath = join(home, "state", "s1.json");
    const injectScriptPath = join(fakeGitDir, "inject.cjs");
    const markerPath = join(fakeGitDir, "fired");
    try {
      initGitRepo(repo);
      await writeFile(join(repo, "file.txt"), "line\n".repeat(5));
      execFileSync("git", ["add", "."], { cwd: repo });
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });
      await writeFile(join(repo, "file.txt"), "changed line\n".repeat(5));

      await writeFile(
        injectScriptPath,
        injectScriptSource(statePath, "s1", "state.verifyGateConsecutiveBlocks = 9;"),
        "utf8",
      );

      // Fails `git status` (diffFingerprint's call, which now runs before the read) on every
      // invocation, so the fingerprint comes back null while --numstat/ls-files (diffStat, which
      // runs after the read) still work — forcing the merged record through the failed-fingerprint
      // path. The injected write fires on the `--numstat` call specifically, so it lands inside
      // the real read-to-write window rather than during the (pre-read) failing status call.
      const realGit = execFileSync("which", ["git"]).toString("utf8").trim();
      const fakeGitScript = [
        "#!/bin/sh",
        'case "$*" in',
        "  *--numstat*)",
        `    if [ ! -f "${markerPath}" ]; then`,
        `      touch "${markerPath}"`,
        `      node "${injectScriptPath}"`,
        "    fi",
        `    exec "${realGit}" "$@"`,
        "    ;;",
        `  *ls-files*) exec "${realGit}" "$@" ;;`,
        '  status*) echo "fake git: status failed" >&2; exit 1 ;;',
        `  *) exec "${realGit}" "$@" ;;`,
        "esac",
      ].join("\n");
      await writeFile(join(fakeGitDir, "git"), `${fakeGitScript}\n`, "utf8");
      execFileSync("chmod", ["755", join(fakeGitDir, "git")]);

      execFileSync("node", [script], {
        input: JSON.stringify({
          session_id: "s1",
          cwd: repo,
          hook_event_name: "PostToolUse",
          tool_name: "Agent",
          tool_input: { subagent_type: "verifier", model: "opus" },
          tool_response: { status: "completed", content: [{ type: "text", text: verdictText("CONFIRMED") }] },
        }),
        env: { ...process.env, PRAXARCH_HOME: home, PATH: `${fakeGitDir}:${process.env["PATH"] ?? ""}` },
      });

      const state = JSON.parse(await readFile(statePath, "utf8")) as {
        verifyGateConsecutiveBlocks?: number;
        lastVerifier: { verdict: string } | null;
      };
      // Concurrent write still merged in.
      assert.equal(state.verifyGateConsecutiveBlocks, 9);
      // The merge went through `JSON.stringify` (writeSessionState), so the invariant that must
      // hold on disk is: the key is present with value `null`, not absent, not `undefined`.
      const raw = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
      const lastVerifier = raw["lastVerifier"] as Record<string, unknown>;
      assert.ok("diffHash" in lastVerifier, "diffHash key must be present, not dropped by the merge");
      assert.equal(lastVerifier["diffHash"], null);
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(fakeGitDir, { recursive: true, force: true });
    }
  });
});

// Every fixture above terminates its text at the closing fence, so none of them can observe
// post-fence behavior. This one puts trailing prose after the closing fence (a closing remark, as
// the un-tightened role prompts used to illustrate) — extractTrailingJson must return null, so
// telemetry must not crash, must still append the delegation-log row (verdict: null, not the
// prose-adjacent block's value), and must leave session state's `lastVerifier` untouched.
test("does not record a verdict when trailing prose follows the closing fence", async () => {
  await withPraxarchHome(async (home) => {
    const verifierText = [
      "```json",
      JSON.stringify({ verdict: "CONFIRMED", findings: [] }),
      "```",
      "",
      "That is all.",
    ].join("\n");

    run(home, {
      session_id: "s1",
      cwd: process.cwd(),
      hook_event_name: "PostToolUse",
      tool_name: "Agent",
      tool_input: { subagent_type: "verifier", model: "opus" },
      tool_response: { status: "completed", content: [{ type: "text", text: verifierText }] },
    });

    const logContent = await readFile(monthlyLogPath(home), "utf8");
    const record = JSON.parse(logContent.trim()) as { verdict: string | null };
    assert.equal(record.verdict, null);

    const statePath = join(home, "state", "s1.json");
    const state = JSON.parse(await readFile(statePath, "utf8")) as {
      lastVerifier: unknown;
      delegations: unknown[];
    };
    assert.equal(state.lastVerifier, null);
    assert.equal(state.delegations.length, 1);
  });
});

// summarizeVerdict throws MalformedVerdictError for a verdict value outside CONFIRMED/REFUTED.
// telemetry.ts is a non-blocking observer (unlike record-verdict.ts), so this must behave exactly
// like the trailing-prose case above: the delegation-log row is still appended (verdict: null) and
// session state is still written — the throw must not unwind out of main() and erase both.
test("still records the delegation row and state when the verdict value is out of range", async () => {
  await withPraxarchHome(async (home) => {
    const verifierText = ["```json", JSON.stringify({ verdict: "MAYBE", findings: [] }), "```"].join("\n");

    run(home, {
      session_id: "s1",
      cwd: process.cwd(),
      hook_event_name: "PostToolUse",
      tool_name: "Agent",
      tool_input: { subagent_type: "verifier", model: "opus" },
      tool_response: { status: "completed", content: [{ type: "text", text: verifierText }] },
    });

    const logContent = await readFile(monthlyLogPath(home), "utf8");
    const record = JSON.parse(logContent.trim()) as { verdict: string | null };
    assert.equal(record.verdict, null);

    const statePath = join(home, "state", "s1.json");
    const state = JSON.parse(await readFile(statePath, "utf8")) as {
      lastVerifier: unknown;
      delegations: unknown[];
    };
    assert.equal(state.lastVerifier, null);
    assert.equal(state.delegations.length, 1);
  });
});
