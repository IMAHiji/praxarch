import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** The ~/.claude directory the installer targets. Overridable so tests never touch a real home. */
export const CLAUDE_HOME = process.env["PRAXARCH_TARGET_CLAUDE_HOME"] ?? join(homedir(), ".claude");

export const AGENTS_DIR = join(CLAUDE_HOME, "agents");
export const SKILLS_DIR = join(CLAUDE_HOME, "skills");
export const SETTINGS_PATH = join(CLAUDE_HOME, "settings.json");
export const CLAUDE_MD_PATH = join(CLAUDE_HOME, "CLAUDE.md");
export const PRAXARCH_INSTALL_DIR = join(CLAUDE_HOME, "praxarch");

const here = dirname(fileURLToPath(import.meta.url));
/** Repo root, resolved relative to the compiled dist/cli/lib/paths.js location. */
export const REPO_ROOT = join(here, "..", "..", "..");
export const TEMPLATES_DIR = join(REPO_ROOT, "templates");
export const DIST_DIR = join(REPO_ROOT, "dist");
