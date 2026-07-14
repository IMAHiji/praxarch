import { rm } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { AGENTS_DIR, CLAUDE_MD_PATH, PRAXARCH_INSTALL_DIR, SETTINGS_PATH, SKILLS_DIR } from "./lib/paths.js";
import { readJsonIfExists, readTextIfExists, backupThenWriteJson, backupThenWriteText } from "./lib/fsops.js";

// Lowercase "explore" — the installed file is explore.md; "Explore.md" only matched on
// case-insensitive filesystems, silently orphaning the file on uninstall elsewhere.
const ROLE_FILES = ["scout", "explore", "mech-executor", "executor", "verifier", "security-executor"];
const SKILL_NAMES = ["praxarch-report", "fan-out"];
const START_MARKER = "<!-- praxarch:orchestration:start -->";
const END_MARKER = "<!-- praxarch:orchestration:end -->";

interface HookCommand {
  type: string;
  command: string;
}
interface HookGroup {
  matcher?: string;
  hooks: HookCommand[];
}
type HooksMap = Record<string, HookGroup[]>;

interface UninstallOptions {
  yes: boolean;
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

function stripPraxarchHooks(hooks: HooksMap | undefined): HooksMap | undefined {
  if (!hooks) return hooks;
  const result: HooksMap = {};
  for (const [event, groups] of Object.entries(hooks)) {
    const cleanedGroups = groups
      .map((g) => ({ ...g, hooks: g.hooks.filter((h) => !h.command.includes("praxarch")) }))
      .filter((g) => g.hooks.length > 0);
    if (cleanedGroups.length > 0) result[event] = cleanedGroups;
  }
  return result;
}

function stripOrchestrationBlock(content: string): string {
  const startIdx = content.indexOf(START_MARKER);
  const endIdx = content.indexOf(END_MARKER);
  if (startIdx === -1 || endIdx === -1) return content;
  return content.slice(0, startIdx) + content.slice(endIdx + END_MARKER.length);
}

export async function uninstall(options: UninstallOptions): Promise<void> {
  process.stdout.write("praxarch uninstall will:\n");
  process.stdout.write("  - remove praxarch's hook entries and statusLine from settings.json (model/fallbackModel left as-is)\n");
  process.stdout.write("  - strip the orchestration policy block from CLAUDE.md\n");
  process.stdout.write(`  - delete agents/{${ROLE_FILES.join(", ")}}.md\n`);
  process.stdout.write(`  - delete skills/{${SKILL_NAMES.join(", ")}}\n`);
  process.stdout.write(`  - delete ${PRAXARCH_INSTALL_DIR} (compiled hooks, logs, session state, config)\n`);
  process.stdout.write("Backups (.praxarch-backup-*) are left in place.\n\n");

  if (!options.yes) {
    const proceed = await confirm("Proceed with uninstall?");
    if (!proceed) {
      process.stdout.write("Aborted — no changes made.\n");
      return;
    }
  }

  const settings = await readJsonIfExists<Record<string, unknown>>(SETTINGS_PATH);
  if (settings) {
    const cleaned = { ...settings };
    cleaned["hooks"] = stripPraxarchHooks(cleaned["hooks"] as HooksMap | undefined);
    const statusLine = cleaned["statusLine"] as { command?: string } | undefined;
    if (statusLine?.command?.includes("praxarch")) delete cleaned["statusLine"];
    await backupThenWriteJson(SETTINGS_PATH, cleaned);
  }

  const claudeMd = await readTextIfExists(CLAUDE_MD_PATH);
  if (claudeMd) {
    await backupThenWriteText(CLAUDE_MD_PATH, stripOrchestrationBlock(claudeMd));
  }

  for (const role of ROLE_FILES) {
    await rm(join(AGENTS_DIR, `${role}.md`), { force: true });
  }

  for (const name of SKILL_NAMES) {
    await rm(join(SKILLS_DIR, name), { recursive: true, force: true });
  }

  await rm(PRAXARCH_INSTALL_DIR, { recursive: true, force: true });

  process.stdout.write("praxarch uninstalled.\n");
}
