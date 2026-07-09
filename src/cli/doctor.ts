import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { AGENTS_DIR, CLAUDE_MD_PATH, PRAXARCH_INSTALL_DIR, REPO_ROOT, SETTINGS_PATH, SKILLS_DIR } from "./lib/paths.js";
import { exists, readJsonIfExists, readTextIfExists } from "./lib/fsops.js";

const ROLE_FILES = ["scout", "Explore", "mech-executor", "executor", "verifier", "security-executor"];
const SKILL_NAMES = ["praxarch-report", "fan-out"];

interface Check {
  ok: boolean;
  message: string;
}

async function checkSettings(): Promise<Check[]> {
  const checks: Check[] = [];
  const settings = await readJsonIfExists<Record<string, unknown>>(SETTINGS_PATH);
  if (!settings) {
    return [{ ok: false, message: `${SETTINGS_PATH} does not exist — run \`praxarch install\`.` }];
  }
  checks.push({ ok: settings["model"] !== undefined, message: "settings.json has a model set" });
  const hooks = settings["hooks"] as Record<string, { hooks?: { command: string }[] }[]> | undefined;
  const hasHook = (event: string): boolean =>
    (hooks?.[event] ?? []).some((g) => (g.hooks ?? []).some((h) => h.command.includes("praxarch")));
  for (const event of ["SessionStart", "PreToolUse", "PostToolUse", "Stop"]) {
    checks.push({ ok: hasHook(event), message: `settings.json wires the praxarch ${event} hook` });
  }
  const statusLine = settings["statusLine"] as { command?: string } | undefined;
  checks.push({
    ok: Boolean(statusLine?.command?.includes("praxarch")),
    message: "settings.json statusLine points at praxarch",
  });
  return checks;
}

async function checkClaudeMd(): Promise<Check> {
  const content = await readTextIfExists(CLAUDE_MD_PATH);
  const ok = Boolean(content?.includes("<!-- praxarch:orchestration:start -->"));
  return { ok, message: "CLAUDE.md has the praxarch orchestration policy block" };
}

async function checkAgents(): Promise<Check[]> {
  const checks: Check[] = [];
  for (const role of ROLE_FILES) {
    checks.push({
      ok: await exists(join(AGENTS_DIR, `${role}.md`)),
      message: `agents/${role}.md is installed`,
    });
  }
  return checks;
}

async function checkSkills(): Promise<Check[]> {
  const checks: Check[] = [];
  for (const name of SKILL_NAMES) {
    checks.push({
      ok: await exists(join(SKILLS_DIR, name, "SKILL.md")),
      message: `skills/${name} is installed`,
    });
  }
  return checks;
}

async function checkVersion(): Promise<Check> {
  const installed = await readJsonIfExists<{ version: string }>(join(PRAXARCH_INSTALL_DIR, "VERSION.json"));
  if (!installed) {
    return { ok: false, message: "no VERSION.json found in ~/.claude/praxarch — run `praxarch install`." };
  }
  const repoVersion = (JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8")) as { version: string })
    .version;
  const ok = installed.version === repoVersion;
  return {
    ok,
    message: ok
      ? `installed version matches repo (${repoVersion})`
      : `installed version ${installed.version} differs from repo ${repoVersion} — run \`praxarch install\` to update`,
  };
}

async function checkDistTree(): Promise<Check[]> {
  const checks: Check[] = [];
  for (const subdir of ["hooks", "statusline", "report"]) {
    checks.push({
      ok: await exists(join(PRAXARCH_INSTALL_DIR, subdir)),
      message: `praxarch/${subdir}/ is installed`,
    });
  }
  return checks;
}

function checkEnv(): Check {
  return {
    ok: !process.env["CLAUDE_CODE_SUBAGENT_MODEL"],
    message: "CLAUDE_CODE_SUBAGENT_MODEL is not set (it would override all role model bindings)",
  };
}

export async function doctor(): Promise<void> {
  const checks: Check[] = [
    ...(await checkSettings()),
    await checkClaudeMd(),
    ...(await checkAgents()),
    ...(await checkSkills()),
    ...(await checkDistTree()),
    await checkVersion(),
    checkEnv(),
  ];

  let readdirNote = "";
  try {
    const stale = (await readdir(AGENTS_DIR)).filter((f) => f.includes(".praxarch-backup-"));
    if (stale.length > 0) {
      readdirNote = `\nNote: ${stale.length} backup file(s) in agents/ from previous installs — safe to delete once you've confirmed the new versions are correct.`;
    }
  } catch {
    // agents dir may not exist yet; checkAgents already reports that.
  }

  const failing = checks.filter((c) => !c.ok);
  for (const check of checks) {
    process.stdout.write(`${check.ok ? "✓" : "✗"} ${check.message}\n`);
  }
  process.stdout.write(readdirNote ? `${readdirNote}\n` : "");
  process.stdout.write(`\n${checks.length - failing.length}/${checks.length} checks passed.\n`);

  if (failing.length > 0) process.exitCode = 1;
}
