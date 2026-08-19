import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

async function fileExistsForTest(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
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

test("captures the untracked baseline into its own file on first run, with a marker (not the snapshot) in session state", async () => {
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
        baselineUntrackedCaptured?: boolean;
        baselineUntracked?: unknown;
      };
      assert.equal(state.baselineUntrackedCaptured, true);
      assert.equal(
        state.baselineUntracked,
        undefined,
        "the snapshot content must never be inlined into session state -- only the marker belongs there",
      );

      const snapshot = JSON.parse(await readFile(join(home, "state", "s1.untracked.json"), "utf8")) as Record<
        string,
        string
      > | null;
      assert.notEqual(snapshot, null);
      assert.ok(
        "p:preexisting.txt" in (snapshot as Record<string, string>),
        `expected "p:preexisting.txt" in the captured snapshot, got: ${JSON.stringify(snapshot)}`,
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

test("does not re-capture the untracked baseline on a second SessionStart (resume/clear/compact)", async () => {
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
      const snapshotAfterFirst = JSON.parse(
        await readFile(join(home, "state", "s1.untracked.json"), "utf8"),
      ) as Record<string, string>;
      assert.equal(Object.keys(snapshotAfterFirst).length, 0, "no untracked files existed at first SessionStart");

      // A file created mid-session must not retroactively appear in the baseline on a later
      // SessionStart (resume/clear/compact) -- that would launder session-created work out of the
      // measurement by making it look pre-existing.
      await writeFile(join(repo, "new-mid-session.txt"), "line\n".repeat(20));

      run(home, { session_id: "s1", cwd: repo, hook_event_name: "SessionStart", source: "resume" });
      const snapshotAfterSecond = JSON.parse(
        await readFile(join(home, "state", "s1.untracked.json"), "utf8"),
      ) as Record<string, string>;
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

test("a state file seeded with the marker already set and a null snapshot is left untouched after a second run", async () => {
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
          baselineUntrackedCaptured: true,
        }),
        "utf8",
      );
      await writeFile(join(stateDir, "s1.untracked.json"), JSON.stringify(null), "utf8");

      // A file present before this SessionStart runs -- if the marker guard used a null/undefined
      // test instead of `in`, this would get captured now and silently move the baseline.
      await writeFile(join(repo, "present-before-run.txt"), "line\n".repeat(3));

      run(home, { session_id: "s1", cwd: repo, hook_event_name: "SessionStart", source: "resume" });
      const state = JSON.parse(await readFile(join(stateDir, "s1.json"), "utf8")) as {
        baselineUntrackedCaptured?: boolean;
      };
      assert.equal(state.baselineUntrackedCaptured, true);
      const snapshot = JSON.parse(await readFile(join(stateDir, "s1.untracked.json"), "utf8")) as unknown;
      assert.equal(snapshot, null, "a previously-attempted-and-unusable capture must stay null, not be retried");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

test("Minor 4: a legacy state file (predates the field entirely) never captures the untracked baseline, even on resume", async () => {
  await withPraxarchHome(async (home) => {
    const repo = await mkdtemp(join(tmpdir(), "praxarch-sessioninit-legacy-repo-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: repo });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
      await writeFile(join(repo, "tracked.txt"), "line\n");
      execFileSync("git", ["add", "."], { cwd: repo });
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });

      // A pre-field state shape: no baselineUntrackedCaptured key at all, exactly what a session
      // that began before this feature existed looks like on disk.
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
        }),
        "utf8",
      );

      // Repro: mid-session work exists, then the session hits resume/clear/compact under the new
      // code. A `source`-blind guard would capture this file as if it pre-existed the session --
      // laundering the session's own work into the baseline.
      await writeFile(join(repo, "mid-session-work.txt"), "line\n".repeat(10));

      run(home, { session_id: "s1", cwd: repo, hook_event_name: "SessionStart", source: "resume" });

      const state = JSON.parse(await readFile(join(stateDir, "s1.json"), "utf8")) as {
        baselineUntrackedCaptured?: boolean;
      };
      assert.equal(
        state.baselineUntrackedCaptured,
        undefined,
        "a legacy state file must never gain the marker from a non-startup SessionStart",
      );

      const snapshotPath = join(stateDir, "s1.untracked.json");
      assert.equal(
        await fileExistsForTest(snapshotPath),
        false,
        "a legacy state file on resume must never write an untracked snapshot at all",
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

test(
  "Major 3: the session state file (the hot-path write) does not grow with the number of untracked files -- the snapshot lives in its own file",
  { timeout: 60_000 },
  async () => {
    await withPraxarchHome(async (home) => {
      // Baseline: no untracked files at SessionStart.
      const emptyRepo = await mkdtemp(join(tmpdir(), "praxarch-sessioninit-bloat-empty-"));
      // Comparison: many untracked files at SessionStart (the measured repro used 1999).
      const bigRepo = await mkdtemp(join(tmpdir(), "praxarch-sessioninit-bloat-big-"));
      try {
        for (const repo of [emptyRepo, bigRepo]) {
          execFileSync("git", ["init", "-q"], { cwd: repo });
          execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
          execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
          await writeFile(join(repo, "tracked.txt"), "line\n");
          execFileSync("git", ["add", "."], { cwd: repo });
          execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });
        }
        for (let i = 0; i < 500; i++) {
          await writeFile(join(bigRepo, `untracked-${i}.txt`), `content ${i}\n`.repeat(20));
        }

        run(home, { session_id: "empty", cwd: emptyRepo, hook_event_name: "SessionStart", source: "startup" });
        run(home, { session_id: "big", cwd: bigRepo, hook_event_name: "SessionStart", source: "startup" });

        const emptyStateSize = (await readFile(join(home, "state", "empty.json"), "utf8")).length;
        const bigStateSize = (await readFile(join(home, "state", "big.json"), "utf8")).length;
        const bigSnapshotSize = (await readFile(join(home, "state", "big.untracked.json"), "utf8")).length;

        assert.ok(
          bigSnapshotSize > 10_000,
          `test setup assumption: 500 untracked files should produce a snapshot file well over 10KB, got ${bigSnapshotSize} bytes`,
        );
        // The regression this test pins: state (the file every PostToolUse re-reads,
        // re-parses, re-serializes, and re-writes) must stay essentially flat regardless of how
        // large the untracked snapshot is, because the snapshot is no longer inlined into it.
        assert.ok(
          bigStateSize < emptyStateSize + 200,
          `expected the state file to stay flat regardless of untracked-file count (empty: ${emptyStateSize} bytes, big: ${bigStateSize} bytes, snapshot: ${bigSnapshotSize} bytes)`,
        );
      } finally {
        await rm(emptyRepo, { recursive: true, force: true });
        await rm(bigRepo, { recursive: true, force: true });
      }
    });
  },
);

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
