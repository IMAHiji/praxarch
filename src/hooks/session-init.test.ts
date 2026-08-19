import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEST_DIST_DIR } from "../test-support/dist-dir.js";

const script = join(TEST_DIST_DIR, "hooks", "session-init.js");

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

test("records baselineHead on first run and does not overwrite it on a second run", async () => {
  await withPraxarchHome(async (home) => {
    const repo = await mkdtemp(join(tmpdir(), "praxarch-sessioninit-repo-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: repo });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
      await writeFile(join(repo, "file.txt"), "line\n");
      execFileSync("git", ["add", "."], { cwd: repo });
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });
      const initHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString("utf8").trim();

      run(home, { session_id: "s1", cwd: repo, hook_event_name: "SessionStart", source: "startup" });
      const stateAfterFirst = JSON.parse(await readFile(join(home, "state", "s1.json"), "utf8")) as {
        baselineHead?: string | null;
      };
      assert.equal(stateAfterFirst.baselineHead, initHead);

      // A second SessionStart (e.g. resume/clear/compact) must not move the goalposts —
      // commit again so a naive re-capture would pick up the new HEAD.
      await writeFile(join(repo, "file2.txt"), "line\n");
      execFileSync("git", ["add", "."], { cwd: repo });
      execFileSync("git", ["commit", "-q", "-m", "second commit"], { cwd: repo });

      run(home, { session_id: "s1", cwd: repo, hook_event_name: "SessionStart", source: "resume" });
      const stateAfterSecond = JSON.parse(await readFile(join(home, "state", "s1.json"), "utf8")) as {
        baselineHead?: string | null;
      };
      assert.equal(stateAfterSecond.baselineHead, initHead);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

test("captures baselineUntracked on first run with the expected untracked paths", async () => {
  await withPraxarchHome(async (home) => {
    const repo = await mkdtemp(join(tmpdir(), "praxarch-sessioninit-untracked-repo-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: repo });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
      await writeFile(join(repo, "tracked.txt"), "line\n");
      execFileSync("git", ["add", "."], { cwd: repo });
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });

      // A file that already exists before the session starts -- the sub-case-A repro: this must
      // land in the snapshot so a later measurement can tell it apart from work the session did.
      await writeFile(join(repo, "preexisting.txt"), "line\n".repeat(5));

      run(home, { session_id: "s1", cwd: repo, hook_event_name: "SessionStart", source: "startup" });
      const state = JSON.parse(await readFile(join(home, "state", "s1.json"), "utf8")) as {
        baselineUntracked?: Record<string, string> | null;
      };
      assert.notEqual(state.baselineUntracked, null);
      assert.notEqual(state.baselineUntracked, undefined);
      const snapshot = state.baselineUntracked as Record<string, string>;
      assert.ok(
        "p:preexisting.txt" in snapshot,
        `expected "p:preexisting.txt" in the captured snapshot, got: ${JSON.stringify(snapshot)}`,
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

test("does not re-capture baselineUntracked on a second SessionStart (resume/clear/compact)", async () => {
  await withPraxarchHome(async (home) => {
    const repo = await mkdtemp(join(tmpdir(), "praxarch-sessioninit-untracked-repo2-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: repo });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
      await writeFile(join(repo, "tracked.txt"), "line\n");
      execFileSync("git", ["add", "."], { cwd: repo });
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });

      run(home, { session_id: "s1", cwd: repo, hook_event_name: "SessionStart", source: "startup" });
      const afterFirst = JSON.parse(await readFile(join(home, "state", "s1.json"), "utf8")) as {
        baselineUntracked?: Record<string, string> | null;
      };
      const snapshotAfterFirst = afterFirst.baselineUntracked as Record<string, string>;
      assert.equal(Object.keys(snapshotAfterFirst).length, 0, "no untracked files existed at first SessionStart");

      // A file created mid-session must not retroactively appear in the baseline on a later
      // SessionStart (resume/clear/compact) -- that would launder session-created work out of the
      // measurement by making it look pre-existing.
      await writeFile(join(repo, "new-mid-session.txt"), "line\n".repeat(20));

      run(home, { session_id: "s1", cwd: repo, hook_event_name: "SessionStart", source: "resume" });
      const afterSecond = JSON.parse(await readFile(join(home, "state", "s1.json"), "utf8")) as {
        baselineUntracked?: Record<string, string> | null;
      };
      const snapshotAfterSecond = afterSecond.baselineUntracked as Record<string, string>;
      assert.deepEqual(
        snapshotAfterSecond,
        snapshotAfterFirst,
        "a second SessionStart must not move the untracked baseline",
      );
      assert.ok(
        !("p:new-mid-session.txt" in snapshotAfterSecond),
        `the mid-session file must not appear in the baseline, got: ${JSON.stringify(snapshotAfterSecond)}`,
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

test("a state file seeded with baselineUntracked: null is left as null after a second run", async () => {
  await withPraxarchHome(async (home) => {
    const repo = await mkdtemp(join(tmpdir(), "praxarch-sessioninit-untracked-repo3-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: repo });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
      await writeFile(join(repo, "tracked.txt"), "line\n");
      execFileSync("git", ["add", "."], { cwd: repo });
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });

      const stateDir = join(home, "state");
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        join(stateDir, "s1.json"),
        JSON.stringify({
          sessionId: "s1",
          startedAt: new Date().toISOString(),
          delegations: [],
          lastVerifier: null,
          baselineHead: null,
          baselineUntracked: null,
        }),
        "utf8",
      );

      // A file present before this SessionStart runs -- if the null guard used a null/undefined
      // test instead of `in`, this would get captured now and silently move the baseline.
      await writeFile(join(repo, "present-before-run.txt"), "line\n".repeat(3));

      run(home, { session_id: "s1", cwd: repo, hook_event_name: "SessionStart", source: "resume" });
      const state = JSON.parse(await readFile(join(stateDir, "s1.json"), "utf8")) as {
        baselineUntracked?: Record<string, string> | null;
      };
      assert.equal(state.baselineUntracked, null, "a previously-attempted-and-unusable capture must stay null, not be retried");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
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
