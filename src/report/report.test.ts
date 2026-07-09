import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "..", "..", "dist", "report", "report.js");

async function withPraxarchHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "praxarch-report-"));
  try {
    return await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function run(home: string, args: string[] = []): string {
  return execFileSync("node", [script, ...args], {
    env: { ...process.env, PRAXARCH_HOME: home },
  }).toString("utf8");
}

test("reports 'no delegations' when the log directory doesn't exist", async () => {
  await withPraxarchHome(async (home) => {
    const out = run(home);
    assert.match(out, /No delegations recorded/);
  });
});

test("summarizes role distribution and verifier pass rate", async () => {
  await withPraxarchHome(async (home) => {
    const logDir = join(home, "logs");
    await mkdir(logDir, { recursive: true });
    const now = new Date();
    const file = join(logDir, `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}.jsonl`);
    const lines = [
      { at: "t1", sessionId: "s1", role: "mech-executor", model: "sonnet", batchId: null, verdict: null, criticalOrMajorCount: null },
      { at: "t2", sessionId: "s1", role: "verifier", model: "opus", batchId: null, verdict: "CONFIRMED", criticalOrMajorCount: 0 },
      { at: "t3", sessionId: "s2", role: "verifier", model: "opus", batchId: null, verdict: "REFUTED", criticalOrMajorCount: 1 },
      { at: "t4", sessionId: "s2", role: "executor", model: "opus", batchId: "batch-1", verdict: null, criticalOrMajorCount: null },
    ];
    await writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

    const out = run(home);
    assert.match(out, /Delegations: 4/);
    assert.match(out, /mech-executor: 1/);
    assert.match(out, /Verifier pass rate: 1\/2 \(50%\)/);
    assert.match(out, /Fan-out batches: 1/);
  });
});
