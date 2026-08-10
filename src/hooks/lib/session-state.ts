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
