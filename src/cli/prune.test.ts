import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEST_DIST_DIR } from "../test-support/dist-dir.js";

const cli = join(TEST_DIST_DIR, "cli", "index.js");
const DAY_MS = 24 * 60 * 60 * 1000;

interface Fixture {
  home: string;
}

async function setupFixture(): Promise<Fixture> {
  const home = await mkdtemp(join(tmpdir(), "praxarch-prune-home-"));
  return { home };
}

async function teardownFixture(fixture: Fixture): Promise<void> {
  await rm(fixture.home, { recursive: true, force: true });
}

async function writeAged(path: string, ageDays: number): Promise<void> {
  await writeFile(path, "{}");
  const when = new Date(Date.now() - ageDays * DAY_MS);
  await utimes(path, when, when);
}

async function seedFixture(fixture: Fixture): Promise<void> {
  const state = join(fixture.home, "state");
  const debug = join(fixture.home, "debug");
  await mkdir(state, { recursive: true });
  await mkdir(debug, { recursive: true });
  await writeAged(join(state, "old.json"), 60);
  await writeAged(join(state, "old.untracked.json"), 60);
  await writeAged(join(state, "fresh.json"), 0);
  await writeAged(join(state, "cur.json"), 60);
  await writeAged(join(debug, "old-payload.json"), 10);
  await writeAged(join(debug, "new-payload.json"), 0);
}

function runCli(
  fixture: Fixture,
  args: string[],
  extraEnv: Record<string, string | undefined> = {},
): { stdout: string; stderr: string; status: number } {
  const env: Record<string, string | undefined> = {
    ...process.env,
    PRAXARCH_TARGET_CLAUDE_HOME: fixture.home,
    PRAXARCH_HOME: fixture.home,
    PRAXARCH_TEST_DIST_DIR: TEST_DIST_DIR,
    ...extraEnv,
  };
  delete env["CLAUDE_SESSION_ID"];
  if (extraEnv["CLAUDE_SESSION_ID"] !== undefined) {
    env["CLAUDE_SESSION_ID"] = extraEnv["CLAUDE_SESSION_ID"];
  }
  const result = spawnSync("node", [cli, ...args], { env });
  return {
    stdout: result.stdout?.toString("utf8") ?? "",
    stderr: result.stderr?.toString("utf8") ?? "",
    status: result.status ?? 1,
  };
}

test("doctor --prune deletes only files past the retention window", async () => {
  const fixture = await setupFixture();
  try {
    await seedFixture(fixture);
    const result = runCli(fixture, ["doctor", "--prune"], { CLAUDE_SESSION_ID: "cur" });
    assert.equal(result.status, 0);
    const stateFiles = (await readdir(join(fixture.home, "state"))).sort();
    assert.deepEqual(stateFiles, ["cur.json", "fresh.json"]);
    const debugFiles = await readdir(join(fixture.home, "debug"));
    assert.deepEqual(debugFiles, ["new-payload.json"]);
    assert.match(
      result.stdout,
      /pruned 2 state file\(s\) older than 30 day\(s\) and 1 debug payload\(s\) older than 7 day\(s\); kept 2 state file\(s\), 1 debug payload\(s\)\./,
    );
  } finally {
    await teardownFixture(fixture);
  }
});

test("the current session's files are never deleted even when stale", async () => {
  const fixture = await setupFixture();
  try {
    await seedFixture(fixture);
    const result = runCli(fixture, ["doctor", "--prune"], { CLAUDE_SESSION_ID: undefined });
    assert.equal(result.status, 0);
    const stateFiles = (await readdir(join(fixture.home, "state"))).sort();
    assert.ok(!stateFiles.includes("cur.json"));
  } finally {
    await teardownFixture(fixture);
  }
});

test("custom retention windows are honoured", async () => {
  const fixture = await setupFixture();
  try {
    await seedFixture(fixture);
    const result = runCli(fixture, ["doctor", "--prune"], {
      PRAXARCH_STATE_RETENTION_DAYS: "90",
      PRAXARCH_DEBUG_RETENTION_DAYS: "30",
    });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /pruned 0 state file\(s\) older than 90 day\(s\)/);
  } finally {
    await teardownFixture(fixture);
  }
});

test("a missing state or debug directory is not an error", async () => {
  const fixture = await setupFixture();
  try {
    const result = runCli(fixture, ["doctor", "--prune"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /pruned 0 state file\(s\)/);
  } finally {
    await teardownFixture(fixture);
  }
});

test("plain doctor reports prunable counts without failing", async () => {
  const fixture = await setupFixture();
  try {
    await seedFixture(fixture);
    const result = runCli(fixture, ["doctor"]);
    assert.match(result.stdout, /state retention: 3 of 4 state file\(s\) and 1 of 2 debug payload\(s\)/);
    assert.match(result.stdout, /✓ state retention:/);
  } finally {
    await teardownFixture(fixture);
  }
});

test("doctor --prune never touches logs/", async () => {
  const fixture = await setupFixture();
  try {
    await seedFixture(fixture);
    const logs = join(fixture.home, "logs");
    await mkdir(logs, { recursive: true });
    await writeAged(join(logs, "2020-01.jsonl"), 60);
    const result = runCli(fixture, ["doctor", "--prune"], { CLAUDE_SESSION_ID: "cur" });
    assert.equal(result.status, 0);
    const logFiles = await readdir(logs);
    assert.ok(logFiles.includes("2020-01.jsonl"));
  } finally {
    await teardownFixture(fixture);
  }
});
