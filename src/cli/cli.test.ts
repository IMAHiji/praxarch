import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
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

function runCli(fixture: Fixture, args: string[]): { stdout: string; status: number } {
  try {
    const stdout = execFileSync("node", [cli, ...args], {
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
