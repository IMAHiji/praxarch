#!/usr/bin/env node
import { readSessionState, type SessionState } from "../hooks/lib/session-state.js";
import { readStdin } from "../hooks/lib/hook-io.js";

/**
 * Renders a one-line role-spend summary for the current session: delegations per role, total
 * delegated tokens, and whether the last verifier pass (if any) confirmed. Reads only the
 * session's state file — telemetry keeps it in sync with the JSONL log, it stays small, and
 * unlike the monthly log it can't straddle a month boundary. Debounced by Claude Code itself
 * (~300ms).
 *
 * Also renders verify-gate state, from ALREADY-PERSISTED session state only — this process must
 * never spawn git or call diffStat/diffFingerprint. That constraint decides what can be said: the
 * only diff numbers on disk are the ones a verdict was recorded against, so they are stamped
 * `@120L/4f` and never presented as the current diff, and "no verdict on record" is a statement
 * about the record, not about the tree. Motivation is token cost — a Stop-hook block costs a full
 * extra turn, and everything needed to dispatch a verifier BEFORE stopping is already on disk.
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

/**
 * Verify-gate state from persisted session state. Mirrors verify-gate.ts's pass condition
 * (`verdict === "CONFIRMED" && criticalOrMajorCount === 0`) but deliberately cannot evaluate its
 * `stale` clause, which needs a live fingerprint — hence the verdict-time size stamp below, which
 * hands the staleness judgement to the reader rather than guessing at it.
 */
function gateParts(state: SessionState): string[] {
  const parts: string[] = [];
  const verifier = state.lastVerifier;

  if (verifier === null) {
    // Only claimed when there is evidence of real work: an idle session must keep rendering
    // "idle". `delegations.length` is the only work signal on disk — there is no diff measurement
    // in session state at all, so a session doing everything locally shows nothing here until the
    // gate blocks it once (the cycle-block marker below).
    if (state.delegations.length > 0) parts.push("✗no verdict");
  } else if (verifier.verdict === "CONFIRMED" && verifier.criticalOrMajorCount === 0) {
    // The size the verdict was recorded against — NOT the current diff. This is exactly what
    // verify-gate's staleness rule (verify-gate.ts:209-216) compares the live size against, so
    // showing it lets the orchestrator judge staleness itself without this process measuring
    // anything. Both numbers must be real: `null` means the measurement failed, and a half-known
    // pair is more misleading than none.
    const lines = verifier.changedLines;
    const files = verifier.changedFiles;
    const size = typeof lines === "number" && typeof files === "number" ? `@${lines}L/${files}f` : "";
    parts.push(`✓verified${size}`);
  } else {
    // Everything that will not satisfy the gate: a REFUTED verdict, or a CONFIRMED one carrying
    // critical/major findings — verify-gate requires both conditions. The count is appended only
    // when non-zero, so the plain REFUTED case renders exactly as it did before this change.
    const count = verifier.criticalOrMajorCount;
    parts.push(count > 0 ? `✗unverified(${count} crit/major)` : "✗unverified");
  }

  // Additive, never suppressing: a waiver holds only while the diff fingerprint it was recorded
  // against still matches (see verifyGateWaivedHash's doc comment in session-state.ts), so hiding
  // "no verdict" behind it would be the misleading direction for a display.
  if (typeof state.verifyGateWaivedHash === "string" && state.verifyGateWaivedHash.length > 0) {
    parts.push("waived");
  }

  // The per-cycle total, not the per-diff counter: it is never reset by tree movement, so a
  // non-zero value means "this stop cycle has already been blocked N times and isn't resolved yet".
  // Shown regardless of delegation count — it is the one hard proof of a non-trivial diff this
  // process can read without measuring anything.
  const cycleBlocks = state.verifyGateCycleBlocks ?? 0;
  if (cycleBlocks > 0) parts.push(`blocked×${cycleBlocks}`);

  return parts;
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

  parts.push(...gateParts(state));

  const summary = parts.length > 0 ? parts.join(" ") : "idle";
  process.stdout.write(`praxarch ▸ ${summary}`);
}

main().catch(() => {
  process.stdout.write("praxarch");
});
