import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEST_DIST_DIR } from "../test-support/dist-dir.js";

const script = join(TEST_DIST_DIR, "statusline", "statusline.js");

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

// Writes a state file directly — same approach the existing tests use, so a test never has to know
// which hook would have produced a given field.
async function seedState(home: string, sessionId: string, fields: Record<string, unknown>): Promise<void> {
  await mkdir(join(home, "state"), { recursive: true });
  await writeFile(
    join(home, "state", `${sessionId}.json`),
    JSON.stringify({
      sessionId,
      startedAt: "2026-08-22T00:00:00.000Z",
      delegations: [],
      lastVerifier: null,
      ...fields,
    }),
  );
}

const oneDelegation = [{ role: "executor", model: "sonnet", at: "2026-08-22T00:01:00.000Z" }];

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
    // No verdict on record + real delegated work = exactly what verify-gate would block on.
    assert.equal(run(home, { session_id: "s1" }), "praxarch ▸ exec×1 ✗no verdict");
  });
});

test("shows the verdict-time diff size when the record carries it", async () => {
  await withPraxarchHome(async (home) => {
    await seedState(home, "s1", {
      delegations: oneDelegation,
      lastVerifier: {
        verdict: "CONFIRMED",
        findingsCount: 0,
        criticalOrMajorCount: 0,
        recordedAt: "2026-08-22T00:02:00.000Z",
        diffHash: "abc",
        changedLines: 120,
        changedFiles: 4,
      },
    });
    assert.equal(run(home, { session_id: "s1" }), "praxarch ▸ exec×1 ✓verified@120L/4f");
  });
});

test("a null changedLines suppresses the size suffix entirely", async () => {
  await withPraxarchHome(async (home) => {
    await seedState(home, "s1", {
      delegations: oneDelegation,
      lastVerifier: {
        verdict: "CONFIRMED",
        findingsCount: 0,
        criticalOrMajorCount: 0,
        recordedAt: "2026-08-22T00:02:00.000Z",
        diffHash: "abc",
        changedLines: null,
        changedFiles: 4,
      },
    });
    assert.equal(run(home, { session_id: "s1" }), "praxarch ▸ exec×1 ✓verified");
  });
});

test("a record predating size capture renders no suffix", async () => {
  await withPraxarchHome(async (home) => {
    await seedState(home, "s1", {
      delegations: oneDelegation,
      lastVerifier: {
        verdict: "CONFIRMED",
        findingsCount: 0,
        criticalOrMajorCount: 0,
        recordedAt: "2026-08-22T00:02:00.000Z",
      },
    });
    assert.equal(run(home, { session_id: "s1" }), "praxarch ▸ exec×1 ✓verified");
  });
});

test("a REFUTED verdict shows its critical/major count", async () => {
  await withPraxarchHome(async (home) => {
    await seedState(home, "s1", {
      delegations: oneDelegation,
      lastVerifier: {
        verdict: "REFUTED",
        findingsCount: 3,
        criticalOrMajorCount: 2,
        recordedAt: "2026-08-22T00:02:00.000Z",
      },
    });
    assert.equal(run(home, { session_id: "s1" }), "praxarch ▸ exec×1 ✗unverified(2 crit/major)");
  });
});

test("a REFUTED verdict with zero critical/major has no count suffix", async () => {
  await withPraxarchHome(async (home) => {
    await seedState(home, "s1", {
      delegations: oneDelegation,
      lastVerifier: {
        verdict: "REFUTED",
        findingsCount: 1,
        criticalOrMajorCount: 0,
        recordedAt: "2026-08-22T00:02:00.000Z",
      },
    });
    assert.equal(run(home, { session_id: "s1" }), "praxarch ▸ exec×1 ✗unverified");
  });
});

test("a CONFIRMED verdict carrying critical findings does not read as verified", async () => {
  await withPraxarchHome(async (home) => {
    await seedState(home, "s1", {
      delegations: oneDelegation,
      lastVerifier: {
        verdict: "CONFIRMED",
        findingsCount: 1,
        criticalOrMajorCount: 1,
        recordedAt: "2026-08-22T00:02:00.000Z",
      },
    });
    assert.equal(run(home, { session_id: "s1" }), "praxarch ▸ exec×1 ✗unverified(1 crit/major)");
  });
});

test("a standing waiver is shown alongside, never instead of, the verdict state", async () => {
  await withPraxarchHome(async (home) => {
    await seedState(home, "s1", {
      delegations: oneDelegation,
      verifyGateWaivedHash: "deadbeef",
    });
    assert.equal(run(home, { session_id: "s1" }), "praxarch ▸ exec×1 ✗no verdict waived");
  });
});

test("an empty-string waiver hash renders nothing", async () => {
  await withPraxarchHome(async (home) => {
    await seedState(home, "s1", {
      delegations: oneDelegation,
      verifyGateWaivedHash: "",
    });
    assert.equal(run(home, { session_id: "s1" }), "praxarch ▸ exec×1 ✗no verdict");
  });
});

test("blocks already spent this cycle are shown even with no delegations", async () => {
  await withPraxarchHome(async (home) => {
    await seedState(home, "s1", {
      verifyGateCycleBlocks: 2,
    });
    assert.equal(run(home, { session_id: "s1" }), "praxarch ▸ blocked×2");
  });
});

test("a zero cycle-block counter renders nothing", async () => {
  await withPraxarchHome(async (home) => {
    await seedState(home, "s1", {
      delegations: oneDelegation,
      verifyGateCycleBlocks: 0,
      lastVerifier: {
        verdict: "CONFIRMED",
        findingsCount: 0,
        criticalOrMajorCount: 0,
        recordedAt: "2026-08-22T00:02:00.000Z",
      },
    });
    assert.equal(run(home, { session_id: "s1" }), "praxarch ▸ exec×1 ✓verified");
  });
});

// Pins the constraint that decides this whole feature: the statusline renders on a ~300ms debounce
// and must never shell out. A `git` on PATH that records every invocation proves it — the marker
// file must not exist after a render.
test("the statusline spawns no git subprocess", async () => {
  await withPraxarchHome(async (home) => {
    await seedState(home, "s1", {
      delegations: oneDelegation,
      lastVerifier: {
        verdict: "CONFIRMED",
        findingsCount: 0,
        criticalOrMajorCount: 0,
        recordedAt: "2026-08-22T00:02:00.000Z",
        diffHash: "abc",
        changedLines: 120,
        changedFiles: 4,
      },
    });
    const shimDir = await mkdtemp(join(tmpdir(), "praxarch-statusline-shim-"));
    const marker = join(shimDir, "git-was-called");
    try {
      await writeFile(join(shimDir, "git"), `#!/bin/sh\necho called >> "${marker}"\nexit 0\n`, "utf8");
      await chmod(join(shimDir, "git"), 0o755);
      const out = execFileSync("node", [script], {
        input: JSON.stringify({ session_id: "s1" }),
        env: { ...process.env, PRAXARCH_HOME: home, PATH: `${shimDir}:${process.env["PATH"] ?? ""}` },
      }).toString("utf8");
      assert.equal(out, "praxarch ▸ exec×1 ✓verified@120L/4f");
      await assert.rejects(() => stat(marker), "the statusline must not invoke git");
    } finally {
      await rm(shimDir, { recursive: true, force: true });
    }
  });
});
