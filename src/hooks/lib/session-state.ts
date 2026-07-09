import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { sessionStatePath } from "./paths.js";

export interface VerifierRecord {
  verdict: "CONFIRMED" | "REFUTED";
  findingsCount: number;
  criticalOrMajorCount: number;
  recordedAt: string;
}

export interface DelegationRecord {
  role: string;
  model: string;
  at: string;
}

export interface SessionState {
  sessionId: string;
  startedAt: string;
  delegations: DelegationRecord[];
  lastVerifier: VerifierRecord | null;
}

function emptyState(sessionId: string): SessionState {
  return { sessionId, startedAt: new Date().toISOString(), delegations: [], lastVerifier: null };
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
