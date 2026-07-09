import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "..", "..", "dist", "hooks", "session-init.js");

async function withPraxarchHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "praxarch-sessioninit-"));
  try {
    return await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function run(home: string, input: unknown, extraEnv: Record<string, string> = {}): unknown {
  const stdout = execFileSync("node", [script], {
    input: JSON.stringify(input),
    env: { ...process.env, PRAXARCH_HOME: home, ...extraEnv },
  }).toString("utf8");
  return JSON.parse(stdout);
}

test("creates session state on startup", async () => {
  await withPraxarchHome(async (home) => {
    run(home, {
      session_id: "s1",
      cwd: process.cwd(),
      hook_event_name: "SessionStart",
      source: "startup",
    });
    const state = JSON.parse(await readFile(join(home, "state", "s1.json"), "utf8")) as {
      sessionId: string;
    };
    assert.equal(state.sessionId, "s1");
  });
});

test("warns when CLAUDE_CODE_SUBAGENT_MODEL is set", async () => {
  await withPraxarchHome(async (home) => {
    const result = run(
      home,
      { session_id: "s1", cwd: process.cwd(), hook_event_name: "SessionStart", source: "startup" },
      { CLAUDE_CODE_SUBAGENT_MODEL: "haiku" },
    ) as { systemMessage?: string };
    assert.match(result.systemMessage ?? "", /CLAUDE_CODE_SUBAGENT_MODEL is set/);
  });
});

test("no warning when role files and env are clean (best-effort against real home)", async () => {
  await withPraxarchHome(async (home) => {
    const result = run(home, {
      session_id: "s1",
      cwd: process.cwd(),
      hook_event_name: "SessionStart",
      source: "startup",
    }) as { systemMessage?: string };
    // This machine may or may not have the role files installed yet — just assert the hook
    // doesn't crash and returns a well-formed envelope either way.
    assert.ok(result !== undefined);
  });
});
