import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { sessionStatePath } from "./paths.js";

export interface VerifierRecord {
  verdict: "CONFIRMED" | "REFUTED";
  findingsCount: number;
  criticalOrMajorCount: number;
  recordedAt: string;
  /** Fingerprint of the diff this verdict was recorded against. Null in records predating capture. */
  diffHash?: string | null;
  changedLines?: number | null;
  changedFiles?: number | null;
}

export interface DelegationRecord {
  role: string;
  /** Model requested in the Agent call, or "inherited" when unset. */
  model: string;
  /** Model the subagent actually ran on, from tool_response. Null in records predating capture. */
  resolvedModel: string | null;
  totalTokens: number | null;
  durationMs: number | null;
  at: string;
}

export interface SessionState {
  sessionId: string;
  startedAt: string;
  delegations: DelegationRecord[];
  lastVerifier: VerifierRecord | null;
  /** Consecutive verify-gate blocks in the current stop cycle — the gate's loop guard. */
  verifyGateConsecutiveBlocks?: number;
  /**
   * Diff fingerprint recorded alongside the last consecutive block, so verify-gate can tell
   * whether the tree has moved since the blocks that tripped the loop guard — a changed tree
   * resets the counter (new, unverified work shouldn't inherit an old, unrelated trip count); an
   * unknown fingerprint (`null`) never resets it, since that would hand back an infinite-loop
   * vector via a diff the gate can no longer see.
   */
  verifyGateBlockHash?: string | null;
  /**
   * Total verify-gate blocks in the current stop cycle, across ALL diffs — unlike
   * `verifyGateConsecutiveBlocks`, this is never reset by tree movement, only by a cycle boundary
   * or a genuine allow. It's the hard backstop against a churning tree (a file touched between
   * every round) resetting `verifyGateConsecutiveBlocks` before it ever reaches its own limit,
   * which would otherwise make the loop guard unreachable.
   */
  verifyGateCycleBlocks?: number;
  /**
   * `HEAD` sha captured at SessionStart, used by verify-gate to diff against the state at the
   * start of the session rather than the working tree's uncommitted changes only. Null when
   * cwd wasn't a git repo (or had no commits yet) at session start.
   */
  baselineHead?: string | null;
  /**
   * Diff fingerprint at the moment a `PRAXARCH_VERIFY_WAIVED:` waiver was accepted. The gate
   * measures the whole session's diff against `baselineHead`, so without this a waived diff
   * re-blocks on every subsequent stop — including turns that changed nothing at all, since the
   * cumulative diff is still there. Holding the fingerprint lets the waiver stand until the work
   * actually moves; the moment the diff differs, the waiver no longer applies and the gate blocks
   * again on its own. Never set to null: an unhashable diff must not become permanently waived.
   */
  verifyGateWaivedHash?: string;
}

function emptyState(sessionId: string): SessionState {
  return {
    sessionId,
    startedAt: new Date().toISOString(),
    delegations: [],
    lastVerifier: null,
    baselineHead: null,
  };
}

export async function readSessionState(sessionId: string): Promise<SessionState> {
  const path = sessionStatePath(sessionId);
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as SessionState;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyState(sessionId);
    throw err;
  }
}

export async function writeSessionState(state: SessionState): Promise<void> {
  const path = sessionStatePath(state.sessionId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2), "utf8");
}

/**
 * Merge-write for callers (telemetry) that own only a subset of state's fields and may run
 * concurrently with another writer (verify-gate) that owns the rest. Re-reads the freshest
 * on-disk snapshot immediately before mutating and writing, rather than writing back whatever
 * was read at the start of a possibly-long-running caller — so a concurrent writer's change that
 * lands anywhere before this call still survives, instead of being silently overwritten by a
 * stale whole-object write. `mutate` must touch only the fields the caller owns; anything it
 * doesn't touch passes through unchanged from the fresh read. Not a lock: two callers racing this
 * function against each other can still interleave read/write pairs, but that's out of scope here
 * — see the calling hook's own concurrency contract.
 */
export async function updateSessionState(
  sessionId: string,
  mutate: (state: SessionState) => void,
): Promise<void> {
  const state = await readSessionState(sessionId);
  mutate(state);
  await writeSessionState(state);
}
