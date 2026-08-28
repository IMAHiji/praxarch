import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm, writeFile, mkdir, symlink, lstat, readlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { TEST_DIST_DIR } from "../test-support/dist-dir.js";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(TEST_DIST_DIR, "cli", "index.js");

interface Fixture {
  claudeHome: string;
}

async function setupFixture(): Promise<Fixture> {
  const claudeHome = await mkdtemp(join(tmpdir(), "praxarch-cli-home-"));
  return { claudeHome };
}

async function teardownFixture(fixture: Fixture): Promise<void> {
  await rm(fixture.claudeHome, { recursive: true, force: true });
}

function runCli(
  fixture: Fixture,
  args: string[],
  cliPath = cli,
  extraEnv: Record<string, string> = {},
): { stdout: string; stderr: string; status: number } {
  // The default `cli` is spawned straight out of TEST_DIST_DIR, so its own DIST_DIR must resolve
  // to that same tree (real dist/ under plain `pnpm test`, the scratch tree under `pnpm verify`)
  // — otherwise it falls back to REPO_ROOT's real dist/, silently reading live build output while
  // the suite reports green for the scratch one (issue #14 MAJOR 1).
  //
  // A custom cliPath is always setupRepoCopy's self-contained clone, which must resolve DIST_DIR
  // relative to *its own* REPO_ROOT (the clone root) to exercise the CLI's self-relocation logic
  // at all — inheriting the outer PRAXARCH_TEST_DIST_DIR override here would point it at the
  // top-level scratch tree instead of the clone's own copied dist/, defeating that test.
  const env: Record<string, string | undefined> = {
    ...process.env,
    PRAXARCH_TARGET_CLAUDE_HOME: fixture.claudeHome,
    PRAXARCH_HOME: join(fixture.claudeHome, "praxarch"),
  };
  // Scrubbed rather than inherited: an ambient CLAUDE_CODE_DISABLE_ADVISOR_TOOL (e.g. set in the
  // developer's own shell) would flip checkAdvisor's verdict for every test here, not just the
  // ones that deliberately set it — those tests pass it back in explicitly via extraEnv.
  delete env["CLAUDE_CODE_DISABLE_ADVISOR_TOOL"];
  if (cliPath === cli) {
    env["PRAXARCH_TEST_DIST_DIR"] = TEST_DIST_DIR;
  } else {
    delete env["PRAXARCH_TEST_DIST_DIR"];
  }
  Object.assign(env, extraEnv);
  const result = spawnSync("node", [cliPath, ...args], { env });
  return {
    stdout: result.stdout?.toString("utf8") ?? "",
    stderr: result.stderr?.toString("utf8") ?? "",
    status: result.status ?? 1,
  };
}

const repoRoot = join(here, "..", "..");

/**
 * A throwaway copy of the repo, so tests can symlink ~/.claude at "the clone" and exercise the
 * guards that key on REPO_ROOT — without ever risking the real templates/ if a guard regresses.
 * REPO_ROOT is derived from the CLI's own location, so running the copy's CLI relocates it.
 */
async function setupRepoCopy(): Promise<{ root: string; cli: string }> {
  const root = await mkdtemp(join(tmpdir(), "praxarch-repo-"));
  // "dist" is sourced from TEST_DIST_DIR (the scratch build under `pnpm verify`, the real one
  // under plain `pnpm test`) rather than repoRoot, so this fixture never reads the live dist/.
  const sources: [string, string][] = [
    [TEST_DIST_DIR, "dist"],
    [join(repoRoot, "templates"), "templates"],
    [join(repoRoot, "package.json"), "package.json"],
  ];
  for (const [src, entry] of sources) {
    await cp(src, join(root, entry), {
      recursive: true,
      // A stray backup in the dev's own tree (the artifact of the bug being fixed here) would
      // otherwise land in the fixture and trip the "no backups in the clone" assertions.
      filter: (s) => !s.includes(".praxarch-backup-"),
    });
  }
  return { root, cli: join(root, "dist", "cli", "index.js") };
}

test("every role template carries an explicit effort frontmatter value", async () => {
  const agentsDir = join(repoRoot, "templates", "agents");
  const files = (await readdir(agentsDir)).filter((f) => f.endsWith(".md"));
  assert.ok(files.length > 0, "expected at least one role template");

  const missing: string[] = [];
  for (const file of files) {
    const content = await readFile(join(agentsDir, file), "utf8");
    const frontmatter = content.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
    if (!/^effort:\s*(low|medium|high)\s*$/m.test(frontmatter)) missing.push(file);
  }

  assert.deepEqual(missing, [], `role templates missing an effort frontmatter value: ${missing.join(", ")}`);
});

test("install --yes writes settings, CLAUDE.md, agents, skills, and praxarch/ tree", async () => {
  const fixture = await setupFixture();
  try {
    const { stdout, status } = runCli(fixture, ["install", "--yes"]);
    assert.equal(status, 0, stdout);

    const settings = JSON.parse(await readFile(join(fixture.claudeHome, "settings.json"), "utf8")) as {
      model?: string;
      hooks?: Record<string, unknown>;
      statusLine?: { command: string };
    };
    assert.equal(settings.model, "best");
    assert.ok(settings.hooks?.["SessionStart"]);
    assert.match(settings.statusLine?.command ?? "", /praxarch/);

    const claudeMd = await readFile(join(fixture.claudeHome, "CLAUDE.md"), "utf8");
    assert.match(claudeMd, /praxarch:orchestration:start/);

    const scoutAgent = await readFile(join(fixture.claudeHome, "agents", "scout.md"), "utf8");
    assert.match(scoutAgent, /name: scout/);

    const skill = await readFile(join(fixture.claudeHome, "skills", "fan-out", "SKILL.md"), "utf8");
    assert.match(skill, /name: fan-out/);

    const versionFile = JSON.parse(
      await readFile(join(fixture.claudeHome, "praxarch", "VERSION.json"), "utf8"),
    ) as { version: string };
    assert.ok(versionFile.version);

    const hookScript = await readFile(join(fixture.claudeHome, "praxarch", "hooks", "route-guard.js"), "utf8");
    assert.ok(hookScript.length > 0);
  } finally {
    await teardownFixture(fixture);
  }
});

// Issue #21: checker (sonnet-tier verifier re-verify counterpart) must be installed, reported by
// doctor, and removed by uninstall exactly like every other role file.
test("install places checker.md, doctor reports it, and uninstall removes it", async () => {
  const fixture = await setupFixture();
  try {
    let { status, stdout } = runCli(fixture, ["install", "--yes"]);
    assert.equal(status, 0, stdout);

    const checkerAgent = await readFile(join(fixture.claudeHome, "agents", "checker.md"), "utf8");
    assert.match(checkerAgent, /name: checker/);
    assert.match(checkerAgent, /model: sonnet/);

    ({ stdout, status } = runCli(fixture, ["doctor"]));
    assert.equal(status, 0, stdout);
    assert.match(stdout, /✓ agents\/checker\.md is installed/);

    ({ status } = runCli(fixture, ["uninstall", "--yes"]));
    assert.equal(status, 0);

    await assert.rejects(readFile(join(fixture.claudeHome, "agents", "checker.md"), "utf8"));
  } finally {
    await teardownFixture(fixture);
  }
});

