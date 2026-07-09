import { homedir } from "node:os";
import { join } from "node:path";

export const PRAXARCH_HOME = process.env["PRAXARCH_HOME"] ?? join(homedir(), ".claude", "praxarch");

export const LOG_DIR = join(PRAXARCH_HOME, "logs");
export const STATE_DIR = join(PRAXARCH_HOME, "state");
export const GLOBAL_CONFIG_PATH = join(PRAXARCH_HOME, "config.json");

export function logFileForDate(date: Date = new Date()): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return join(LOG_DIR, `${year}-${month}.jsonl`);
}

export function sessionStatePath(sessionId: string): string {
  return join(STATE_DIR, `${sessionId}.json`);
}

export function projectConfigPath(cwd: string): string {
  return join(cwd, ".claude", "praxarch.json");
}
