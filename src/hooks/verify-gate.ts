#!/usr/bin/env node
import { loadConfig } from "./lib/config.js";
import { diffFingerprint, diffStat } from "./lib/git-diff.js";
import { appendJsonl } from "./lib/jsonl.js";
import { logFileForDate } from "./lib/paths.js";
import { readSessionState, writeSessionState } from "./lib/session-state.js";
import { emit, readHookInput, type StopInput, type StopOutput } from "./lib/hook-io.js";

/**
 * Stop — blocks session completion when the diff since the session's recorded baseline commit
 * (falling back to HEAD, plus untracked new files) is large enough to count as "non-trivial" per
 * config, and no CONFIRMED verifier pass (zero critical/major findings) is on record for this
 * session. This is the hard enforcement of the policy's "verify before claiming done" rule, which
 * pilotfish leaves as unenforced policy text.
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

// Hard backstop against continuous tree churn defeating MAX_CONSECUTIVE_BLOCKS: that counter
// resets whenever the diff hash changes, so a session that touches one file per round never lets
// it reach its limit even though every round blocks. This second counter totals blocks across the
// whole stop cycle regardless of tree movement, so an unsatisfiable gate still terminates.
// Deliberately generous — big enough that genuine remediation work spanning several rounds is
// never cut off mid-flight, small enough that a churning, unsatisfiable gate still ends.
const MAX_CYCLE_BLOCKS = 5;

function allow(warnings: string[] = []): StopOutput {
  return warnings.length > 0 ? { systemMessage: warnings.join(" ") } : {};
}

// Appends config warnings to whatever systemMessage an already-built output carries (e.g. the
// loop-guard's own message), rather than overwriting it — the enforcement decision is unaffected.
function withConfigWarnings(output: StopOutput, warnings: string[]): StopOutput {
  if (warnings.length === 0) return output;
  const warningMessage = warnings.join(" ");
  return {
    ...output,
    systemMessage: output.systemMessage ? `${output.systemMessage} ${warningMessage}` : warningMessage,
  };
}

// Clears both loop-guard counters (the per-diff one, and its paired block-hash — see
// `verifyGateBlockHash` on SessionState — plus the per-cycle total) and persists it, but only
// when something actually changes — a quiet stop shouldn't rewrite the state file every time.
async function clearBlockCounters(state: Awaited<ReturnType<typeof readSessionState>>): Promise<void> {
  const hasCounter = (state.verifyGateConsecutiveBlocks ?? 0) !== 0;
  const hasBlockHash = state.verifyGateBlockHash !== undefined && state.verifyGateBlockHash !== null;
  const hasCycleCounter = (state.verifyGateCycleBlocks ?? 0) !== 0;
  if (hasCounter || hasBlockHash || hasCycleCounter) {
    state.verifyGateConsecutiveBlocks = 0;
    state.verifyGateBlockHash = null;
    state.verifyGateCycleBlocks = 0;
    await writeSessionState(state);
  }
}

// Set as soon as the hook input is parsed, so the crash handler at the bottom of this file can
// still attribute its fail-open log line to a session even though the exception it's handling
// happened well past main()'s own scope.
let sessionIdForCrashLog: string | null = null;

async function logFailOpen(sessionId: string | null, reason: "loop-guard" | "loop-guard-cycle" | "error", detail: string): Promise<void> {
  await appendJsonl(logFileForDate(), {
    at: new Date().toISOString(),
    sessionId,
    event: "verifyGateFailOpen",
    reason,
    detail,
  });
}

async function main(): Promise<void> {
  const input = await readHookInput<StopInput>();
  sessionIdForCrashLog = input.session_id;

  // Read (and clear) state before any early return, so every allow path — including the escape
  // hatches below — scopes the loop-guard counter to this stop cycle rather than leaking a stale
  // value into a later, unrelated cycle (issue #1, defect 1).
  const state = await readSessionState(input.session_id);
  // A new stop cycle always starts from zero, regardless of what this invocation ends up doing —
  // Claude Code guarantees stop_hook_active is false on the first round of any new stop attempt.
  if (!input.stop_hook_active) await clearBlockCounters(state);

  if (process.env["PRAXARCH_SKIP_VERIFY"] === "1") {
    await clearBlockCounters(state);
    emit(allow());
    return;
  }

  const waiverMatch = input.last_assistant_message ? WAIVER_PATTERN.exec(input.last_assistant_message) : null;
  if (waiverMatch) {
    // Remember which diff was waived. The gate measures the session's whole diff against
    // baselineHead, so a waiver that only allowed this one stop would re-block on every later
    // stop — including turns that changed nothing, because the cumulative diff hasn't shrunk.
    // A null fingerprint is deliberately not stored: an unhashable diff would otherwise be
    // waived forever, since the "has it moved?" test below could never disprove it.
    const waivedHash = await diffFingerprint(input.cwd);
    if (waivedHash !== null) state.verifyGateWaivedHash = waivedHash;
    // Written unconditionally rather than via clearBlockCounters, which skips the write when no
    // counter was set — that would drop the waiver on a first-round stop, the common case.
    state.verifyGateConsecutiveBlocks = 0;
    state.verifyGateBlockHash = null;
    state.verifyGateCycleBlocks = 0;
    await writeSessionState(state);
    emit(allow());
    return;
  }

  const { config, warnings } = await loadConfig(input.cwd);
  const currentCounts = await diffStat(input.cwd, config.verifyGate.ignorePatterns, state.baselineHead);

  // `null` means the diff couldn't be measured at all (see diffStat's doc comment). Reading that
  // as trivial is exactly the bypass this fix exists to close, so a failed measurement is treated
  // as non-trivial unconditionally — it skips the early allow below and falls through to the same
  // verdict-demanding path as any other non-trivial diff, with its own message variant at the
  // bottom of this function. `current` still gets zeroed counts so the delta math further down
  // (which only runs once a verdict is already being demanded) has real numbers to subtract
  // against; measurementFailed is what actually drives every branching decision.
  const measurementFailed = currentCounts === null;
  const current = currentCounts ?? { changedLines: 0, changedFiles: 0 };
  const { changedLines, changedFiles } = current;

  const isNonTrivial =
    measurementFailed ||
    changedLines >= config.verifyGate.minChangedLines ||
    changedFiles >= config.verifyGate.minChangedFiles;
  if (!isNonTrivial) {
    await clearBlockCounters(state);
    emit(allow(warnings));
    return;
  }

  // Only fetched past this point: the trivial-diff early return above is the common case, and it
  // never needs a fingerprint — diffFingerprint reads every dirty/untracked file's full current
  // contents, where diffStat's counts above are cheap by comparison.
  const currentHash = await diffFingerprint(input.cwd);

  // A waiver stands until the work moves. Without this the gate re-blocks on every stop for the
  // rest of the session, because it measures the cumulative diff against baselineHead — so even a
  // turn that changed nothing still presents the same non-trivial diff and gets blocked again.
  // An unknown current hash never matches (diffFingerprint returns null, and the stored value is
  // never null), so an unhashable diff falls through to normal enforcement rather than riding a
  // stale waiver.
  if (currentHash !== null && state.verifyGateWaivedHash === currentHash) {
    await clearBlockCounters(state);
    emit(allow(warnings));
    return;
  }

  const verifier = state.lastVerifier;

  // Legacy records (predating fingerprint capture) omit `diffHash` entirely and are accepted
  // unconditionally — deliberate backward compatibility; only in-flight sessions can hold one.
  // A record that DOES carry the key but with a null value means telemetry attempted to
  // fingerprint and failed (e.g. a patch too large to buffer) — that must NOT get the same free
  // pass, or an unhashable diff at record time would make a verdict immortal the same way an
  // unhashable diff at read time would (see `currentHash === null` below).
  // Invariant this rests on: telemetry.ts assigns `diffHash` a real `string | null` on every
  // branch, never `undefined` — `"diffHash" in verifier` only tells legacy and failed records
  // apart because `JSON.stringify` drops `undefined`-valued keys but keeps `null` ones. Any
  // future write path that assigns `diffHash: undefined` (an object spread, an optional-property
  // assignment) would silently reclassify a failed fingerprint as legacy and hand it the free pass.
  const verifierHasFingerprint = verifier !== null && "diffHash" in verifier;
  const verifierHash = verifier?.diffHash ?? null;
  // Missing counts (the whole fingerprint attempt failed, not just the hash) compare against 0 —
  // maximally conservative, since we have no real baseline to diff against.
  const verifierChangedLines = verifier?.changedLines ?? 0;
  const verifierChangedFiles = verifier?.changedFiles ?? 0;
  const lineDelta = current.changedLines - verifierChangedLines;
  const fileDelta = current.changedFiles - verifierChangedFiles;

  const stale =
    verifierHasFingerprint &&
    // "Differs" includes "unknown": currentHash === null (the patch itself couldn't be
    // fingerprinted this time) must not read as "unchanged" — that's exactly the failure this
    // fingerprinting exists to catch. Negative deltas (work reverted) never satisfy the size
    // clause below, so this can't cause a spurious block on a shrinking diff.
    (currentHash === null || verifierHash !== currentHash) &&
    (lineDelta >= config.verifyGate.minChangedLines || fileDelta >= config.verifyGate.minChangedFiles);

  const passed = verifier !== null && verifier.verdict === "CONFIRMED" && verifier.criticalOrMajorCount === 0 && !stale;
  if (passed) {
    await clearBlockCounters(state);
    emit(allow(warnings));
    return;
  }

  const priorBlocksRaw = state.verifyGateConsecutiveBlocks ?? 0;
  // If the tree has moved since the blocks that tripped this counter, those blocks no longer
  // describe "the same unsatisfiable diff" — treat this as a fresh start rather than letting a
  // stale count suppress enforcement of new, unverified work (this is what actually closes the
  // "fails open even after a fresh batch of unverified changes" hole). An unknown current hash
  // does NOT reset — that would hand back an infinite-loop vector via a diff the gate can no
  // longer see.
  const treeChangedSinceLastBlock =
    currentHash !== null && state.verifyGateBlockHash != null && state.verifyGateBlockHash !== currentHash;
  const priorBlocks = treeChangedSinceLastBlock ? 0 : priorBlocksRaw;

  // Never reset by tree movement (unlike priorBlocks above) — this is the backstop that catches a
  // churning tree defeating MAX_CONSECUTIVE_BLOCKS by resetting it before it ever trips.
  const priorCycleBlocks = state.verifyGateCycleBlocks ?? 0;

  if (priorBlocks >= MAX_CONSECUTIVE_BLOCKS || priorCycleBlocks >= MAX_CYCLE_BLOCKS) {
    // Deliberately NOT cleared here: once the loop guard trips in a cycle it stays tripped for
    // the rest of that cycle — only a stop_hook_active: false cycle boundary, or (for the
    // per-diff counter only) the tree changing, resets it. Clearing here would turn the bounded
    // "N blocks then quiet" guarantee into block, block, allow forever.
    const cycleCeilingHit = priorCycleBlocks >= MAX_CYCLE_BLOCKS;
    if (cycleCeilingHit) {
      await logFailOpen(
        input.session_id,
        "loop-guard-cycle",
        `${MAX_CYCLE_BLOCKS} total blocks in one stop cycle (cycle ceiling)`,
      );
      emit(
        withConfigWarnings(
          {
            systemMessage:
              `praxarch verify-gate: hit the per-cycle ceiling (${MAX_CYCLE_BLOCKS} blocks total this cycle, ` +
              `cycle ceiling reached even though the diff kept changing) — failing open rather than trapping ` +
              `the session in a stop loop.`,
          },
          warnings,
        ),
      );
    } else {
      await logFailOpen(
        input.session_id,
        "loop-guard",
        `${MAX_CONSECUTIVE_BLOCKS} consecutive blocks in one stop cycle`,
      );
      emit(
        withConfigWarnings(
          {
            systemMessage:
              `praxarch verify-gate: diff is still unverified after ${MAX_CONSECUTIVE_BLOCKS} blocks against ` +
              `an unchanged diff — failing open rather than trapping the session in a stop loop.`,
          },
          warnings,
        ),
      );
    }
    return;
  }
  state.verifyGateConsecutiveBlocks = priorBlocks + 1;
  state.verifyGateBlockHash = currentHash;
  state.verifyGateCycleBlocks = priorCycleBlocks + 1;
  await writeSessionState(state);

  // Only one of lineDelta/fileDelta needs to clear its threshold for `stale` to trip (see the
  // clause above) — the other can independently be negative (e.g. files reverted while an
  // existing file's line count grew past the threshold). A signed number read literally as
  // "grew by -3" or pluralized as "-1 lines" doesn't read as English, so each delta gets its own
  // sign-aware phrasing instead of printing the raw (possibly negative) number.
  const lineDeltaPhrase =
    lineDelta < 0
      ? `${-lineDelta} line${-lineDelta === 1 ? "" : "s"} reverted`
      : `${lineDelta} line${lineDelta === 1 ? "" : "s"} changed`;
  const fileDeltaPhrase = fileDelta < 0 ? `shrank by ${-fileDelta}` : `grew by ${fileDelta}`;

  const reasonDetail =
    verifier === null
      ? "no verifier pass is on record for this session"
      : stale
        ? `last verifier pass (${verifier.verdict}) is stale — ${lineDeltaPhrase} and the file count ` +
          `${fileDeltaPhrase} since it was recorded`
        : `last verifier pass was ${verifier.verdict} with ${verifier.criticalOrMajorCount} critical/major finding(s)`;

  // A failed measurement has no real changedLines/changedFiles to report — the size-phrased
  // message above would print zeros and read as "trivial but blocked," which is backwards. This
  // variant states the actual reason (diff could not be measured) instead.
  const output: StopOutput = withConfigWarnings(
    {
      decision: "block",
      reason: measurementFailed
        ? "praxarch verify-gate: the session's diff could not be measured (git diff failed) — treating as " +
          'non-trivial. Run a verifier pass before reporting completion, or state "PRAXARCH_VERIFY_WAIVED: ' +
          '<reason>" if verification genuinely doesn\'t apply here.'
        : `praxarch verify-gate: this session changed ${changedLines} lines across ${changedFiles} files ` +
          `(non-trivial) but ${reasonDetail}. Run a verifier pass before reporting completion, or state ` +
          `"PRAXARCH_VERIFY_WAIVED: <reason>" if verification genuinely doesn't apply here.`,
      hookSpecificOutput: {
        hookEventName: "Stop",
        additionalContext:
          "Delegate to the verifier role for a fresh-context review of the changes, then re-check " +
          "completion. If this diff is something like docs/config that doesn't warrant verification, " +
          'say "PRAXARCH_VERIFY_WAIVED: <reason>" explicitly instead of just stopping.',
      },
    },
    warnings,
  );
  emit(output);
}

main().catch(async (err: unknown) => {
  // A verify-gate crash must never trap the session in an unstoppable loop — fail open. Nothing
  // in this handler may throw: stderr isn't shown to the user, so the systemMessage is what
  // actually surfaces this, and the log line is best-effort on top of that.
  const detail = String(err);
  process.stderr.write(`praxarch verify-gate error (failing open): ${detail}\n`);
  try {
    await logFailOpen(sessionIdForCrashLog, "error", detail);
  } catch {
    // Best-effort — a logging failure must not compound the original crash.
  }
  emit({
    systemMessage: `praxarch verify-gate: crashed and is failing open rather than blocking the session (${detail}).`,
  });
});