// Issue #11: /issues skill must be installed, reported by doctor, and removed by uninstall
// exactly like every other skill (fan-out, orchestrate, praxarch-report).
test("install places the issues skill, doctor reports it, and uninstall removes it", async () => {
  const fixture = await setupFixture();
  try {
    let { status, stdout } = runCli(fixture, ["install", "--yes"]);
    assert.equal(status, 0, stdout);

    const issuesSkill = await readFile(join(fixture.claudeHome, "skills", "issues", "SKILL.md"), "utf8");
    assert.match(issuesSkill, /name: issues/);

    ({ stdout, status } = runCli(fixture, ["doctor"]));
    assert.equal(status, 0, stdout);
    assert.match(stdout, /✓ skills\/issues is installed/);

    ({ status } = runCli(fixture, ["uninstall", "--yes"]));
    assert.equal(status, 0);

    await assert.rejects(readFile(join(fixture.claudeHome, "skills", "issues", "SKILL.md"), "utf8"));
  } finally {
    await teardownFixture(fixture);
  }
});

test("install does not overwrite a user's existing model setting", async () => {
  const fixture = await setupFixture();
  try {
    await mkdir(fixture.claudeHome, { recursive: true });
    await writeFile(join(fixture.claudeHome, "settings.json"), JSON.stringify({ model: "sonnet" }));

    const { status } = runCli(fixture, ["install", "--yes"]);
    assert.equal(status, 0);

    const settings = JSON.parse(await readFile(join(fixture.claudeHome, "settings.json"), "utf8")) as {
      model?: string;
    };
    assert.equal(settings.model, "sonnet");
  } finally {
    await teardownFixture(fixture);
  }
});

test("install is idempotent — running twice produces the same settings", async () => {
  const fixture = await setupFixture();
  try {
    runCli(fixture, ["install", "--yes"]);
    const first = await readFile(join(fixture.claudeHome, "settings.json"), "utf8");
    runCli(fixture, ["install", "--yes"]);
    const second = await readFile(join(fixture.claudeHome, "settings.json"), "utf8");
    assert.equal(first, second);
  } finally {
    await teardownFixture(fixture);
  }
});

test("doctor reports all checks passing after a fresh install", async () => {
  const fixture = await setupFixture();
  try {
    runCli(fixture, ["install", "--yes"]);
    const { stdout, status } = runCli(fixture, ["doctor"]);
    assert.equal(status, 0, stdout);
    assert.doesNotMatch(stdout, /✗/);
  } finally {
    await teardownFixture(fixture);
  }
});

test("doctor fails before install", async () => {
  const fixture = await setupFixture();
  try {
    const { status } = runCli(fixture, ["doctor"]);
    assert.equal(status, 1);
  } finally {
    await teardownFixture(fixture);
  }
});

// Advisor health (docs/spec-advisor.md): three states checkAdvisor can report.
test("doctor reports advisorModel configured cleanly, naming the model", async () => {
  const fixture = await setupFixture();
  try {
    runCli(fixture, ["install", "--yes"]);
    const { stdout, status } = runCli(fixture, ["doctor"]);
    assert.equal(status, 0, stdout);
    assert.match(stdout, /advisorModel is "opus" — subagent dispatches inherit it/);
  } finally {
    await teardownFixture(fixture);
  }
});

