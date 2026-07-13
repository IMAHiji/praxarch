import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "..", "..", "dist", "statusline", "statusline.js");

async function withPraxarchHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "praxarch-statusline-"));
  try {
    return await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function run(home: string, input: unknown): string {
  return execFileSync("node", [script], {
    input: JSON.stringify(input),
    env: { ...process.env, PRAXARCH_HOME: home },
  }).toString("utf8");
}

test("prints bare name when no session id is provided", async () => {
  await withPraxarchHome(async (home) => {
    assert.equal(run(home, {}), "praxarch");
  });
});

test("prints idle for a session with no delegations", async () => {
  await withPraxarchHome(async (home) => {
    assert.equal(run(home, { session_id: "s1" }), "praxarch ▸ idle");
  });
});

test("summarizes role counts, token spend, and verifier status", async () => {
  await withPraxarchHome(async (home) => {
    await mkdir(join(home, "state"), { recursive: true });
    await writeFile(
      join(home, "state", "s1.json"),
      JSON.stringify({
        sessionId: "s1",
        startedAt: "2026-07-09T00:00:00.000Z",
        delegations: [
          { role: "scout", model: "inherited", resolvedModel: "claude-haiku-4-5-20251001", totalTokens: 8225, durationMs: 2937, at: "2026-07-09T00:01:00.000Z" },
          { role: "scout", model: "inherited", resolvedModel: "claude-haiku-4-5-20251001", totalTokens: 4000, durationMs: 1500, at: "2026-07-09T00:02:00.000Z" },
          { role: "verifier", model: "inherited", resolvedModel: "claude-opus-4-8", totalTokens: 35452, durationMs: 140082, at: "2026-07-09T00:03:00.000Z" },
        ],
        lastVerifier: { verdict: "CONFIRMED", findingsCount: 0, criticalOrMajorCount: 0, recordedAt: "2026-07-09T00:03:00.000Z" },
      }),
    );
    assert.equal(run(home, { session_id: "s1" }), "praxarch ▸ scout×2 verify×1 48k tok ✓verified");
  });
});

test("tolerates old-format delegation records without token fields", async () => {
  await withPraxarchHome(async (home) => {
    await mkdir(join(home, "state"), { recursive: true });
    await writeFile(
      join(home, "state", "s1.json"),
      JSON.stringify({
        sessionId: "s1",
        startedAt: "2026-07-09T00:00:00.000Z",
        delegations: [{ role: "executor", model: "sonnet", at: "2026-07-09T00:01:00.000Z" }],
        lastVerifier: null,
      }),
    );
    assert.equal(run(home, { session_id: "s1" }), "praxarch ▸ exec×1");
  });
});
