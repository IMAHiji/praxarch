import { lstat, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { praxarchHome, stateDir } from "../hooks/lib/paths.js";

/**
 * Retention sweep for the two praxarch directories that grow without bound: session state (one
 * `<id>.json` plus an optional `<id>.untracked.json` per session, forever — 1,029 files / 4.1MB
 * measured 2026-08-22) and `PRAXARCH_DEBUG_PAYLOADS=1` payload dumps. Nothing else is ever a
 * candidate: `logs/` is the audit trail `praxarch report` reads, and the installed trees are
 * install artifacts.
 *
 * The current session is protected twice over: by mtime (a live session rewrites its state file on
 * every PostToolUse, so it is never older than the window) and by an explicit CLAUDE_SESSION_ID
 * name-prefix skip. Per-session lockfiles (`<id>.json.lock`) and `.corrupt-<timestamp>` quarantine
 * files (see session-state.ts) are ordinary files under the same directory and are swept by the
 * same rule, deliberately — see paths.ts's sessionLockPath comment. A lock is held for at most
 * ~10s before session-state.ts's own staleness check breaks it, so a live lock's mtime is never
 * older than the retention window; no separate exclusion is needed.
 */

const DEFAULT_STATE_RETENTION_DAYS = 30;
const DEFAULT_DEBUG_RETENTION_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function retentionDays(envVar: string, fallback: number): number {
  const raw = process.env[envVar];
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export interface SweepCounts {
  removed: number;
  kept: number;
}

export interface PruneResult {
  state: SweepCounts;
  debug: SweepCounts;
  stateDays: number;
  debugDays: number;
}

async function sweepDir(dir: string, cutoffMs: number, dryRun: boolean): Promise<SweepCounts> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    // Directory absent (fresh install, or debug capture never enabled) — nothing to sweep.
    return { removed: 0, kept: 0 };
  }
  const currentSessionId = process.env["CLAUDE_SESSION_ID"] ?? "";
  let removed = 0;
  let kept = 0;
  for (const entry of entries) {
    // Belt-and-braces on top of the mtime rule below: never touch anything belonging to the
    // session that is running this command.
    if (currentSessionId !== "" && entry.startsWith(currentSessionId)) {
      kept += 1;
      continue;
    }
    const full = join(dir, entry);
    let st;
    try {
      st = await lstat(full);
    } catch {
      // Vanished between readdir and lstat, or unreadable — not ours to count either way.
      continue;
    }
    // lstat, and isFile() only: never follow a symlink, never descend or remove a directory.
    if (!st.isFile()) {
      kept += 1;
      continue;
    }
    if (st.mtimeMs >= cutoffMs) {
      kept += 1;
      continue;
    }
    if (!dryRun) {
      try {
        await unlink(full);
      } catch {
        // A file we cannot remove is a file we keep; one failure must not abort the sweep.
        kept += 1;
        continue;
      }
    }
    removed += 1;
  }
  return { removed, kept };
}

export async function pruneRetention(opts: { dryRun: boolean }): Promise<PruneResult> {
  const stateDays = retentionDays("PRAXARCH_STATE_RETENTION_DAYS", DEFAULT_STATE_RETENTION_DAYS);
  const debugDays = retentionDays("PRAXARCH_DEBUG_RETENTION_DAYS", DEFAULT_DEBUG_RETENTION_DAYS);
  const now = Date.now();
  const state = await sweepDir(stateDir(), now - stateDays * MS_PER_DAY, opts.dryRun);
  const debug = await sweepDir(join(praxarchHome(), "debug"), now - debugDays * MS_PER_DAY, opts.dryRun);
  return { state, debug, stateDays, debugDays };
}

export async function prune(): Promise<number> {
  const result = await pruneRetention({ dryRun: false });
  process.stdout.write(
    `praxarch: pruned ${result.state.removed} state file(s) older than ${result.stateDays} day(s) and ` +
      `${result.debug.removed} debug payload(s) older than ${result.debugDays} day(s); kept ` +
      `${result.state.kept} state file(s), ${result.debug.kept} debug payload(s).\n`,
  );
  return 0;
}
