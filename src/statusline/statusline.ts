#!/usr/bin/env node
import { readJsonl } from "../hooks/lib/jsonl.js";
import { logFileForDate } from "../hooks/lib/paths.js";
import { readSessionState } from "../hooks/lib/session-state.js";
import { readStdin } from "../hooks/lib/hook-io.js";

/**
 * Renders a one-line role-spend summary for the current session: how many delegations per role,
 * and whether the last verifier pass (if any) confirmed. Debounced by Claude Code itself
 * (~300ms), so this stays fast by only reading the current month's log, filtered to this session.
 */

interface DelegationLogRecord {
  sessionId: string;
  role: string;
}

interface StatuslineInput {
  session_id?: string;
}

const ROLE_LABEL: Record<string, string> = {
  scout: "scout",
  Explore: "explore",
  "mech-executor": "mech",
  executor: "exec",
  verifier: "verify",
  "security-executor": "sec",
};

async function main(): Promise<void> {
  let sessionId: string | undefined;
  try {
    const raw = await readStdin();
    sessionId = (JSON.parse(raw) as StatuslineInput).session_id;
  } catch {
    sessionId = undefined;
  }

  if (!sessionId) {
    process.stdout.write("praxarch");
    return;
  }

  const records = await readJsonl<DelegationLogRecord>(logFileForDate());
  const sessionRecords = records.filter((r) => r.sessionId === sessionId);

  const counts = new Map<string, number>();
  for (const record of sessionRecords) {
    const label = ROLE_LABEL[record.role] ?? record.role;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }

  const parts = [...counts.entries()].map(([label, count]) => `${label}×${count}`);

  const state = await readSessionState(sessionId);
  if (state.lastVerifier) {
    parts.push(
      state.lastVerifier.verdict === "CONFIRMED" && state.lastVerifier.criticalOrMajorCount === 0
        ? "✓verified"
        : "✗unverified",
    );
  }

  const summary = parts.length > 0 ? parts.join(" ") : "idle";
  process.stdout.write(`praxarch ▸ ${summary}`);
}

main().catch(() => {
  process.stdout.write("praxarch");
});
