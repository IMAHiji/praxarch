import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { getMkfifoProbe as GetMkfifoProbe } from "./fixtures/mkfifo-probe.js";
import { TEST_DIST_DIR } from "../../test-support/dist-dir.js";

const { readSessionState, writeSessionState, updateSessionState } = (await import(
  join(TEST_DIST_DIR, "hooks", "lib", "session-state.js")
)) as typeof import("./session-state.js");
const { sessionLockPath } = (await import(join(TEST_DIST_DIR, "hooks", "lib", "paths.js"))) as typeof import("./paths.js");
const { appendJsonl } = (await import(join(TEST_DIST_DIR, "hooks", "lib", "jsonl.js"))) as typeof import("./jsonl.js");
// Same convention as untracked.test.ts: `which mkfifo` only proves the binary is on PATH, not
// that mkfifo(2) actually works in this sandbox, so the real probe creates one and lstats it.
const { getMkfifoProbe } = (await import(
  join(TEST_DIST_DIR, "hooks", "lib", "fixtures", "mkfifo-probe.js")
)) as { getMkfifoProbe: typeof GetMkfifoProbe };
const mkfifoProbeResult = await getMkfifoProbe();
const hasMkfifo = mkfifoProbeResult.ok;
const mkfifoSkipReason = mkfifoProbeResult.reason ?? "mkfifo not available on this platform";

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

// issue #3: appendJsonl opens O_NONBLOCK so a writerless FIFO fails its open() fast (ENXIO)
// instead of hanging forever in it — the root-cause fix for a watchdog-SIGKILL workaround in
// verify-gate.ts's fireWatchdog. Bounded with a race against a deadline, not a bare await, so a
// regression back to blocking semantics fails this test instead of hanging the suite.
test(
  "issue #3: appendJsonl on a writerless FIFO rejects with ENXIO within 1s",
  { skip: hasMkfifo ? false : mkfifoSkipReason },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "praxarch-jsonl-fifo-"));
    try {
      const fifoPath = join(dir, "log.jsonl");
      execFileSync("mkfifo", [fifoPath]);
      const result = await Promise.race([
        appendJsonl(fifoPath, { at: "x" }).then(
          () => ({ ok: true as const }),
          (err: unknown) => ({ ok: false as const, err }),
        ),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("appendJsonl did not settle within 1s")), 1000),
        ),
      ]);
      assert.equal(result.ok, false);
      assert.equal((result as { err: unknown }).err instanceof Error, true);
      assert.equal(((result as { err: NodeJS.ErrnoException }).err).code, "ENXIO");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("issue #3: appendJsonl writes exactly one line and appends on a second call", async () => {
  const dir = await mkdtemp(join(tmpdir(), "praxarch-jsonl-normal-"));
  try {
    const logPath = join(dir, "log.jsonl");
    await appendJsonl(logPath, { at: "one" });
    const afterFirst = (await readFile(logPath, "utf8")).split("\n").filter((line) => line.length > 0);
    assert.deepEqual(afterFirst, [JSON.stringify({ at: "one" })]);

    await appendJsonl(logPath, { at: "two" });
    const afterSecond = (await readFile(logPath, "utf8")).split("\n").filter((line) => line.length > 0);
    assert.deepEqual(afterSecond, [JSON.stringify({ at: "one" }), JSON.stringify({ at: "two" })]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// issue #3: `handle.write` can write fewer bytes than asked -- a FIFO with an idle reader, or
// ENOSPC/EDQUOT partway through a row on a regular file. `appendFile` used to loop internally and
// throw on a stuck write; the O_NONBLOCK `open`/`write` rewrite above dropped that loop and let a
// short write resolve as success, leaving a torn line on disk. These two tests fake
// `fs.promises.open` (via `node:test`'s module mock, the same pattern as
// git-diff.test.ts's ignore-before-read test) so a short write is reproducible without racing a
// real FIFO reader. The mock's `namedExports` must stay exhaustive over every name jsonl.ts pulls
// from "node:fs/promises" (mkdir, open, readFile) or the cache-busted reimport below fails to
// link -- mkdir and readFile pass straight through to the real implementations already imported
// at the top of this file.
test("issue #3: appendJsonl loops on a short write until the full row lands", async (t) => {
  const record = { at: "short-write-probe", note: "a row long enough to make a 5-byte first write plainly partial" };
  const expected = `${JSON.stringify(record)}\n`;
  const written: Buffer[] = [];
  let writeCalls = 0;
  const jsonlUrl = pathToFileURL(join(TEST_DIST_DIR, "hooks", "lib", "jsonl.js")).href;
  t.mock.module("node:fs/promises", {
    namedExports: {
      mkdir,
      readFile,
      open: async () => ({
        write: async (buf: Buffer, offset: number, length: number) => {
          writeCalls += 1;
          // First call only makes 5 bytes of progress -- plainly less than the full row -- so a
          // caller that doesn't loop leaves the remaining bytes unwritten.
          const chunkLen = writeCalls === 1 ? Math.min(5, length) : length;
          const chunk = Buffer.from(buf.subarray(offset, offset + chunkLen));
          written.push(chunk);
          return { bytesWritten: chunkLen, buffer: buf };
        },
        close: async () => undefined,
      }),
    },
  });
  const freshJsonl = (await import(`${jsonlUrl}?shortwrite=${Date.now()}`)) as typeof import("./jsonl.js");
  const dir = await mkdtemp(join(tmpdir(), "praxarch-jsonl-shortwrite-"));
  try {
    // mkdir passes straight through to the real implementation above; open is faked, so nothing
    // is actually created at this path -- it only has to be a real, writable directory.
    await freshJsonl.appendJsonl(join(dir, "short-write.jsonl"), record);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  assert.ok(writeCalls >= 2, `expected the short first write to force a retry, got ${writeCalls} call(s)`);
  assert.equal(Buffer.concat(written).toString("utf8"), expected);
});

test("issue #3: appendJsonl throws rather than spin when a write makes zero progress", async (t) => {
  const jsonlUrl = pathToFileURL(join(TEST_DIST_DIR, "hooks", "lib", "jsonl.js")).href;
  let closed = false;
  t.mock.module("node:fs/promises", {
    namedExports: {
      mkdir,
      readFile,
      open: async () => ({
        // EAGAIN-shaped: the write resolves (does not reject) but makes no progress at all, the
        // way a full non-blocking FIFO does. A caller that busy-loops on this never returns; one
        // that throws surfaces it as a rejected append instead.
        write: async () => ({ bytesWritten: 0, buffer: Buffer.alloc(0) }),
        close: async () => {
          closed = true;
        },
      }),
    },
  });
  const freshJsonl = (await import(`${jsonlUrl}?zerowrite=${Date.now()}`)) as typeof import("./jsonl.js");
  const dir = await mkdtemp(join(tmpdir(), "praxarch-jsonl-zerowrite-"));
  try {
    await assert.rejects(() => freshJsonl.appendJsonl(join(dir, "zero-write.jsonl"), { at: "x" }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  assert.equal(closed, true, "the handle must still be closed after a zero-progress write throws");
});
