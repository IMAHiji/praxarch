#!/usr/bin/env node
import { loadConfig, type VerifyGateConfig } from "./lib/config.js";
import { diffFingerprint, diffStat } from "./lib/git-diff.js";
import { appendJsonl } from "./lib/jsonl.js";
import { resolveMeasurementContext } from "./lib/measurement-cwd.js";
import { logFileForDate } from "./lib/paths.js";
import { readSessionState, updateSessionState, type SessionState } from "./lib/session-state.js";
import { readUntrackedBaseline } from "./lib/untracked-baseline-store.js";
import { emit, readHookInput, type StopInput, type StopOutput } from "./lib/hook-io.js";
import { formatBuildRef, readBuildInfo } from "./lib/build-info.js";

/**
 * Stop — blocks session completion when the diff since the session's recorded baseline commit
 * (falling back to HEAD, plus untracked new files) is large enough to count as "non-trivial" per
 * config, and no CONFIRMED verifier pass (zero critical/major findings) is on record for this
 * session. This is the hard enforcement of the policy's "verify before claiming done" rule, which
 * pilotfish leaves as unenforced policy text.
 *
 * Escape hatches: PRAXARCH_SKIP_VERIFY=1 env var, or the orchestrator starting a line of its final
 * message with PRAXARCH_VERIFY_WAIVED: <reason> for changes that genuinely don't warrant a
 * verifier pass (docs-only, config tweaks the diff-size heuristic can't distinguish). The waiver
 * must begin a line — an unanchored match let the gate's own instruction text, quoted back, waive
 * it. A waiver is honoured only on a stop that would otherwise block; one typed on a stop that
 * would already pass on its own is logged as unneeded and never stored (issue #3). A hook that
 * exceeds its own watchdog budget fails open with reason "timeout", rather than being killed
 * silently by the harness.
 */

// Anchored to the start of a line (multiline), not matched anywhere in the message: the gate's own
// block message tells the assistant how to waive, and an unanchored pattern meant an assistant
// quoting that instruction back mid-sentence accidentally waived the gate. `[ \t]` rather than
// `\s` so the reason can't start on the following line.
const WAIVER_PATTERN = /^PRAXARCH_VERIFY_WAIVED:[ \t]*(.+)$/m;

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

// Hook-timeout self-watchdog. Claude Code kills a Stop hook at its configured `timeout` (seconds —
// see templates/settings.fragment.json) and treats the killed hook as non-blocking: no JSONL row,
// no systemMessage, nothing on disk to tell that fail-open apart from a clean allow. Firing our own
// allow at 80% of the budget converts a silent kill into the same logged, surfaced fail-open every
// other non-blocking path here already produces. diffFingerprint streams every dirty/untracked
// file's full contents (git-diff.ts), so a big tree can genuinely reach this.
const DEFAULT_HOOK_TIMEOUT_MS = 60_000;
const WATCHDOG_FRACTION = 0.8;

// PRAXARCH_VERIFY_GATE_TIMEOUT_MS is the FULL hook timeout in milliseconds; the watchdog fires at
// WATCHDOG_FRACTION of it. Anything non-numeric, non-finite, zero, or negative falls back to the
// default rather than producing a nonsensical budget. Capped so WATCHDOG_FRACTION of it stays
// under Node's 2^31-1 setTimeout ceiling — an overflowing delay is clamped to 1ms by Node, which
// would make the watchdog fire immediately and fail the gate open on every Stop.
const MAX_TIMEOUT_MS = Math.floor((2 ** 31 - 1) / WATCHDOG_FRACTION);
function effectiveTimeoutMs(): number {
  const raw = process.env["PRAXARCH_VERIFY_GATE_TIMEOUT_MS"];
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_HOOK_TIMEOUT_MS;
  return Math.min(parsed, MAX_TIMEOUT_MS);
}

// First writer to stdout wins. The watchdog and a late-finishing main() must never both emit — two
// JSON objects on stdout is unparseable output, strictly worse than either decision alone.
let hookOutputEmitted = false;
function emitOnce(output: StopOutput): void {
  if (hookOutputEmitted) return;
  hookOutputEmitted = true;
  emit(output);
}

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

