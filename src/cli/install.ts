import { cp, mkdir, readdir, readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import {
  AGENTS_DIR,
  CLAUDE_HOME,
  CLAUDE_MD_PATH,
  DIST_DIR,
  PRAXARCH_INSTALL_DIR,
  REPO_ROOT,
  SETTINGS_PATH,
  SKILLS_DIR,
  TEMPLATES_DIR,
} from "./lib/paths.js";
import { copyWithBackup, exists, readJsonIfExists, readTextIfExists, writeJson, backupThenWriteJson, backupThenWriteText } from "./lib/fsops.js";
import { mergeSettings, type SettingsFragment } from "./lib/settings-merge.js";
import { upsertOrchestrationBlock } from "./lib/claude-md-merge.js";
import { DEFAULT_CONFIG } from "../hooks/lib/config.js";
import { globalConfigPath } from "../hooks/lib/paths.js";

interface InstallOptions {
  yes: boolean;
}

async function listMarkdownFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
}

async function planSummary(): Promise<{ lines: string[]; settingsFragment: SettingsFragment }> {
  const lines: string[] = [];

  const fragmentRaw = (await readJsonIfExists<SettingsFragment>(join(TEMPLATES_DIR, "settings.fragment.json"))) ?? {};
  const { $comment: _comment, ...settingsFragment } = fragmentRaw;
  const existingSettings = (await readJsonIfExists<Record<string, unknown>>(SETTINGS_PATH)) ?? {};
  const { changes: settingsChanges } = mergeSettings(existingSettings, settingsFragment);
  lines.push(`~/.claude/settings.json (${SETTINGS_PATH}):`);
  lines.push(...settingsChanges.map((c) => `  - ${c}`));

  const existingClaudeMd = (await readTextIfExists(CLAUDE_MD_PATH)) ?? "";
  const orchestrationBlock = (await readTextIfExists(join(TEMPLATES_DIR, "claude-md.orchestration.md"))) ?? "";
  const { action } = upsertOrchestrationBlock(existingClaudeMd, orchestrationBlock);
  lines.push(`~/.claude/CLAUDE.md (${CLAUDE_MD_PATH}):`);
  lines.push(`  - orchestration policy block: ${action}`);

  const agentFiles = await listMarkdownFiles(join(TEMPLATES_DIR, "agents"));
  lines.push(`~/.claude/agents/ (${AGENTS_DIR}):`);
  for (const file of agentFiles) {
    const dest = join(AGENTS_DIR, file);
    lines.push(`  - ${file}: ${(await exists(dest)) ? "overwrite (backed up)" : "create"}`);
  }

  let skillDirs: string[] = [];
  try {
    skillDirs = await readdir(join(TEMPLATES_DIR, "skills"));
  } catch {
    skillDirs = [];
  }
  lines.push(`~/.claude/skills/ (${SKILLS_DIR}):`);
  for (const dir of skillDirs) {
    const dest = join(SKILLS_DIR, dir, "SKILL.md");
    lines.push(`  - ${dir}: ${(await exists(dest)) ? "overwrite (backed up)" : "create"}`);
  }

  lines.push(`~/.claude/praxarch/ (${PRAXARCH_INSTALL_DIR}):`);
  lines.push("  - copy compiled hooks, statusline, report from dist/");
  lines.push(`  - config.json: ${(await exists(globalConfigPath())) ? "already exists, left unchanged" : "create with defaults"}`);
  lines.push("  - VERSION: write");

  return { lines, settingsFragment };
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return answer.trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
}

async function copyDistTree(): Promise<void> {
  for (const subdir of ["hooks", "statusline", "report"]) {
    const src = join(DIST_DIR, subdir);
    if (!(await exists(src))) continue;
    const dest = join(PRAXARCH_INSTALL_DIR, subdir);
    await mkdir(dest, { recursive: true });
    await cp(src, dest, {
      recursive: true,
      filter: (source) => !source.includes(".test."),
    });
  }
}

export async function install(options: InstallOptions): Promise<void> {
  const { lines, settingsFragment } = await planSummary();

  process.stdout.write("praxarch install plan:\n\n");
  process.stdout.write(`${lines.join("\n")}\n\n`);
  process.stdout.write(
    "Existing files that change are backed up alongside themselves as <file>.praxarch-backup-<timestamp>.\n\n",
  );

  if (!options.yes) {
    const proceed = await confirm("Apply these changes to your global Claude Code config?");
    if (!proceed) {
      process.stdout.write("Aborted — no changes made.\n");
      return;
    }
  }

  const existingSettings = (await readJsonIfExists<Record<string, unknown>>(SETTINGS_PATH)) ?? {};
  const { merged } = mergeSettings(existingSettings, settingsFragment);
  await backupThenWriteJson(SETTINGS_PATH, merged);

  const existingClaudeMd = (await readTextIfExists(CLAUDE_MD_PATH)) ?? "";
  const orchestrationBlock = (await readTextIfExists(join(TEMPLATES_DIR, "claude-md.orchestration.md"))) ?? "";
  const { content } = upsertOrchestrationBlock(existingClaudeMd, orchestrationBlock);
  await backupThenWriteText(CLAUDE_MD_PATH, content);

  const agentFiles = await listMarkdownFiles(join(TEMPLATES_DIR, "agents"));
  for (const file of agentFiles) {
    await copyWithBackup(join(TEMPLATES_DIR, "agents", file), join(AGENTS_DIR, file));
  }

  let skillDirs: string[] = [];
  try {
    skillDirs = await readdir(join(TEMPLATES_DIR, "skills"));
  } catch {
    skillDirs = [];
  }
  for (const dir of skillDirs) {
    await copyWithBackup(
      join(TEMPLATES_DIR, "skills", dir, "SKILL.md"),
      join(SKILLS_DIR, dir, "SKILL.md"),
    );
  }

  await copyDistTree();

  if (!(await exists(globalConfigPath()))) {
    await writeJson(globalConfigPath(), DEFAULT_CONFIG);
  }

  const version = (
    JSON.parse((await readFile(join(REPO_ROOT, "package.json"), "utf8"))) as { version: string }
  ).version;
  await writeJson(join(PRAXARCH_INSTALL_DIR, "VERSION.json"), { version, installedAt: new Date().toISOString() });

  process.stdout.write(`\npraxarch installed to ${CLAUDE_HOME}\n`);
}
