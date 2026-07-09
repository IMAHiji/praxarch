import { homedir } from "node:os";
import { join } from "node:path";

// Functions, not module-level constants: every hook process is short-lived and reads env once at
// startup in production, but in-process tests mutate process.env between calls, so these must
// re-read it on every call rather than freezing a value at import time.

export function praxarchHome(): string {
  return process.env["PRAXARCH_HOME"] ?? join(homedir(), ".claude", "praxarch");
}

export function logDir(): string {
  return join(praxarchHome(), "logs");
}

export function stateDir(): string {
  return join(praxarchHome(), "state");
}

export function globalConfigPath(): string {
  return join(praxarchHome(), "config.json");
}

export function logFileForDate(date: Date = new Date()): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return join(logDir(), `${year}-${month}.jsonl`);
}

export function sessionStatePath(sessionId: string): string {
  return join(stateDir(), `${sessionId}.json`);
}

export function projectConfigPath(cwd: string): string {
  return join(cwd, ".claude", "praxarch.json");
}
