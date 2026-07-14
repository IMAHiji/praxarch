import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm, writeFile, mkdir, symlink, lstat, readlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "..", "dist", "cli", "index.js");

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

function runCli(fixture: Fixture, args: string[], cliPath = cli): { stdout: string; status: number } {
  try {
    const stdout = execFileSync("node", [cliPath, ...args], {
      env: {
        ...process.env,
        PRAXARCH_TARGET_CLAUDE_HOME: fixture.claudeHome,
        PRAXARCH_HOME: join(fixture.claudeHome, "praxarch"),
      },
    }).toString("utf8");
    return { stdout, status: 0 };
  } catch (err) {
    const e = err as { stdout?: Buffer; status?: number };
    return { stdout: e.stdout?.toString("utf8") ?? "", status: e.status ?? 1 };
  }
}

const repoRoot = join(here, "..", "..");

/**
 * A throwaway copy of the repo, so tests can symlink ~/.claude at "the clone" and exercise the
 * guards that key on REPO_ROOT — without ever risking the real templates/ if a guard regresses.
 * REPO_ROOT is derived from the CLI's own location, so running the copy's CLI relocates it.
 */
async function setupRepoCopy(): Promise<{ root: string; cli: string }> {
  const root = await mkdtemp(join(tmpdir(), "praxarch-repo-"));
  for (const entry of ["dist", "templates", "package.json"]) {
    await cp(join(repoRoot, entry), join(root, entry), {
      recursive: true,
      // A stray backup in the dev's own tree (the artifact of the bug being fixed here) would
      // otherwise land in the fixture and trip the "no backups in the clone" assertions.
      filter: (src) => !src.includes(".praxarch-backup-"),
    });
  }
  return { root, cli: join(root, "dist", "cli", "index.js") };
}

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