// issue #3: lines alone make a diff non-trivial, files only with a line floor behind them — a pure
// file-count trigger fired on multi-file one-liners (8 lines across 4 files blocked 45 times in one
// orchestrating session). Shared by the non-trivial check and the staleness delta below so both
// apply one rule, and so a verdict whose counts are missing (compared against 0) is always stale
// whenever the diff was measured. Known gap, not by design, tracked for a follow-up issue: when
// numstat itself fails, measurementFailed zeroes the current counts, so a recorded verdict with a
// stale hash and real counts can see a negative delta and be treated as not stale — the opposite
// of the fail-closed intent elsewhere in this function.
function clearsThreshold(lines: number, files: number, gate: VerifyGateConfig): boolean {
  return lines >= gate.minChangedLines || (files >= gate.minChangedFiles && lines >= gate.minChangedLinesForFiles);
}

// Clears both loop-guard counters (the per-diff one, and its paired block-hash — see
// `verifyGateBlockHash` on SessionState — plus the per-cycle total), but only when something
// actually changes: a quiet stop shouldn't rewrite the state file every time. The in-memory
// `state` is mutated as well as persisted, so later reads in main() (e.g. `priorBlocks`) see the
// same values they always did. Persisted via `updateSessionState`, not `writeSessionState`: a
// whole-object write built from the read at the top of main() can clobber a `lastVerifier` a
// concurrent SubagentStop wrote in between — the exact field this gate reads.
async function clearBlockCounters(sessionId: string, state: SessionState): Promise<void> {
  const hasCounter = (state.verifyGateConsecutiveBlocks ?? 0) !== 0;
  const hasBlockHash = state.verifyGateBlockHash !== undefined && state.verifyGateBlockHash !== null;
  const hasCycleCounter = (state.verifyGateCycleBlocks ?? 0) !== 0;
  if (hasCounter || hasBlockHash || hasCycleCounter) {
    state.verifyGateConsecutiveBlocks = 0;
    state.verifyGateBlockHash = null;
    state.verifyGateCycleBlocks = 0;
    await updateSessionState(sessionId, (fresh) => {
      fresh.verifyGateConsecutiveBlocks = 0;
      fresh.verifyGateBlockHash = null;
      fresh.verifyGateCycleBlocks = 0;
    });
  }
}

// Set as soon as the hook input is parsed, so the crash handler at the bottom of this file can
// still attribute its fail-open log line to a session even though the exception it's handling
// happened well past main()'s own scope.
let sessionIdForCrashLog: string | null = null;

async function logFailOpen(sessionId: string | null, reason: "loop-guard" | "loop-guard-cycle" | "error" | "timeout", detail: string): Promise<void> {
  await appendJsonl(logFileForDate(), {
    at: new Date().toISOString(),
    sessionId,
    event: "verifyGateFailOpen",
    reason,
    detail,
  });
}

// The gate has three non-enforcement exits: a fail-open (logged above since issue #1), and the two
// escape hatches below — neither of which left any trace on disk before this. `praxarch report`
// totals all three separately, so a gate that is being routinely bypassed doesn't read as a gate
// that is passing. Best-effort: a log failure here must never turn a clean allow into a crash-path
// allow with a misleading `reason: "error"` row. It is also the best-effort appender for the
// gate's block audit rows (issue #3) — a logging failure must never turn a block into a
// crash-path allow.
async function logEscapeHatch(
  sessionId: string,
  event: "verifyGateSkipped" | "verifyGateWaived" | "verifyGateBlocked" | "verifyGateWaiverUnneeded",
  fields: Record<string, unknown>,
): Promise<void> {
  try {
    await appendJsonl(logFileForDate(), {
      at: new Date().toISOString(),
      sessionId,
      event,
      ...fields,
    });
  } catch (err) {
    process.stderr.write(`praxarch verify-gate: could not append the ${event} audit row: ${String(err)}\n`);
  }
}

