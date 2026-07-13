#!/usr/bin/env node
import { readSessionState } from "../hooks/lib/session-state.js";
import { readStdin } from "../hooks/lib/hook-io.js";

/**
 * Renders a one-line role-spend summary for the current session: delegations per role, total
 * delegated tokens, and whether the last verifier pass (if any) confirmed. Reads only the
 * session's state file — telemetry keeps it in sync with the JSONL log, it stays small, and
 * unlike the monthly log it can't straddle a month boundary. Debounced by Claude Code itself
 * (~300ms).
 */

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

function formatTokens(total: number): string {
  if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M`;
  if (total >= 1_000) return `${Math.round(total / 1_000)}k`;
  return String(total);
}

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

  const state = await readSessionState(sessionId);

  const counts = new Map<string, number>();
  let tokens = 0;
  for (const delegation of state.delegations) {
    const label = ROLE_LABEL[delegation.role] ?? delegation.role;
    counts.set(label, (counts.get(label) ?? 0) + 1);
    tokens += delegation.totalTokens ?? 0;
  }

  const parts = [...counts.entries()].map(([label, count]) => `${label}×${count}`);
  if (tokens > 0) parts.push(`${formatTokens(tokens)} tok`);

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
