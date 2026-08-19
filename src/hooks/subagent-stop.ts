#!/usr/bin/env node
import { loadConfig } from "./lib/config.js";
import { readHookInput, type SubagentStopInput } from "./lib/hook-io.js";
import { readSessionState, updateSessionState, type VerifierRecord } from "./lib/session-state.js";
import {
  captureDiffCounts,
  captureDiffHash,
  extractTrailingJson,
  MalformedVerdictError,
  summarizeVerdict,
} from "./lib/verdict.js";

/**
 * SubagentStop — fires on real subagent completion (background subagents included), unlike
 * PostToolUse(Agent), which since 2026-08-13's move to async dispatch only ever sees the launch
 * receipt (issue #15). This hook is what restores automatic verdict recording; PostToolUse(Agent)
 * still owns the unconditional dispatch-time JSONL row (see telemetry.ts) and that write is
 * untouched by anything here.
 *
 * Findings this depends on (task 1, `.claude/plans/2026-08-19-subagent-stop-verdicts.md`,
 * observed live on this installed harness version, 2026-08-19):
 *  - `last_assistant_message` carries the subagent's complete final text, unwrapped and
 *    untruncated — the trailing verdict block survives.
 *  - `session_id` is the PARENT session id, matching what session state keys on.
 *  - `agent_id` correlates to the `agentId` field observed on the dispatch-time
 *    `tool_response` (see hook-io.ts's `agentId` comment for how that was established — this
 *    repo's own transcript, not the harness docs, since the docs don't commit to a structured
 *    dispatch-time id at all).
 *  - `agent_type` can be an empty string, and the key set on the payload is not fixed across
 *    firings (e.g. `effort` was present on only one of three observed captures). Nothing here may
 *    assume a key exists, and an empty `agent_type` must never be treated as a wildcard.
 *
 * KNOWN GAP, shipped deliberately: whether SubagentStop fires for a subagent that errors or is
 * cancelled mid-run is unverified — not reproducible on demand without forcing a harness-side
 * failure. `praxarch record-verdict` remains the manual fallback for any completion this hook
 * doesn't see.
 *
 * Never blocks. SubagentStop supports exit code 2 to prevent a subagent from stopping; this hook
 * never uses it and never throws out of `main()` — a verdict recorder that can wedge a subagent is
 * a worse defect than the one it fixes. A malformed verdict block degrades to "record nothing"
 * (matching telemetry.ts's convention), never a thrown error and never a corrupted delegation row.
 */

async function main(): Promise<void> {
  const input = await readHookInput<SubagentStopInput>();

  // Regression pin for issue #15 itself: this hook must only ever act on a genuine SubagentStop
  // completion payload, never on a PostToolUse(Agent) dispatch-time launch receipt (which has no
  // `agent_type` / `last_assistant_message` fields in the shape this hook expects, but *does*
  // share `session_id`/`cwd` with every other hook envelope, so a wiring mistake — e.g. this
  // module registered under the wrong event — must not silently start "recording" launch
  // receipts as verdicts). See telemetry.test.ts and subagent-stop.test.ts for the shared fixture
  // this guards against.
  if (input.hook_event_name !== "SubagentStop") return;

  const agentType = input.agent_type ?? "";
  const { config, warnings } = await loadConfig(input.cwd);
  if (warnings.length > 0) {
    process.stderr.write(`praxarch subagent-stop: ${warnings.join(" ")}\n`);
  }

  // Gate on verdictRoles exactly as telemetry.ts does. An empty `agent_type` (observed live —
  // see task 1) matches nothing here by construction; it is never treated as a wildcard.
  if (!config.verifyGate.verdictRoles.includes(agentType)) return;

  const text = input.last_assistant_message ?? "";
  if (!text) return;

  const parsed = extractTrailingJson(text);
  if (!parsed) return;

  let summary: ReturnType<typeof summarizeVerdict>;
  try {
    summary = summarizeVerdict(parsed);
  } catch (err) {
    // Degrade to "record nothing" — matches telemetry.ts's convention for a malformed verdict
    // block. There is no delegation row for this hook to protect (that row was already written,
    // unconditionally, at dispatch by telemetry.ts), so there's nothing left to preserve here
    // beyond simply not crashing.
    if (err instanceof MalformedVerdictError) return;
    throw err;
  }

  const at = new Date().toISOString();
  const agentId = typeof input.agent_id === "string" && input.agent_id ? input.agent_id : null;

  // Same ordering contract as telemetry.ts: fingerprint before the state read, counts after (the
  // read is only for `baselineHead`, which `captureDiffCounts` needs).
  const diffHash = await captureDiffHash(input.cwd);
  const state = await readSessionState(input.session_id);
  const { changedLines, changedFiles } = await captureDiffCounts(
    input.cwd,
    config.verifyGate.ignorePatterns,
    state.baselineHead,
  );

  const verifierRecord: VerifierRecord = {
    ...summary,
    recordedAt: at,
    diffHash,
    changedLines,
    changedFiles,
  };

  // Merge-write, re-reading the freshest snapshot immediately before mutating — same contract as
  // telemetry.ts's write. Two things happen here:
  //  1. `lastVerifier` is set — this is the field verify-gate actually reads.
  //  2. The matching `delegations[]` entry (by `agentId`) is updated IN PLACE with the same
  //     verdict fields, per the plan's decision: no second row, the dispatch-time delegation
  //     record stays the single record of this delegation. If no entry matches (missing
  //     `agent_id` on either side, or the dispatch row predates this field), `lastVerifier` still
  //     gets set — that's what the gate needs — but no delegation row is touched; a verdict must
  //     never be attributed to the wrong delegation by guessing.
  //  The JSONL delegation log is deliberately NOT touched here — it stays append-only, written
  //  once at dispatch by telemetry.ts. Rewriting a line inside it is a different and riskier
  //  operation than this merge-write, and the plan opted for correctness in session state over
  //  updating the log (see task 3).
  await updateSessionState(input.session_id, (fresh) => {
    fresh.lastVerifier = verifierRecord;
    if (agentId) {
      const match = fresh.delegations.find((d) => d.agentId === agentId);
      if (match) {
        match.verdict = summary.verdict;
        match.findingsCount = summary.findingsCount;
        match.criticalOrMajorCount = summary.criticalOrMajorCount;
      }
    }
  });
}

main().catch((err: unknown) => {
  // Must never block a subagent from stopping — log to stderr (not shown to the user, but
  // best-effort for debugging) and exit clean regardless of what failed above.
  process.stderr.write(`praxarch subagent-stop error (non-blocking): ${String(err)}\n`);
});
