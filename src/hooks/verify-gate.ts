#!/usr/bin/env node
import { loadConfig } from "./lib/config.js";
import { diffStat } from "./lib/git-diff.js";
import { readSessionState, writeSessionState } from "./lib/session-state.js";
import { emit, readHookInput, type StopInput, type StopOutput } from "./lib/hook-io.js";

/**
 * Stop — blocks session completion when the working-tree diff is large enough to count as
 * "non-trivial" per config, and no CONFIRMED verifier pass (zero critical/major findings) is on
 * record for this session. This is the hard enforcement of the policy's "verify before claiming
 * done" rule, which pilotfish leaves as unenforced policy text.
 *
 * Escape hatches: PRAXARCH_SKIP_VERIFY=1 env var, or the orchestrator stating
 * "PRAXARCH_VERIFY_WAIVED: <reason>" in its final message for changes that genuinely don't
 * warrant a verifier pass (docs-only, config tweaks the diff-size heuristic can't distinguish).
 */

const WAIVER_PATTERN = /PRAXARCH_VERIFY_WAIVED:\s*(.+)/;

// After this many consecutive blocks in one stop cycle, fail open instead of re-blocking —
// per the hooks docs' stop_hook_active guidance, a Stop hook that blocks unconditionally can
// trap a session that can't (or won't) satisfy the gate in an infinite stop loop.
const MAX_CONSECUTIVE_BLOCKS = 2;

function allow(): StopOutput {
  return {};
}

async function main(): Promise<void> {
  const input = await readHookInput<StopInput>();

  if (process.env["PRAXARCH_SKIP_VERIFY"] === "1") {
    emit(allow());
    return;
  }

  const waiverMatch = input.last_assistant_message ? WAIVER_PATTERN.exec(input.last_assistant_message) : null;
  if (waiverMatch) {
    emit(allow());
    return;
  }

  const config = await loadConfig(input.cwd);
  const { changedLines, changedFiles } = await diffStat(input.cwd, config.verifyGate.ignorePatterns);

  const isNonTrivial =
    changedLines >= config.verifyGate.minChangedLines || changedFiles >= config.verifyGate.minChangedFiles;
  if (!isNonTrivial) {
    emit(allow());
    return;
  }

  const state = await readSessionState(input.session_id);
  const verifier = state.lastVerifier;

  const passed = verifier !== null && verifier.verdict === "CONFIRMED" && verifier.criticalOrMajorCount === 0;
  if (passed) {
    emit(allow());
    return;
  }

  const priorBlocks = input.stop_hook_active ? (state.verifyGateConsecutiveBlocks ?? 0) : 0;
  if (priorBlocks >= MAX_CONSECUTIVE_BLOCKS) {
    emit({
      systemMessage:
        `praxarch verify-gate: diff is still unverified after ${MAX_CONSECUTIVE_BLOCKS} blocks — ` +
        `failing open rather than trapping the session in a stop loop.`,
    } satisfies StopOutput);
    return;
  }
  state.verifyGateConsecutiveBlocks = priorBlocks + 1;
  await writeSessionState(state);

  const reasonDetail = verifier
    ? `last verifier pass was ${verifier.verdict} with ${verifier.criticalOrMajorCount} critical/major finding(s)`
    : "no verifier pass is on record for this session";

  const output: StopOutput = {
    decision: "block",
    reason:
      `praxarch verify-gate: this session changed ${changedLines} lines across ${changedFiles} files ` +
      `(non-trivial) but ${reasonDetail}. Run a verifier pass before reporting completion, or state ` +
      `"PRAXARCH_VERIFY_WAIVED: <reason>" if verification genuinely doesn't apply here.`,
    hookSpecificOutput: {
      hookEventName: "Stop",
      additionalContext:
        "Delegate to the verifier role for a fresh-context review of the changes, then re-check " +
        "completion. If this diff is something like docs/config that doesn't warrant verification, " +
        'say "PRAXARCH_VERIFY_WAIVED: <reason>" explicitly instead of just stopping.',
    },
  };
  emit(output);
}

main().catch((err: unknown) => {
  // A verify-gate crash must never trap the session in an unstoppable loop — fail open.
  process.stderr.write(`praxarch verify-gate error (failing open): ${String(err)}\n`);
  emit(allow());
});
