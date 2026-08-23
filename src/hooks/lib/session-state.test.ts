import { test } from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readdir, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEST_DIST_DIR } from "../../test-support/dist-dir.js";

const { readSessionState, writeSessionState, updateSessionState } = (await import(
  join(TEST_DIST_DIR, "hooks", "lib", "session-state.js")
)) as typeof import("./session-state.js");
const { sessionLockPath } = (await import(join(TEST_DIST_DIR, "hooks", "lib", "paths.js"))) as typeof import("./paths.js");

async function withHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "praxarch-session-state-"));
  const prevHome = process.env["PRAXARCH_HOME"];
  process.env["PRAXARCH_HOME"] = home;
  try {
    await fn(home);
  } finally {
    if (prevHome === undefined) delete process.env["PRAXARCH_HOME"];
    else process.env["PRAXARCH_HOME"] = prevHome;
    await rm(home, { recursive: true, force: true });
  }
}

test("writeSessionState round-trips and leaves no temp file behind", async () => {
  await withHome(async (home) => {
    await writeSessionState({
      sessionId: "s1",
      delegations: [],
      lastVerifier: null,
      baselineHead: "abc",
      startedAt: new Date().toISOString(),
    });
    const result = await readSessionState("s1");
    assert.equal(result.baselineHead, "abc");
    assert.deepEqual(await readdir(join(home, "state")), ["s1.json"]);
  });
});

test("a truncated state file is quarantined and reads as empty state", async () => {
  await withHome(async (home) => {
    await mkdir(join(home, "state"), { recursive: true });
    await writeFile(join(home, "state", "s2.json"), '{"sessionId":"s2","delegat');
    const result = await readSessionState("s2");
    assert.equal(result.lastVerifier, null);
    assert.equal(result.delegations.length, 0);
    assert.equal(result.sessionId, "s2");
    const entries = await readdir(join(home, "state"));
    assert.ok(!entries.includes("s2.json"));
    const corruptEntries = entries.filter((entry) => /^s2\.json\.corrupt-\d+$/.test(entry));
    assert.equal(corruptEntries.length, 1, JSON.stringify(entries));
  });
});

test("well-formed JSON that isn't an object is quarantined too", async () => {
  await withHome(async (home) => {
    await mkdir(join(home, "state"), { recursive: true });
    await writeFile(join(home, "state", "s3.json"), "null");
    const result = await readSessionState("s3");
    assert.equal(result.lastVerifier, null);
    assert.equal(result.delegations.length, 0);
    assert.equal(result.sessionId, "s3");
    const entries = await readdir(join(home, "state"));
    assert.ok(!entries.includes("s3.json"));
    const corruptEntries = entries.filter((entry) => /^s3\.json\.corrupt-\d+$/.test(entry));
    assert.equal(corruptEntries.length, 1, JSON.stringify(entries));
  });
});

test("a non-ENOENT read failure still throws", async () => {
  await withHome(async (home) => {
    await mkdir(join(home, "state", "s4.json"), { recursive: true });
    await assert.rejects(() => readSessionState("s4"));
  });
});

test("concurrent updateSessionState calls all land", async () => {
  await withHome(async () => {
    await writeSessionState({
      sessionId: "c1",
      delegations: [],
      lastVerifier: null,
      baselineHead: null,
      startedAt: new Date().toISOString(),
    });
    // Without the lock this lands 1: all twenty read the same snapshot.
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        updateSessionState("c1", (s) => {
          s.delegations.push({
            role: `r${i}`,
            model: "inherited",
            resolvedModel: null,
            totalTokens: null,
            durationMs: null,
            at: new Date().toISOString(),
          });
        }),
      ),
    );
    const result = await readSessionState("c1");
    assert.equal(result.delegations.length, 20);
  });
});

test("a stale lock is broken rather than waited out", async () => {
  await withHome(async (home) => {
    await mkdir(join(home, "state"), { recursive: true });
    const lockPath = sessionLockPath("c2");
    await writeFile(lockPath, "99999\nstale\n", "utf8");
    const staleTime = new Date(Date.now() - 60_000);
    await utimes(lockPath, staleTime, staleTime);
    const start = Date.now();
    await updateSessionState("c2", (s) => {
      s.baselineHead = "x";
    });
    assert.ok(Date.now() - start < 1000, "a stale lock must be broken, not waited out");
    const result = await readSessionState("c2");
    assert.equal(result.baselineHead, "x");
  });
});

test("a live lock is waited for, then acquired", async () => {
  await withHome(async (home) => {
    await mkdir(join(home, "state"), { recursive: true });
    const lockPath = sessionLockPath("c3");
    await writeFile(lockPath, `${process.pid}\n${new Date().toISOString()}\n`, "utf8");
    setTimeout(() => {
      void unlink(lockPath);
    }, 200);
    await updateSessionState("c3", (s) => {
      s.baselineHead = "y";
    });
    const result = await readSessionState("c3");
    assert.equal(result.baselineHead, "y");
  });
});

test("the lock file is removed after a successful update", async () => {
  await withHome(async () => {
    await updateSessionState("c4", (s) => {
      s.baselineHead = "z";
    });
    await assert.rejects(() => lstat(sessionLockPath("c4")), { code: "ENOENT" });
  });
});

test("a throwing mutate still releases the lock", async () => {
  await withHome(async () => {
    await assert.rejects(() =>
      updateSessionState("c5", () => {
        throw new Error("boom");
      }),
    );
    await assert.rejects(() => lstat(sessionLockPath("c5")), { code: "ENOENT" });
  });
});

test("updateSessionState lands and creates the lock dir even when the state dir is absent", async () => {
  await withHome(async (home) => {
    // No `state` dir has been created yet — nothing in this test creates one before the update.
    await assert.rejects(() => lstat(join(home, "state")), { code: "ENOENT" });

    await updateSessionState("c6", (s) => {
      s.baselineHead = "w";
    });

    // acquireSessionLock's ENOENT-recovery mkdir must have created the state dir for the lock
    // file to have been openable at all — this is the effect that regresses to a silent unlocked
    // no-op if that recovery path is missing.
    const stateDirStat = await lstat(join(home, "state"));
    assert.ok(stateDirStat.isDirectory());

    const result = await readSessionState("c6");
    assert.equal(result.baselineHead, "w");
  });
});
