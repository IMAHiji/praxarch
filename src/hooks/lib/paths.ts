import { homedir } from "node:os";
import { join } from "node:path";

// Functions, not module-level constants: every hook process is short-lived and reads env once at
// startup in production, but in-process tests mutate process.env between calls, so these must
// re-read it on every call rather than freezing a value at import time.

export function praxarchHome(): string {
  // `||` rather than `??`: an empty PRAXARCH_HOME (e.g. `export PRAXARCH_HOME=$UNSET_VAR`) must
  // mean "unset", not "the current directory" — stateDir() would otherwise resolve to the relative
  // path "state", which the retention sweep (cli/prune.ts) would then delete files from.
  return process.env["PRAXARCH_HOME"] || join(homedir(), ".claude", "praxarch");
}

// Sibling of praxarchHome(), not nested under it — agent definitions live at ~/.claude/agents,
// outside praxarch's own ~/.claude/praxarch tree. PRAXARCH_AGENTS_DIR mirrors the PRAXARCH_HOME
// override mechanism above so tests can point this at a fixture directory.
export function agentsDir(): string {
  return process.env["PRAXARCH_AGENTS_DIR"] ?? join(homedir(), ".claude", "agents");
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

// Sibling of the state file, so the lock lives on the same filesystem as its target and is swept
// by the same retention rule. See session-state.ts's acquireSessionLock for the protocol.
export function sessionLockPath(sessionId: string): string {
  return `${sessionStatePath(sessionId)}.lock`;
}

// Separate from sessionStatePath deliberately: session state is re-read, re-parsed,
// re-serialized, and re-written on every PostToolUse (telemetry.ts), while an untracked-file
// snapshot is written exactly once (SessionStart) and read rarely (a Stop-time diff measurement).
// Inlining the snapshot into session state made every one of those per-tool-call round trips pay
// for it -- a 2000-entry snapshot pushed a single hot-path write from ~10ms to ~3.5s. Opposite
// access patterns must not share a file.
export function untrackedBaselinePath(sessionId: string): string {
  return join(stateDir(), `${sessionId}.untracked.json`);
}

export function projectConfigPath(cwd: string): string {
  return join(cwd, ".claude", "praxarch.json");
}