async function runGate(): Promise<void> {
  const input = await readHookInput<StopInput>();
  sessionIdForCrashLog = input.session_id;

  // Read (and clear) state before any early return, so every allow path — including the escape
  // hatches below — scopes the loop-guard counter to this stop cycle rather than leaking a stale
  // value into a later, unrelated cycle (issue #1, defect 1).
  const state = await readSessionState(input.session_id);
  // A new stop cycle always starts from zero, regardless of what this invocation ends up doing —
  // Claude Code guarantees stop_hook_active is false on the first round of any new stop attempt.
  if (!input.stop_hook_active) await clearBlockCounters(input.session_id, state);

  if (process.env["PRAXARCH_SKIP_VERIFY"] === "1") {
    await clearBlockCounters(input.session_id, state);
    await logEscapeHatch(input.session_id, "verifyGateSkipped", { reason: "PRAXARCH_SKIP_VERIFY" });
    emitOnce(allow());
    return;
  }

  // Resolved once, before any measurement in this function, and reused at every site below —
  // diffStat and the one fingerprint below, which the waiver and block paths share — see
  // measurement-cwd.ts's doc comment for why a dead anchor becomes `null` rather than a fallback
  // to `input.cwd`. `loadConfig` below deliberately keeps using `input.cwd`: which project's
  // config applies is a property of the hook invocation, not of which tree is being measured.
  const measurement = await resolveMeasurementContext(state.baselineCwd, input.cwd);
  const measurementCwd = measurement.cwd;

  // issue #3: matched here, acted on only once the gate knows whether this stop would pass on its
  // own. Checked first, a waiver was logged — and stored as a standing waiver — even on stops the
  // gate would have allowed anyway (in one wave, a waiver 8s after a CONFIRMED verdict on the same
  // diff hash). Those are now logged as verifyGateWaiverUnneeded and never set verifyGateWaivedHash.
  const waiverMatch = input.last_assistant_message ? WAIVER_PATTERN.exec(input.last_assistant_message) : null;
  // Model-produced text of unbounded length — bounded here so one waiver can't dominate the log
  // file. `?? ""` covers a pattern match with no captured group, which cannot happen with the
  // current WAIVER_PATTERN but must not throw if it ever changes.
  const waiverReason = (waiverMatch?.[1] ?? "").trim().slice(0, 500);
  const logUnneededWaiver = async (
    passedBy: "trivial" | "standing-waiver" | "verdict",
    diffHash: string | null,
  ): Promise<void> => {
    if (waiverMatch) {
      await logEscapeHatch(input.session_id, "verifyGateWaiverUnneeded", { reason: waiverReason, diffHash, passedBy });
    }
  };

  const { config, warnings } = await loadConfig(input.cwd);
  // The sidecar snapshot, not `state` — `SessionState` only carries `baselineUntrackedCaptured`,
  // a marker that a capture was attempted, not the captured content (see
  // untracked-baseline-store.ts for why the two are split). `readUntrackedBaseline` already fails
  // safe to `null` (count every untracked path) on a missing, unreadable, or corrupt sidecar file
  // — never throws, never resolves to `{}`.
  const untrackedBaseline = await readUntrackedBaseline(input.session_id);
  // A dead anchor never reaches diffStat at all — diffStat returns `{0, 0}` (allow) when its cwd
  // argument isn't a git repo, which is exactly the fail-open this anchor exists to prevent for a
  // deleted/moved checkout. `measurementCwd === null` short-circuits straight to `null` counts
  // instead.
  const currentCounts =
    measurementCwd === null
      ? null
      : await diffStat(measurementCwd, config.verifyGate.ignorePatterns, state.baselineHead, untrackedBaseline, {
          // Already proved by resolveMeasurementContext above — this probe used to run twice on
          // the same directory, once there and once inside diffStat.
          knownGitRepo: measurement.provenGitRepo,
        });

  // `null` means the diff couldn't be measured at all (see diffStat's doc comment, and the dead-
  // anchor short-circuit above). Reading that as trivial is exactly the bypass this fix exists to
  // close, so a failed measurement is treated as non-trivial unconditionally — it skips the early
  // allow below and falls through to the same verdict-demanding path as any other non-trivial
  // diff, with its own message variant at the bottom of this function. `current` still gets
  // zeroed counts so the delta math further down (which only runs once a verdict is already being
  // demanded) has real numbers to subtract against; measurementFailed is what actually drives
  // every branching decision.
  const measurementFailed = currentCounts === null;
  const current = currentCounts ?? { changedLines: 0, changedFiles: 0 };
  const { changedLines, changedFiles } = current;

  const isNonTrivial = measurementFailed || clearsThreshold(changedLines, changedFiles, config.verifyGate);
  if (!isNonTrivial) {
    await clearBlockCounters(input.session_id, state);
    emitOnce(allow(warnings));
    // issue #3: the fingerprint is not computed on this path, and must not be computed just to
    // log a waiver that turned out unneeded — a trivial diff never has one to report.
    await logUnneededWaiver("trivial", null);
    return;
  }

  // Only fetched past this point: the trivial-diff early return above is the common case, and it
  // never needs a fingerprint — diffFingerprint reads every dirty/untracked file's full current
  // contents, where diffStat's counts above are cheap by comparison. A dead anchor is already
  // `measurementFailed` via `currentCounts` above and must not fingerprint the wrong (hook) tree
  // here either.
  const currentHash = measurementCwd === null ? null : await diffFingerprint(measurementCwd);

  // A waiver stands until the work moves. Without this the gate re-blocks on every stop for the
  // rest of the session, because it measures the cumulative diff against baselineHead — so even a
  // turn that changed nothing still presents the same non-trivial diff and gets blocked again.
  // An unknown current hash never matches (diffFingerprint returns null, and the stored value is
  // never null), so an unhashable diff falls through to normal enforcement rather than riding a
  // stale waiver.
  if (currentHash !== null && state.verifyGateWaivedHash === currentHash) {
    await clearBlockCounters(input.session_id, state);
    emitOnce(allow(warnings));
    await logUnneededWaiver("standing-waiver", currentHash);
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
    // clause below, so this can't cause a spurious block on a shrinking diff. A positive file
    // delta with a negative line delta can't clear the floor either, so it does not count as
    // stale — the same shrinking-diff exemption, just via the file side this time.
    (currentHash === null || verifierHash !== currentHash) &&
    clearsThreshold(lineDelta, fileDelta, config.verifyGate);

  const passed = verifier !== null && verifier.verdict === "CONFIRMED" && verifier.criticalOrMajorCount === 0 && !stale;
  if (passed) {
    await clearBlockCounters(input.session_id, state);
    emitOnce(allow(warnings));
    await logUnneededWaiver("verdict", currentHash);
    return;
  }

  if (waiverMatch) {
    // Remember which diff was waived. The gate measures the session's whole diff against
    // baselineHead, so a waiver that only allowed this one stop would re-block on every later
    // stop — including turns that changed nothing, because the cumulative diff hasn't shrunk.
    // A null fingerprint is deliberately not stored: an unhashable diff would otherwise be
    // waived forever, since the "has it moved?" test above could never disprove it. A dead anchor
    // (measurementCwd === null) is treated identically to an unhashable diff — `currentHash` is
    // already null for it, never a fingerprint of the hook cwd.
    const waivedHash = currentHash;
    if (waivedHash !== null) state.verifyGateWaivedHash = waivedHash;
    state.verifyGateConsecutiveBlocks = 0;
    state.verifyGateBlockHash = null;
    state.verifyGateCycleBlocks = 0;
    // Written unconditionally rather than via clearBlockCounters, which skips the write when no
    // counter was set — that would drop the waiver on a first-round stop, the common case. Only
    // the fields this gate owns are touched, so a concurrent SubagentStop's `lastVerifier` survives.
    await updateSessionState(input.session_id, (fresh) => {
      if (waivedHash !== null) fresh.verifyGateWaivedHash = waivedHash;
      fresh.verifyGateConsecutiveBlocks = 0;
      fresh.verifyGateBlockHash = null;
      fresh.verifyGateCycleBlocks = 0;
    });
    // Emitted before the best-effort append below, same rule as the block path further down
    // (issue #3 amendment): a slow or stalled log write must never hold up the decision the
    // harness is waiting on, and must never give the watchdog a window where it looks like no
    // decision has been reached yet. `updateSessionState` above stays ahead of the emit — unlike
    // the log append, it is not best-effort: the stored waived hash and reset counters are load-
    // bearing for later stops (see the waiver-stickiness tests), not just an audit trail.
    emitOnce(allow());
    await logEscapeHatch(input.session_id, "verifyGateWaived", {
      reason: waiverReason,
      diffHash: waivedHash,
    });
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
      emitOnce(
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
      emitOnce(
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
  await updateSessionState(input.session_id, (fresh) => {
    fresh.verifyGateConsecutiveBlocks = priorBlocks + 1;
    fresh.verifyGateBlockHash = currentHash;
    fresh.verifyGateCycleBlocks = priorCycleBlocks + 1;
  });

  // The line delta alone, or the file delta with enough line growth behind it, clears `stale`
  // (see the clause above) — the other can independently be negative (e.g. files reverted while an
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

  // Same precedence as `reasonDetail` above: a REFUTED verdict that is also stale reads as stale.
  // "refuted" covers both non-passing verdict shapes — REFUTED, and CONFIRMED with critical/major
  // findings — so it does not mean the verdict field literally said REFUTED.
  const trigger = verifier === null ? "no-verdict" : stale ? "stale" : "refuted";

  // Only surfaced on a block, not on every allow — issue #14 Part B wants the running ref
  // discoverable, not printed on every hook invocation. Names the branch/ref this gate was built
  // from (e.g. "feat/x@a1b2c3d4e5f6"), so a block on branch code reads as branch code rather than
  // silently looking like a merged-code enforcement decision.
  const buildRef = formatBuildRef(await readBuildInfo());
  const buildRefSuffix = buildRef ? ` [praxarch built from ${buildRef}]` : "";

  // A failed measurement has no real changedLines/changedFiles to report — the size-phrased
  // message above would print zeros and read as "trivial but blocked," which is backwards. This
  // variant states the actual reason (diff could not be measured) instead, and — when the anchor
  // itself is the reason — names the recorded path rather than the generic "git diff failed"
  // phrasing. `measurementCwd === null` while `baselineCwd` is set covers two distinct causes
  // (measurement-cwd.ts's doc comment): the anchor directory is genuinely gone (deleted worktree,
  // moved checkout), or it still exists but isn't a git repo while the hook cwd IS one (the
  // laundering case — work happened in a repo the anchor never named). The message is worded to
  // cover both without asserting the directory is missing when it might merely be unusable.
  const anchorDead = measurementCwd === null;
  const measurementFailedReason = anchorDead
    ? `praxarch verify-gate: the session's baseline directory (${state.baselineCwd ?? "unknown"}) is missing ` +
      'or unusable for measurement — treating the diff as unmeasurable and non-trivial. Run a verifier pass ' +
      "before reporting completion, or start a line of your final message with PRAXARCH_VERIFY_WAIVED: " +
      "<reason> if verification genuinely doesn't apply here."
    : "praxarch verify-gate: the session's diff could not be measured (git diff failed) — treating as " +
      "non-trivial. Run a verifier pass before reporting completion, or start a line of your final message " +
      "with PRAXARCH_VERIFY_WAIVED: <reason> if verification genuinely doesn't apply here.";
  const output: StopOutput = withConfigWarnings(
    {
      decision: "block",
      reason: (measurementFailed
        ? measurementFailedReason
        : `praxarch verify-gate: this session changed ${changedLines} lines across ${changedFiles} files ` +
          `(non-trivial) but ${reasonDetail}. Run a verifier pass before reporting completion, or start a ` +
          `line of your final message with PRAXARCH_VERIFY_WAIVED: <reason> if verification genuinely ` +
          `doesn't apply here.`) + buildRefSuffix,
      hookSpecificOutput: {
        hookEventName: "Stop",
        additionalContext:
          "Delegate to the verifier role for a fresh-context review of the changes, then re-check " +
          "completion. If this diff is something like docs/config that doesn't warrant verification, " +
          "put PRAXARCH_VERIFY_WAIVED: <reason> at the start of a line in your final message instead of " +
          "just stopping — a waiver quoted mid-sentence does not count. If the verdict " +
          "came from a resumed agent (e.g. via SendMessage), no hook observes that reply — run " +
          `\`praxarch record-verdict --session ${input.session_id} --role <role>\` with the agent's output instead of ` +
          "waiving.",
      },
    },
    warnings,
  );
  // Emit the decision before the best-effort append below, matching fireWatchdog's own rule
  // ("emit before awaiting anything" — see its comment). A slow or stalled log write must never
  // hold up the decision the harness is waiting on, and must never give the watchdog a window
  // where it looks like no decision has been reached yet (it would then fire its own fail-open
  // allow — first writer wins on stdout, so that allow would beat this block to the harness).
  emitOnce(output);
  // issue #3: blocks used to be visible only through the waivers they provoked. One row per block
  // that reaches the model — never on the loop-guard paths above, which log verifyGateFailOpen
  // instead. Counts are null when the diff couldn't be measured, rather than the zeros `current`
  // carries for the delta math.
  await logEscapeHatch(input.session_id, "verifyGateBlocked", {
    trigger,
    changedLines: measurementFailed ? null : changedLines,
    changedFiles: measurementFailed ? null : changedFiles,
    diffHash: currentHash,
  });
}

async function fireWatchdog(budgetMs: number): Promise<void> {
  // issue #3: a decision already reached the harness (emitOnce is a first-writer-wins guard), most
  // likely because runGate is now awaiting its own best-effort verifyGateBlocked append. Firing
  // here would be a no-op on stdout, but it would still write a false "timeout" row alongside the
  // real decision's own audit row, and its process.exit(0) would cut that still-pending append off
  // mid-write. Bail out and let runGate finish on its own.
  //
  // A stuck-`open()` hang used to make even that plain exit unreachable (Node's exit teardown
  // joins the libuv threadpool, and a worker blocked in `open()` on a writerless FIFO never
  // returns from that join). appendJsonl now opens O_NONBLOCK (jsonl.ts), so that open() fails
  // immediately with ENXIO instead of blocking, closing the FIFO case and making this return
  // reachable again.
  //
  // Residual gap, accepted, not fixed here: O_NONBLOCK only protects the open() against a
  // writerless FIFO. If the logs directory itself sits on a mount where open() or write() blocks
  // in the kernel — with no FIFO involved — the block decision still reaches stdout (emitOnce ran
  // above), but this function returns without exiting, runGate's own append hangs, and the
  // process never exits; the harness eventually kills it and what happens to a killed hook's
  // already-written stdout is unverified. A stall of the whole PRAXARCH_HOME mount already hangs
  // the earlier `updateSessionState` call on this same request path, which predates this work; the
  // new exposure here is narrower — a logs directory stalling on its own, independent of the rest
  // of the mount. Tracked as a follow-up issue rather than fixed here.
  //
  // Self-SIGKILL (as this function used to do on this branch) was considered and rejected: it
  // would force the process down deterministically, but the harness's handling of a signal-killed
  // hook's already-flushed stdout is unverified, and trading a known-uncertain hang for an
  // equally-unverified kill path isn't a fix.
  if (hookOutputEmitted) return;
  // Emit before awaiting anything: stdout is what the harness reads, and the log row is
  // best-effort on top of it.
  emitOnce({
    systemMessage:
      `praxarch verify-gate: hit its ${Math.round(budgetMs)}ms self-watchdog budget before reaching a ` +
      "decision — failing open rather than being killed silently at the harness hook timeout.",
  });
  try {
    await logFailOpen(
      sessionIdForCrashLog,
      "timeout",
      `watchdog fired after ${Math.round(budgetMs)}ms without a decision`,
    );
  } catch {
    // Best-effort — a logging failure must not stop the process exiting cleanly.
  }
  process.exit(0);
}

async function main(): Promise<void> {
  const budgetMs = effectiveTimeoutMs() * WATCHDOG_FRACTION;
  const watchdog = setTimeout(() => {
    void fireWatchdog(budgetMs);
  }, budgetMs);
  try {
    await runGate();
  } finally {
    // Must be cleared, not unref'd: an unref'd timer never fires, and a live timer keeps the
    // process alive until the budget elapses even after a decision was emitted.
    clearTimeout(watchdog);
  }
}

main().catch(async (err: unknown) => {
  // A verify-gate crash must never trap the session in an unstoppable loop — fail open. Nothing
  // in this handler may throw: stderr isn't shown to the user, so the systemMessage is what
  // actually surfaces this, and the log line is best-effort on top of that.
  //
  // Deliberately keeps event:"verifyGateFailOpen" here rather than adopting route-guard's separate
  // "guard-crash" event name (route-guard.ts:212) — renaming would break the existing event schema
  // and report's fail-open counter, and issue #24's guardrail forbids schema changes to existing
  // rows. So the two hooks now use different event names for the same "hook crashed and failed
  // open" shape: "guard-crash" is route-guard-only, "verifyGateFailOpen" (reason:"error" on this
  // path) is verify-gate's crash case specifically (loop-guard/loop-guard-cycle/timeout are its other,
  // non-crash reasons — see logFailOpen above). An auditor wanting verify-gate's crash-only rows
  // should query `event=="verifyGateFailOpen" && reason=="error"`; route-guard's crashes are a
  // separate `event=="guard-crash"` query. See docs/design.md's JSONL schema section for both.
  const detail = String(err);
  process.stderr.write(`praxarch verify-gate error (failing open): ${detail}\n`);
  try {
    await logFailOpen(sessionIdForCrashLog, "error", detail);
  } catch {
    // Best-effort — a logging failure must not compound the original crash.
  }
  emitOnce({
    systemMessage: `praxarch verify-gate: crashed and is failing open rather than blocking the session (${detail}).`,
  });
});
