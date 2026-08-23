import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEST_DIST_DIR } from "../../test-support/dist-dir.js";

const { readSessionState, writeSessionState } = (await import(
  join(TEST_DIST_DIR, "hooks", "lib", "session-state.js")
)) as typeof import("./session-state.js");

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
