import { cp, mkdir, readdir, readFile, rm } from "node:fs/promises";
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
import { copyWithBackup, exists, isSymlink, linkResolves, realpathOrNull, resolvesIntoPraxarchRepo, sameContent, readJsonIfExists, readTextIfExists, writeJson, backupThenWriteJson, backupThenWriteText } from "./lib/fsops.js";
import { mergeSettings, type SettingsFragment } from "./lib/settings-merge.js";
import { upsertOrchestrationBlock } from "./lib/claude-md-merge.js";
import { DEFAULT_CONFIG } from "../hooks/lib/config.js";
import { globalConfigPath } from "../hooks/lib/paths.js";

interface InstallOptions {
  yes: boolean;
}

const DIST_SUBDIRS = ["hooks", "statusline", "report"] as const;
const AT_SOURCE_PLAN = "symlinked into a praxarch checkout → source file, left as-is";

async function listMarkdownFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
}

/**
 * Read-only mirror of copyWithBackup's decision, for the plan preview. Must not mutate anything —
 * the plan runs before the user has confirmed, so unlike apply it cannot unlink broken symlinks.
 */
async function destPlan(dest: string, src: string, overwriteLabel = "overwrite (backed up)"): Promise<string> {
  if (await resolvesIntoPraxarchRepo(dest)) return AT_SOURCE_PLAN;

  if (await isSymlink(dest)) {
    if (!(await linkResolves(dest))) return "broken symlink → replaced";
    const target = await realpathOrNull(dest);
    if (target === null) return "unreadable symlink → left alone";
    return (await sameContent(src, target))
      ? `symlink → already current, left as-is (${target})`
      : `symlink → updated through it (${target})`;
  }

  if (!(await exists(dest))) return "create";
  // Mirror backupAndCopy: identical bytes mean no write and no backup, so don't promise either.
  return (await sameContent(src, dest)) ? "already current, unchanged" : overwriteLabel;
}

/** A broken dir symlink must be unlinked before we can mkdir/copy into it. */
async function clearBrokenDirLink(dir: string): Promise<void> {
  if ((await isSymlink(dir)) && !(await linkResolves(dir))) await rm(dir, { force: true });
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
    const plan = await destPlan(join(AGENTS_DIR, file), join(TEMPLATES_DIR, "agents", file));
    lines.push(`  - ${file}: ${plan}`);
  }

  let skillDirs: string[] = [];
  try {
    skillDirs = await readdir(join(TEMPLATES_DIR, "skills"));
  } catch {
    skillDirs = [];
  }
  lines.push(`~/.claude/skills/ (${SKILLS_DIR}):`);
  for (const dir of skillDirs) {
    // A live symlinked skill dir needs no special case: the SKILL.md path simply resolves through
    // it, and destPlan's praxarch-repo check catches links that point back into a checkout.
    const src = join(TEMPLATES_DIR, "skills", dir, "SKILL.md");
    lines.push(`  - ${dir}: ${await destPlan(join(SKILLS_DIR, dir, "SKILL.md"), src)}`);
  }

  lines.push(`~/.claude/praxarch/ (${PRAXARCH_INSTALL_DIR}):`);
  for (const subdir of DIST_SUBDIRS) {
    const src = join(DIST_DIR, subdir);
    // Mirror apply: a subdir missing from this build is skipped there, so don't promise it here.
    if (!(await exists(src))) continue;
    const plan = await destPlan(join(PRAXARCH_INSTALL_DIR, subdir), src, "overwrite");
    lines.push(`  - ${subdir}/: ${plan === "create" ? "copy compiled files from dist/" : plan}`);
  }
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

async function copyDistTree(atSource: string[]): Promise<void> {
  for (const subdir of DIST_SUBDIRS) {
    const src = join(DIST_DIR, subdir);
    if (!(await exists(src))) continue;

    let dest = join(PRAXARCH_INSTALL_DIR, subdir);
    if (await resolvesIntoPraxarchRepo(dest)) {
      atSource.push(`praxarch/${subdir}/`);
      continue;
    }
    // Preserve a live link and copy through it; clear a broken one so mkdir can rebuild it.
    if (await isSymlink(dest)) {
      if (!(await linkResolves(dest))) await rm(dest, { force: true });
      else {
        const target = await realpathOrNull(dest);
        if (target === null) continue;
        dest = target;
      }
    }

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

  // A dangling container-dir link makes every later mkdir fail; clear it before writing anything.
  for (const dir of [AGENTS_DIR, SKILLS_DIR, PRAXARCH_INSTALL_DIR]) await clearBrokenDirLink(dir);

  const atSource: string[] = [];

  const agentFiles = await listMarkdownFiles(join(TEMPLATES_DIR, "agents"));
  for (const file of agentFiles) {
    const { action } = await copyWithBackup(join(TEMPLATES_DIR, "agents", file), join(AGENTS_DIR, file));
    if (action === "already-at-source") atSource.push(`agents/${file}`);
  }

  let skillDirs: string[] = [];
  try {
    skillDirs = await readdir(join(TEMPLATES_DIR, "skills"));
  } catch {
    skillDirs = [];
  }
  for (const dir of skillDirs) {
    await clearBrokenDirLink(join(SKILLS_DIR, dir));
    const { action } = await copyWithBackup(
      join(TEMPLATES_DIR, "skills", dir, "SKILL.md"),
      join(SKILLS_DIR, dir, "SKILL.md"),
    );
    if (action === "already-at-source") atSource.push(`skills/${dir}/`);
  }

  await copyDistTree(atSource);

  if (!(await exists(globalConfigPath()))) {
    await writeJson(globalConfigPath(), DEFAULT_CONFIG);
  }

  const version = (
    JSON.parse((await readFile(join(REPO_ROOT, "package.json"), "utf8"))) as { version: string }
  ).version;
  await writeJson(join(PRAXARCH_INSTALL_DIR, "VERSION.json"), { version, installedAt: new Date().toISOString() });

  process.stdout.write(`\npraxarch installed to ${CLAUDE_HOME}\n`);
  if (atSource.length > 0) {
    process.stdout.write(
      `\nLeft ${atSource.length} path(s) as-is — they are symlinked into a praxarch checkout, so ` +
        `they are source files, not install targets:\n${atSource.map((s) => `  - ${s}`).join("\n")}\n` +
        `Update them with \`git pull && pnpm build\` in that checkout (this one is ${REPO_ROOT}).\n`,
    );
  }
}