test("doctor reports advisorModel as not configured when absent from settings.json", async () => {
  const fixture = await setupFixture();
  try {
    runCli(fixture, ["install", "--yes"]);
    const settingsPath = join(fixture.claudeHome, "settings.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
    delete settings["advisorModel"];
    await writeFile(settingsPath, JSON.stringify(settings));

    const { stdout, status } = runCli(fixture, ["doctor"]);
    assert.equal(status, 0, stdout);
    assert.match(stdout, /advisorModel is not configured \(advisor disabled — optional\)/);
  } finally {
    await teardownFixture(fixture);
  }
});

test("doctor fails when advisorModel is configured but the kill switch is set", async () => {
  const fixture = await setupFixture();
  try {
    runCli(fixture, ["install", "--yes"]);
    const { stdout, status } = runCli(fixture, ["doctor"], cli, { CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1" });
    assert.equal(status, 1, stdout);
    assert.match(
      stdout,
      /✗ advisorModel is "opus" but CLAUDE_CODE_DISABLE_ADVISOR_TOOL is set — the advisor is silently disabled/,
    );
  } finally {
    await teardownFixture(fixture);
  }
});

// issue #14 MAJOR 2: a corrupt/hand-edited build-info.json must not take every other doctor check
// down with it — an unguarded JSON.parse in readBuildInfoIfValid would otherwise crash the whole command.
test("doctor does not crash on a corrupt build-info.json", async () => {
  const fixture = await setupFixture();
  try {
    runCli(fixture, ["install", "--yes"]);
    const buildInfoPath = join(fixture.claudeHome, "praxarch", "hooks", "build-info.json");
    await writeFile(buildInfoPath, "not json {{{");

    const { stdout, status } = runCli(fixture, ["doctor"]);
    assert.equal(status, 0, stdout);
    assert.match(stdout, /build ref is unknown/);
    // Every other check still ran and printed — a crash would have lost the rest of the report.
    assert.match(stdout, /checks passed/);
  } finally {
    await teardownFixture(fixture);
  }
});

// issue #14 Part B: doctor must name the branch/ref on a real mismatch, not just flag one.
test("doctor detects and names a build ref mismatch against the checkout's current HEAD", async () => {
  const fixture = await setupFixture();
  try {
    runCli(fixture, ["install", "--yes"]);
    const buildInfoPath = join(fixture.claudeHome, "praxarch", "hooks", "build-info.json");
    await writeFile(
      buildInfoPath,
      JSON.stringify({
        ref: "0000000000000000000000000000000000000000",
        branch: "some-old-branch",
        dirty: false,
        builtAt: "2020-01-01T00:00:00.000Z",
      }),
    );

    const { stdout, status } = runCli(fixture, ["doctor"]);
    assert.equal(status, 1, stdout);
    assert.match(stdout, /✗ installed hooks were built from some-old-branch@000000000000/);
    assert.match(stdout, /this checkout is now on/);
  } finally {
    await teardownFixture(fixture);
  }
});

// The failure shape this guards against (issue #15): a hook registered in the template but not
// wired into the installed settings.json reports fully green. Doctor must catch it for every
// shipped event, SubagentStop included, not just the ones known when doctor was last edited.
test("doctor reports a problem when a shipped hook event is missing from installed settings", async () => {
  const fixture = await setupFixture();
  try {
    runCli(fixture, ["install", "--yes"]);
    const settingsPath = join(fixture.claudeHome, "settings.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
      hooks: Record<string, unknown>;
    };
    delete settings.hooks["SubagentStop"];
    await writeFile(settingsPath, JSON.stringify(settings, null, 2));

    const { stdout, status } = runCli(fixture, ["doctor"]);
    assert.equal(status, 1, stdout);
    assert.match(stdout, /✗ settings\.json wires the praxarch SubagentStop hook/);
  } finally {
    await teardownFixture(fixture);
  }
});

// Proves the event list is derived from templates/settings.fragment.json rather than a hardcoded
// array in doctor.ts — adding an event to the template must be picked up without touching doctor.
test("doctor picks up a hook event added to the template without editing doctor.ts", async () => {
  const fixture = await setupFixture();
  const repo = await setupRepoCopy();
  try {
    const fragmentPath = join(repo.root, "templates", "settings.fragment.json");
    const fragment = JSON.parse(await readFile(fragmentPath, "utf8")) as {
      hooks: Record<string, unknown>;
    };
    fragment.hooks["NotifyEvent"] = [
      { hooks: [{ type: "command", command: "node ~/.claude/praxarch/hooks/notify-event.js" }] },
    ];
    await writeFile(fragmentPath, JSON.stringify(fragment, null, 2));

    runCli(fixture, ["install", "--yes"], repo.cli);
    // Not actually wired into settings.json — install only merges what's in the fragment, but the
    // fixture's settings.json was written before this edit landed in a real install flow. Simulate
    // an install that predates the new event by removing it from the merged settings.
    const settingsPath = join(fixture.claudeHome, "settings.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
      hooks: Record<string, unknown>;
    };
    delete settings.hooks["NotifyEvent"];
    await writeFile(settingsPath, JSON.stringify(settings, null, 2));

    const { stdout, status } = runCli(fixture, ["doctor"], repo.cli);
    assert.equal(status, 1, stdout);
    assert.match(stdout, /✗ settings\.json wires the praxarch NotifyEvent hook/);
  } finally {
    await rm(repo.root, { recursive: true, force: true });
    await teardownFixture(fixture);
  }
});

// Symlinked destinations. The rule is: preserve the user's link, write *through* it. Replacing the
// link with a plain copy (the original bug) freezes a live-linked install; skipping it outright
// freezes any link that points somewhere other than our own source. Neither is acceptable.
//
// The one exception is a link pointing back at THIS clone — then dest already is src, and copying
// would only back the template up over itself and litter the repo.

test("install leaves a link pointing at this clone alone (the live-linked install)", async () => {
  const fixture = await setupFixture();
  const repo = await setupRepoCopy();
  try {
    await mkdir(join(fixture.claudeHome, "agents"), { recursive: true });
    const src = join(repo.root, "templates", "agents", "scout.md");
    const dest = join(fixture.claudeHome, "agents", "scout.md");
    await symlink(src, dest);

    const { status, stdout } = runCli(fixture, ["install", "--yes"], repo.cli);
    assert.equal(status, 0, stdout);

    assert.ok((await lstat(dest)).isSymbolicLink(), "the live link must survive");
    assert.equal(await readlink(dest), src);
    assert.deepEqual(
      (await readdir(join(repo.root, "templates", "agents"))).filter((f) =>
        f.includes("praxarch-backup"),
      ),
      [],
      "must not back the template up over itself inside the clone",
    );
    // Match the per-file PLAN line, not the apply-side summary — they use the same phrase, and
    // asserting the summary leaves destPlan's own guard untested.
    assert.match(stdout, /- scout\.md: symlinked into a praxarch checkout/, "the plan must say so");
  } finally {
    await rm(repo.root, { recursive: true, force: true });
    await teardownFixture(fixture);
  }
});

test("install updates through a symlinked agent file pointing elsewhere (dotfiles)", async () => {
  const fixture = await setupFixture();
  const dotfiles = await mkdtemp(join(tmpdir(), "praxarch-dotfiles-"));
  try {
    const target = join(dotfiles, "scout.md");
    await writeFile(target, "---\nname: scout\n---\nSTALE v0.0.1\n");
    await mkdir(join(fixture.claudeHome, "agents"), { recursive: true });
    const dest = join(fixture.claudeHome, "agents", "scout.md");
    await symlink(target, dest);

    const { status, stdout } = runCli(fixture, ["install", "--yes"]);
    assert.equal(status, 0, stdout);

    assert.ok((await lstat(dest)).isSymbolicLink(), "the user's link must survive");
    assert.equal(await readlink(dest), target, "link must still point at the dotfiles copy");

    const written = await readFile(target, "utf8");
    assert.match(written, /name: scout/, "target must be updated, not frozen at stale content");
    assert.doesNotMatch(written, /STALE v0\.0\.1/);
    assert.ok(
      (await readdir(dotfiles)).some((f) => f.includes("praxarch-backup")),
      "the replaced content must be backed up beside its target",
    );
  } finally {
    await rm(dotfiles, { recursive: true, force: true });
    await teardownFixture(fixture);
  }
});

test("install updates through a symlinked skill dir and praxarch/hooks dir", async () => {
  const fixture = await setupFixture();
  const skillTarget = await mkdtemp(join(tmpdir(), "praxarch-skill-"));
  const hooksTarget = await mkdtemp(join(tmpdir(), "praxarch-hooks-"));
  try {
    await writeFile(join(skillTarget, "SKILL.md"), "---\nname: fan-out\n---\nSTALE\n");
    await mkdir(join(fixture.claudeHome, "skills"), { recursive: true });
    await mkdir(join(fixture.claudeHome, "praxarch"), { recursive: true });
    await symlink(skillTarget, join(fixture.claudeHome, "skills", "fan-out"));
    await symlink(hooksTarget, join(fixture.claudeHome, "praxarch", "hooks"));

    const { status, stdout } = runCli(fixture, ["install", "--yes"]);
    assert.equal(status, 0, stdout);

    assert.ok((await lstat(join(fixture.claudeHome, "skills", "fan-out"))).isSymbolicLink());
    assert.ok((await lstat(join(fixture.claudeHome, "praxarch", "hooks"))).isSymbolicLink());

    const skill = await readFile(join(skillTarget, "SKILL.md"), "utf8");
    assert.match(skill, /name: fan-out/);
    assert.doesNotMatch(skill, /STALE/, "skill must be updated through the link");

    const hook = await readFile(join(hooksTarget, "route-guard.js"), "utf8");
    assert.ok(hook.length > 0, "compiled hooks must land in the link target");

    const { status: doctorStatus } = runCli(fixture, ["doctor"]);
    assert.equal(doctorStatus, 0, "doctor must be green — install kept the link current");
  } finally {
    await rm(skillTarget, { recursive: true, force: true });
    await rm(hooksTarget, { recursive: true, force: true });
    await teardownFixture(fixture);
  }
});

// A *dangling* symlink must be repaired, not preserved. praxarch/hooks -> <clone>/dist/hooks
// dangles as soon as dist/ is removed (`git clean -xfd`); skipping it would leave the install
// broken with no way for `praxarch install` to fix it.

test("install repairs a dangling symlink instead of skipping it", async () => {
  const fixture = await setupFixture();
  const live = await mkdtemp(join(tmpdir(), "praxarch-dangling-"));
  try {
    const target = join(live, "gone.md");
    await mkdir(join(fixture.claudeHome, "agents"), { recursive: true });
    await symlink(target, join(fixture.claudeHome, "agents", "scout.md")); // target never created

    const { status, stdout } = runCli(fixture, ["install", "--yes"]);
    assert.equal(status, 0, stdout);

    const dest = join(fixture.claudeHome, "agents", "scout.md");
    assert.ok(!(await lstat(dest)).isSymbolicLink(), "dangling link must be replaced by a real file");
    assert.match(await readFile(dest, "utf8"), /name: scout/, "must install the real agent");
  } finally {
    await rm(live, { recursive: true, force: true });
    await teardownFixture(fixture);
  }
});

test("install repairs a dangling praxarch/hooks symlink (the git-clean-xfd case)", async () => {
  const fixture = await setupFixture();
  try {
    await mkdir(join(fixture.claudeHome, "praxarch"), { recursive: true });
    await symlink("/nonexistent/dist/hooks", join(fixture.claudeHome, "praxarch", "hooks"));

    const { status, stdout } = runCli(fixture, ["install", "--yes"]);
    assert.equal(status, 0, stdout);

    const hook = await readFile(join(fixture.claudeHome, "praxarch", "hooks", "route-guard.js"), "utf8");
    assert.ok(hook.length > 0, "hooks must be restored so Claude Code can run them");

    const { status: doctorStatus } = runCli(fixture, ["doctor"]);
    assert.equal(doctorStatus, 0, "doctor must pass after install repairs the broken link");
  } finally {
    await teardownFixture(fixture);
  }
});

// ~/.claude/agents -> <clone>/templates/agents makes dest resolve to src itself. Copying would
// back the template up over itself and drop stray backups inside the git repo.
test("install does not copy a template over itself through a symlinked agents/ dir", async () => {
  const fixture = await setupFixture();
  const repo = await setupRepoCopy();
  const templateAgents = join(repo.root, "templates", "agents");
  try {
    await symlink(templateAgents, join(fixture.claudeHome, "agents"));

    const { status, stdout } = runCli(fixture, ["install", "--yes"], repo.cli);
    assert.equal(status, 0, stdout);

    assert.deepEqual(
      (await readdir(templateAgents)).filter((f) => f.includes("praxarch-backup")),
      [],
      "must not write backups into the clone's own templates/",
    );
    assert.match(await readFile(join(templateAgents, "scout.md"), "utf8"), /name: scout/);
    // Assert the *guard* fired, not merely that nothing changed — copying a template over itself is
    // a no-op byte-wise, so without this the test would pass even with the guard removed. Match the
    // per-file plan line specifically; the apply-side summary uses the same phrase.
    assert.match(stdout, /- scout\.md: symlinked into a praxarch checkout/);
  } finally {
    await rm(repo.root, { recursive: true, force: true });
    await teardownFixture(fixture);
  }
});

// Deleting through a symlinked agents//skills/ dir would remove files from inside the clone,
// taking any uncommitted template edits with them.
test("uninstall does not delete through symlinked agents//skills/ dirs into the clone", async () => {
  const fixture = await setupFixture();
  const repo = await setupRepoCopy();
  try {
    await symlink(join(repo.root, "templates", "agents"), join(fixture.claudeHome, "agents"));
    await symlink(join(repo.root, "templates", "skills"), join(fixture.claudeHome, "skills"));

    const { status, stdout } = runCli(fixture, ["uninstall", "--yes"], repo.cli);
    assert.equal(status, 0, stdout);

    assert.match(
      await readFile(join(repo.root, "templates", "agents", "scout.md"), "utf8"),
      /name: scout/,
      "uninstall must not delete the clone's agent templates",
    );
    assert.match(
      await readFile(join(repo.root, "templates", "skills", "fan-out", "SKILL.md"), "utf8"),
      /name: fan-out/,
      "uninstall must not delete the clone's skill templates",
    );
    assert.match(stdout, /Kept \d+ path\(s\)/, "must report what it declined to delete");
  } finally {
    await rm(repo.root, { recursive: true, force: true });
    await teardownFixture(fixture);
  }
});

// ...but files praxarch actually wrote into an unrelated symlinked dir (dotfiles) MUST be removed,
// or uninstall silently leaves live agents behind while claiming success.
test("uninstall removes agents it installed through an unrelated symlinked agents/ dir", async () => {
  const fixture = await setupFixture();
  const dotfiles = await mkdtemp(join(tmpdir(), "praxarch-dotfiles-agents-"));
  try {
    await symlink(dotfiles, join(fixture.claudeHome, "agents"));

    runCli(fixture, ["install", "--yes"]);
    assert.ok(
      (await readdir(dotfiles)).includes("scout.md"),
      "precondition: install writes through the link",
    );

    const { status } = runCli(fixture, ["uninstall", "--yes"]);
    assert.equal(status, 0);

    assert.deepEqual(
      (await readdir(dotfiles)).filter((f) => f.endsWith(".md")),
      [],
      "uninstall must remove the agents it installed there",
    );
  } finally {
    await rm(dotfiles, { recursive: true, force: true });
    await teardownFixture(fixture);
  }
});

// The guard is "does this resolve into a praxarch checkout", not "is it MY checkout". A git
// worktree or a second clone is still a git working tree, and running the CLI from one must not
// write into — or delete out of — the other.

test("install does not write into a DIFFERENT praxarch checkout's templates", async () => {
  const fixture = await setupFixture();
  const cloneA = await setupRepoCopy();
  const cloneB = await setupRepoCopy();
  try {
    const target = join(cloneA.root, "templates", "agents", "scout.md");
    await writeFile(target, "---\nname: scout\n---\nMY UNCOMMITTED LOCAL EDIT\n");
    await mkdir(join(fixture.claudeHome, "agents"), { recursive: true });
    await symlink(target, join(fixture.claudeHome, "agents", "scout.md"));

    const { status, stdout } = runCli(fixture, ["install", "--yes"], cloneB.cli);
    assert.equal(status, 0, stdout);

    assert.match(
      await readFile(target, "utf8"),
      /MY UNCOMMITTED LOCAL EDIT/,
      "must not overwrite another checkout's tracked template",
    );
    assert.deepEqual(
      (await readdir(join(cloneA.root, "templates", "agents"))).filter((f) =>
        f.includes("praxarch-backup"),
      ),
      [],
      "must not litter another checkout with backups",
    );
  } finally {
    await rm(cloneA.root, { recursive: true, force: true });
    await rm(cloneB.root, { recursive: true, force: true });
    await teardownFixture(fixture);
  }
});

test("uninstall does not delete a DIFFERENT praxarch checkout's templates", async () => {
  const fixture = await setupFixture();
  const cloneA = await setupRepoCopy();
  const cloneB = await setupRepoCopy();
  try {
    await symlink(join(cloneA.root, "templates", "agents"), join(fixture.claudeHome, "agents"));
    await symlink(join(cloneA.root, "templates", "skills"), join(fixture.claudeHome, "skills"));

    const { status, stdout } = runCli(fixture, ["uninstall", "--yes"], cloneB.cli);
    assert.equal(status, 0, stdout);

    assert.match(
      await readFile(join(cloneA.root, "templates", "agents", "scout.md"), "utf8"),
      /name: scout/,
      "must not delete another checkout's agent templates",
    );
    assert.match(
      await readFile(join(cloneA.root, "templates", "skills", "fan-out", "SKILL.md"), "utf8"),
      /name: fan-out/,
      "must not delete another checkout's skill templates",
    );
    assert.match(stdout, /Kept \d+ path\(s\)/);
  } finally {
    await rm(cloneA.root, { recursive: true, force: true });
    await rm(cloneB.root, { recursive: true, force: true });
    await teardownFixture(fixture);
  }
});

test("install repairs a broken skill-dir symlink instead of crashing on mkdir", async () => {
  const fixture = await setupFixture();
  try {
    await mkdir(join(fixture.claudeHome, "skills"), { recursive: true });
    await symlink("/nonexistent/fan-out", join(fixture.claudeHome, "skills", "fan-out"));

    const { status, stdout } = runCli(fixture, ["install", "--yes"]);
    assert.equal(status, 0, stdout);

    const skill = await readFile(join(fixture.claudeHome, "skills", "fan-out", "SKILL.md"), "utf8");
    assert.match(skill, /name: fan-out/, "the broken skill dir link must be rebuilt as a real dir");
  } finally {
    await teardownFixture(fixture);
  }
});

test("reinstalling does not spawn a fresh backup when content is unchanged", async () => {
  const fixture = await setupFixture();
  const dotfiles = await mkdtemp(join(tmpdir(), "praxarch-spam-"));
  try {
    await writeFile(join(dotfiles, "scout.md"), "stale\n");
    await mkdir(join(fixture.claudeHome, "agents"), { recursive: true });
    await symlink(join(dotfiles, "scout.md"), join(fixture.claudeHome, "agents", "scout.md"));

    runCli(fixture, ["install", "--yes"]);
    runCli(fixture, ["install", "--yes"]);
    runCli(fixture, ["install", "--yes"]);

    const backups = (await readdir(dotfiles)).filter((f) => f.includes("praxarch-backup"));
    assert.equal(backups.length, 1, `expected exactly 1 backup, got ${backups.length}`);
  } finally {
    await rm(dotfiles, { recursive: true, force: true });
    await teardownFixture(fixture);
  }
});

test("a self-referential (ELOOP) symlink is left alone, not a crash", async () => {
  const fixture = await setupFixture();
  try {
    await mkdir(join(fixture.claudeHome, "agents"), { recursive: true });
    await symlink("scout.md", join(fixture.claudeHome, "agents", "scout.md")); // points at itself

    const { status, stdout } = runCli(fixture, ["install", "--yes"]);
    assert.equal(status, 0, `install must not abort on an unreadable link:\n${stdout}`);
    assert.ok(
      (await lstat(join(fixture.claudeHome, "agents", "scout.md"))).isSymbolicLink(),
      "the unreadable link must be left alone, not clobbered",
    );
    assert.match(await readFile(join(fixture.claudeHome, "skills", "fan-out", "SKILL.md"), "utf8"), /fan-out/);
  } finally {
    await teardownFixture(fixture);
  }
});

// The plan is the artifact the user consents to. It must never promise a write or a backup that
// apply won't actually perform.

test("the plan does not promise a backup that apply will not make", async () => {
  const fixture = await setupFixture();
  try {
    runCli(fixture, ["install", "--yes"]);
    const { stdout } = runCli(fixture, ["install", "--yes"]); // second run: content identical

    assert.doesNotMatch(
      stdout,
      /overwrite \(backed up\)/,
      "an unchanged reinstall must not claim it will back anything up",
    );
    assert.match(stdout, /already current, unchanged/);

    const backups = (await readdir(join(fixture.claudeHome, "agents"))).filter((f) =>
      f.includes("praxarch-backup"),
    );
    assert.deepEqual(backups, [], "and indeed it makes none");
  } finally {
    await teardownFixture(fixture);
  }
});

// resolvesIntoPraxarchRepo walks ancestor dirs reading package.json. Those are other people's
// files; a malformed one must not take down a destructive command mid-flight.
test("a malformed package.json above the target does not abort install or uninstall", async () => {
  const fixture = await setupFixture();
  try {
    await writeFile(join(fixture.claudeHome, "package.json"), '{ "name": "foo",\n}\n');

    const { status: installStatus, stdout: installOut } = runCli(fixture, ["install", "--yes"]);
    assert.equal(installStatus, 0, `install must survive bad JSON above it:\n${installOut}`);
    assert.match(await readFile(join(fixture.claudeHome, "agents", "scout.md"), "utf8"), /name: scout/);

    const { status: uninstallStatus, stdout: uninstallOut } = runCli(fixture, ["uninstall", "--yes"]);
    assert.equal(uninstallStatus, 0, `uninstall must survive it too:\n${uninstallOut}`);
    await assert.rejects(
      readFile(join(fixture.claudeHome, "agents", "scout.md"), "utf8"),
      "uninstall must actually complete, not half-strip and die",
    );
  } finally {
    await teardownFixture(fixture);
  }
});

test("install repairs a broken agents/ container-dir symlink instead of crashing", async () => {
  const fixture = await setupFixture();
  try {
    await symlink("/nonexistent/agents", join(fixture.claudeHome, "agents"));

    const { status, stdout } = runCli(fixture, ["install", "--yes"]);
    assert.equal(status, 0, stdout);
    assert.match(await readFile(join(fixture.claudeHome, "agents", "scout.md"), "utf8"), /name: scout/);
  } finally {
    await teardownFixture(fixture);
  }
});

// The guard must fire for a dest that does not exist YET. It will still be created inside whatever
// its parent resolves to — and if that parent links into a checkout, the file lands in a git repo.
test("install does not create a MISSING file inside a symlinked-in praxarch checkout", async () => {
  const fixture = await setupFixture();
  const cloneA = await setupRepoCopy();
  const cloneB = await setupRepoCopy();
  try {
    // cloneA is an older checkout that simply lacks this template.
    await rm(join(cloneA.root, "templates", "agents", "security-executor.md"), { force: true });
    await symlink(join(cloneA.root, "templates", "agents"), join(fixture.claudeHome, "agents"));

    const { status, stdout } = runCli(fixture, ["install", "--yes"], cloneB.cli);
    assert.equal(status, 0, stdout);

    await assert.rejects(
      readFile(join(cloneA.root, "templates", "agents", "security-executor.md"), "utf8"),
      "must not create a new template inside another checkout's working tree",
    );
  } finally {
    await rm(cloneA.root, { recursive: true, force: true });
    await rm(cloneB.root, { recursive: true, force: true });
    await teardownFixture(fixture);
  }
});

test("install does not create a missing dist subdir inside a symlinked-in checkout", async () => {
  const fixture = await setupFixture();
  const cloneA = await setupRepoCopy();
  try {
    await rm(join(cloneA.root, "dist", "report"), { recursive: true, force: true });
    await symlink(join(cloneA.root, "dist"), join(fixture.claudeHome, "praxarch"));

    const { status, stdout } = runCli(fixture, ["install", "--yes"]);
    assert.equal(status, 0, stdout);

    await assert.rejects(
      readdir(join(cloneA.root, "dist", "report")),
      "must not create dist/report inside the checkout",
    );
    assert.match(stdout, /symlinked into a praxarch checkout/);
  } finally {
    await rm(cloneA.root, { recursive: true, force: true });
    await teardownFixture(fixture);
  }
});

test("uninstall unlinks praxarch's own leaf symlinks without touching their targets", async () => {
  const fixture = await setupFixture();
  const dotfiles = await mkdtemp(join(tmpdir(), "praxarch-leaf-"));
  try {
    const target = join(dotfiles, "scout.md");
    await writeFile(target, "MY FILE\n");
    await mkdir(join(fixture.claudeHome, "agents"), { recursive: true });
    const link = join(fixture.claudeHome, "agents", "scout.md");
    await symlink(target, link);

    const { status } = runCli(fixture, ["uninstall", "--yes"]);
    assert.equal(status, 0);

    await assert.rejects(lstat(link), "the link itself must be removed");
    assert.equal(await readFile(target, "utf8"), "MY FILE\n", "but rm must not follow into the target");
  } finally {
    await rm(dotfiles, { recursive: true, force: true });
    await teardownFixture(fixture);
  }
});

// The live-linked install — links pointing INTO a checkout — is the whole point of this change, and
// it is the case where uninstall's two branches diverge: the repo guard would "keep" these paths,
// so only the isSymlink early-unlink keeps uninstall from silently leaving every agent active.
test("uninstall unlinks leaf symlinks that point into a praxarch checkout", async () => {
  const fixture = await setupFixture();
  const clone = await setupRepoCopy();
  try {
    await mkdir(join(fixture.claudeHome, "agents"), { recursive: true });
    await mkdir(join(fixture.claudeHome, "skills"), { recursive: true });
    const agentLink = join(fixture.claudeHome, "agents", "scout.md");
    const skillLink = join(fixture.claudeHome, "skills", "fan-out");
    await symlink(join(clone.root, "templates", "agents", "scout.md"), agentLink);
    await symlink(join(clone.root, "templates", "skills", "fan-out"), skillLink);

    const { status, stdout } = runCli(fixture, ["uninstall", "--yes"], clone.cli);
    assert.equal(status, 0, stdout);

    await assert.rejects(lstat(agentLink), "the agent link must be removed, not 'kept'");
    await assert.rejects(lstat(skillLink), "the skill link must be removed, not 'kept'");

    assert.match(
      await readFile(join(clone.root, "templates", "agents", "scout.md"), "utf8"),
      /name: scout/,
      "and the checkout's template must survive",
    );
  } finally {
    await rm(clone.root, { recursive: true, force: true });
    await teardownFixture(fixture);
  }
});

// issue #18: readJsonIfExists' bare JSON.parse crashed doctor outright on a malformed
// settings.json, losing every other check along with it.
test("doctor survives a malformed settings.json, names it in a failed check, and still runs every other check", async () => {
  const fixture = await setupFixture();
  try {
    runCli(fixture, ["install", "--yes"]);
    const settingsPath = join(fixture.claudeHome, "settings.json");
    await writeFile(settingsPath, "not json {{{");

    const { stdout, status } = runCli(fixture, ["doctor"]);
    assert.equal(status, 1, stdout);
    assert.match(stdout, /is not valid JSON/);
    assert.match(stdout, new RegExp(settingsPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    // Every other check still ran — CLAUDE.md, agents, skills, etc, not just the settings check.
    assert.match(stdout, /CLAUDE\.md has the praxarch orchestration policy block/);
    assert.match(stdout, /checks passed/);
  } finally {
    await teardownFixture(fixture);
  }
});

test("doctor survives a malformed VERSION.json and names it in a failed check", async () => {
  const fixture = await setupFixture();
  try {
    runCli(fixture, ["install", "--yes"]);
    const versionPath = join(fixture.claudeHome, "praxarch", "VERSION.json");
    await writeFile(versionPath, "not json {{{");

    const { stdout, status } = runCli(fixture, ["doctor"]);
    assert.equal(status, 1, stdout);
    assert.match(stdout, /is not valid JSON/);
    assert.match(stdout, /checks passed/);
  } finally {
    await teardownFixture(fixture);
  }
});

// A malformed settings.json is the user's real config — treating it as absent would let install
// clobber a recoverable file. It must refuse outright instead.
test("install refuses to run over a malformed settings.json instead of clobbering it", async () => {
  const fixture = await setupFixture();
  try {
    await mkdir(fixture.claudeHome, { recursive: true });
    const settingsPath = join(fixture.claudeHome, "settings.json");
    await writeFile(settingsPath, "not json {{{");

    const { stderr, status } = runCli(fixture, ["install", "--yes"]);
    assert.notEqual(status, 0, stderr);
    // Pins the deliberate refusal wording, not just any crash-shaped failure — a bare JSON.parse
    // crash (main, pre-#18-fix) also exits non-zero and can mention "not valid JSON" in its own
    // generic error, so this must assert on wording only the refusal path produces.
    assert.match(stderr, /refusing to install over it/);
    assert.equal(await readFile(settingsPath, "utf8"), "not json {{{", "must leave the file untouched");
  } finally {
    await teardownFixture(fixture);
  }
});

// A `null` settings.json is well-formed JSON (JSON.parse("null") succeeds) but not the object
// shape install/doctor expect — must be refused/reported the same as malformed JSON, not crash on
// property access.
test("install refuses to run over a `null` settings.json instead of crashing", async () => {
  const fixture = await setupFixture();
  try {
    await mkdir(fixture.claudeHome, { recursive: true });
    const settingsPath = join(fixture.claudeHome, "settings.json");
    await writeFile(settingsPath, "null");

    const { stderr, status } = runCli(fixture, ["install", "--yes"]);
    assert.notEqual(status, 0, stderr);
    assert.match(stderr, /does not contain a JSON object/);
    assert.match(stderr, /refusing to install over it/);
    assert.equal(await readFile(settingsPath, "utf8"), "null", "must leave the file untouched");
  } finally {
    await teardownFixture(fixture);
  }
});

test("doctor survives a `null` settings.json instead of crashing on property access", async () => {
  const fixture = await setupFixture();
  try {
    runCli(fixture, ["install", "--yes"]);
    const settingsPath = join(fixture.claudeHome, "settings.json");
    await writeFile(settingsPath, "null");

    const { stdout, status } = runCli(fixture, ["doctor"]);
    assert.equal(status, 1, stdout);
    assert.match(stdout, /does not contain a JSON object/);
    assert.match(stdout, /CLAUDE\.md has the praxarch orchestration policy block/);
    assert.match(stdout, /checks passed/);
  } finally {
    await teardownFixture(fixture);
  }
});

test("doctor survives a `null` VERSION.json instead of crashing on property access", async () => {
  const fixture = await setupFixture();
  try {
    runCli(fixture, ["install", "--yes"]);
    const versionPath = join(fixture.claudeHome, "praxarch", "VERSION.json");
    await writeFile(versionPath, "null");

    const { stdout, status } = runCli(fixture, ["doctor"]);
    assert.equal(status, 1, stdout);
    assert.match(stdout, /does not contain a JSON object/);
    assert.match(stdout, /checks passed/);
  } finally {
    await teardownFixture(fixture);
  }
});

// A malformed templates/settings.fragment.json (praxarch's own shipped file, not a user file) must
// surface as a doctor failure naming the file — not silently drop to zero hook-wiring checks, which
// would otherwise report every one of them as vacuously "passing" (issue #18 follow-up finding).
test("doctor fails when the shipped settings.fragment.json is malformed, instead of silently skipping every hook check", async () => {
  const fixture = await setupFixture();
  const clone = await setupRepoCopy();
  try {
    runCli(fixture, ["install", "--yes"], clone.cli);
    const fragmentPath = join(clone.root, "templates", "settings.fragment.json");
    await writeFile(fragmentPath, "not json {{{");

    const { stdout, status } = runCli(fixture, ["doctor"], clone.cli);
    assert.equal(status, 1, stdout);
    assert.match(stdout, /is not valid JSON/);
    assert.match(stdout, new RegExp(fragmentPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    // Must not silently report every hook-wiring check as passing.
    assert.doesNotMatch(stdout, /wires the praxarch/);
  } finally {
    await rm(clone.root, { recursive: true, force: true });
    await teardownFixture(fixture);
  }
});

// uninstall must not silently no-op on a malformed settings.json as if it were simply absent —
// that would look like a clean uninstall while leaving praxarch's hook entries in place.
test("uninstall refuses to silently skip a malformed settings.json", async () => {
  const fixture = await setupFixture();
  try {
    runCli(fixture, ["install", "--yes"]);
    const settingsPath = join(fixture.claudeHome, "settings.json");
    await writeFile(settingsPath, "not json {{{");

    const { stdout } = runCli(fixture, ["uninstall", "--yes"]);
    assert.match(stdout, /is not valid JSON/, stdout);
    assert.equal(await readFile(settingsPath, "utf8"), "not json {{{", "must leave the file untouched");
  } finally {
    await teardownFixture(fixture);
  }
});

// A malformed settings.json means uninstall can't strip praxarch's hook entries from it — that is
// an incomplete uninstall, and reporting a bare "praxarch uninstalled." would tell a scripted
// caller everything went fine when settings.json still points at now-deleted hook scripts.
test("uninstall reports incomplete (not a bare success) when settings.json is left uncleaned", async () => {
  const fixture = await setupFixture();
  try {
    runCli(fixture, ["install", "--yes"]);
    const settingsPath = join(fixture.claudeHome, "settings.json");
    await writeFile(settingsPath, "not json {{{");

    const { stdout, status } = runCli(fixture, ["uninstall", "--yes"]);
    assert.notEqual(status, 0, stdout);
    assert.doesNotMatch(stdout, /^praxarch uninstalled\.$/m, "must not report a bare success");
    assert.match(stdout, /incomplete/i);
    // The rest of uninstall still proceeds — the settings.json refusal doesn't abort the command.
    await assert.rejects(readFile(join(fixture.claudeHome, "praxarch", "VERSION.json"), "utf8"));
  } finally {
    await teardownFixture(fixture);
  }
});

test("uninstall removes agents, skills, and the praxarch dir", async () => {
  const fixture = await setupFixture();
  try {
    runCli(fixture, ["install", "--yes"]);
    const { status } = runCli(fixture, ["uninstall", "--yes"]);
    assert.equal(status, 0);

    await assert.rejects(readFile(join(fixture.claudeHome, "agents", "scout.md"), "utf8"));
    // explore.md by name: uninstall once deleted "Explore.md", orphaning the real file on
    // case-sensitive filesystems.
    await assert.rejects(readFile(join(fixture.claudeHome, "agents", "explore.md"), "utf8"));
    await assert.rejects(readFile(join(fixture.claudeHome, "praxarch", "VERSION.json"), "utf8"));

    const claudeMd = await readFile(join(fixture.claudeHome, "CLAUDE.md"), "utf8");
    assert.doesNotMatch(claudeMd, /praxarch:orchestration:start/);
  } finally {
    await teardownFixture(fixture);
  }
});

// --- Inherited-model audit (issue #24) -----------------------------------------------------------

function monthlyLogPath(fixture: Fixture): string {
  const now = new Date();
  return join(
    fixture.claudeHome,
    "praxarch",
    "logs",
    `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}.jsonl`,
  );
}

async function writeAgentFile(fixture: Fixture, filename: string, name: string, model?: string): Promise<void> {
  await mkdir(join(fixture.claudeHome, "agents"), { recursive: true });
  const frontmatter = model ? `---\nname: ${name}\nmodel: ${model}\n---\n\nbody\n` : `---\nname: ${name}\n---\n\nbody\n`;
  await writeFile(join(fixture.claudeHome, "agents", filename), frontmatter);
}

async function writeLogRows(fixture: Fixture, rows: Record<string, unknown>[]): Promise<void> {
  const path = monthlyLogPath(fixture);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

test("inherited-model audit: a matching fixture (resolvedModel agrees with the role binding) stays quiet", async () => {
  const fixture = await setupFixture();
  try {
    runCli(fixture, ["install", "--yes"]);
    await writeAgentFile(fixture, "verifier.md", "verifier", "opus");
    await writeLogRows(fixture, [
      { at: new Date().toISOString(), sessionId: "s1", role: "verifier", model: "inherited", resolvedModel: "claude-opus-4-8", batchId: null, verdict: "CONFIRMED", criticalOrMajorCount: 0 },
    ]);

    const { stdout, status } = runCli(fixture, ["doctor"]);
    assert.equal(status, 0, stdout);
    assert.match(stdout, /inherited-model audit: 1 recent inherited dispatch\(es\) across 1 role\(s\) all match their bindings/);
    assert.doesNotMatch(stdout, /bound to "opus" but recent dispatches resolved/);
  } finally {
    await teardownFixture(fixture);
  }
});

test("inherited-model audit: a mismatched resolvedModel warns naming the role, the binding, and the observed model", async () => {
  const fixture = await setupFixture();
  try {
    runCli(fixture, ["install", "--yes"]);
    await writeAgentFile(fixture, "verifier.md", "verifier", "opus");
    await writeLogRows(fixture, [
      { at: new Date().toISOString(), sessionId: "s1", role: "verifier", model: "inherited", resolvedModel: "claude-sonnet-5", batchId: null, verdict: "CONFIRMED", criticalOrMajorCount: 0 },
    ]);

    const { stdout, status } = runCli(fixture, ["doctor"]);
    assert.notEqual(status, 0);
    assert.match(
      stdout,
      /inherited-model audit: role "verifier" is bound to "opus" but recent dispatches resolved to claude-sonnet-5/,
    );
  } finally {
    await teardownFixture(fixture);
  }
});

test("inherited-model audit: a role with no installed agent file warns as missing/unparsable, not silently skipped", async () => {
  const fixture = await setupFixture();
  try {
    runCli(fixture, ["install", "--yes"]);
    await writeLogRows(fixture, [
      { at: new Date().toISOString(), sessionId: "s1", role: "ghost-role", model: "inherited", resolvedModel: "claude-opus-4-8", batchId: null, verdict: null, criticalOrMajorCount: null },
    ]);

    const { stdout, status } = runCli(fixture, ["doctor"]);
    assert.notEqual(status, 0);
    assert.match(
      stdout,
      /inherited-model audit: role "ghost-role" has 1 recent inherited dispatch\(es\) but no installed agent file names it/,
    );
  } finally {
    await teardownFixture(fixture);
  }
});

test("inherited-model audit: an unknown role's dispatch count reflects rows, not distinct resolvedModel values", async () => {
  const fixture = await setupFixture();
  try {
    runCli(fixture, ["install", "--yes"]);
    // 6 rows for an unknown role, split across only 2 distinct resolvedModel values — the
    // distinct-model Set has size 2, but the message must report the actual row count (6), not
    // the Set size. A single-row fixture can't distinguish these (both are 1).
    await writeLogRows(fixture, [
      { at: new Date().toISOString(), sessionId: "s1", role: "ghost-role", model: "inherited", resolvedModel: "claude-opus-4-8", batchId: null, verdict: null, criticalOrMajorCount: null },
      { at: new Date().toISOString(), sessionId: "s2", role: "ghost-role", model: "inherited", resolvedModel: "claude-opus-4-8", batchId: null, verdict: null, criticalOrMajorCount: null },
      { at: new Date().toISOString(), sessionId: "s3", role: "ghost-role", model: "inherited", resolvedModel: "claude-opus-4-8", batchId: null, verdict: null, criticalOrMajorCount: null },
      { at: new Date().toISOString(), sessionId: "s4", role: "ghost-role", model: "inherited", resolvedModel: "claude-sonnet-5", batchId: null, verdict: null, criticalOrMajorCount: null },
      { at: new Date().toISOString(), sessionId: "s5", role: "ghost-role", model: "inherited", resolvedModel: "claude-sonnet-5", batchId: null, verdict: null, criticalOrMajorCount: null },
      { at: new Date().toISOString(), sessionId: "s6", role: "ghost-role", model: "inherited", resolvedModel: "claude-sonnet-5", batchId: null, verdict: null, criticalOrMajorCount: null },
    ]);

    const { stdout, status } = runCli(fixture, ["doctor"]);
    assert.notEqual(status, 0);
    assert.match(
      stdout,
      /inherited-model audit: role "ghost-role" has 6 recent inherited dispatch\(es\) but no installed agent file names it/,
    );
  } finally {
    await teardownFixture(fixture);
  }
});

test("inherited-model audit: rows outside the recent window are ignored", async () => {
  const fixture = await setupFixture();
  try {
    runCli(fixture, ["install", "--yes"]);
    await writeAgentFile(fixture, "verifier.md", "verifier", "opus");
    const stale = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    await writeLogRows(fixture, [
      { at: stale, sessionId: "s1", role: "verifier", model: "inherited", resolvedModel: "claude-sonnet-5", batchId: null, verdict: null, criticalOrMajorCount: null },
    ]);

    const { stdout, status } = runCli(fixture, ["doctor"]);
    assert.equal(status, 0, stdout);
    assert.match(stdout, /inherited-model audit: no recent inherited-model dispatches to audit/);
  } finally {
    await teardownFixture(fixture);
  }
});

test("inherited-model audit: a role designed to inherit (no model: key) has nothing to disagree with", async () => {
  const fixture = await setupFixture();
  try {
    runCli(fixture, ["install", "--yes"]);
    // "no-binding-role" is a synthetic fixture role, not a real installed agent — real Explore
    // (templates/agents/explore.md) declares model: haiku, so using "Explore" here would
    // misleadingly imply a real agent has no binding.
    await writeAgentFile(fixture, "no-binding-role.md", "no-binding-role");
    await writeLogRows(fixture, [
      { at: new Date().toISOString(), sessionId: "s1", role: "no-binding-role", model: "inherited", resolvedModel: "claude-opus-4-8", batchId: null, verdict: null, criticalOrMajorCount: null },
    ]);

    const { stdout, status } = runCli(fixture, ["doctor"]);
    assert.equal(status, 0, stdout);
    assert.doesNotMatch(stdout, /role "no-binding-role"/);
  } finally {
    await teardownFixture(fixture);
  }
});
