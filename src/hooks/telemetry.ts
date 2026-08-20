#!/usr/bin/env node
import { loadConfig } from "./lib/config.js";
import { appendJsonl } from "./lib/jsonl.js";
import { resolveMeasurementCwd } from "./lib/measurement-cwd.js";
import { logFileForDate } from "./lib/paths.js";
import { readSessionState, updateSessionState, type VerifierRecord } from "./lib/session-state.js";
import { readUntrackedBaseline } from "./lib/untracked-baseline-store.js";
import { readHookInput, type PostToolUseInput } from "./lib/hook-io.js";
import {
  captureDiffCounts,
  captureDiffHash,
  extractTrailingJson,
  MalformedVerdictError,
  summarizeVerdict,
} from "./lib/verdict.js";

/**
 * PostToolUse(Agent) — appends a delegation record to the monthly JSONL log and, for verdict
 * roles (config verifyGate.verdictRoles, default ["verifier", "checker", "plan-reviewer"]), parses
 * the required trailing JSON verdict block into session state so verify-gate can check it later.
 *
 * tool_response carries the subagent's resolved model, token usage, and duration (verified
 * against a live capture — see fixtures/post-tool-use.agent.json), so each record includes real
 * cost data alongside role/model/outcome.
 */

const FANOUT_TAG = /^\[fanout:([a-zA-Z0-9_-]+)\]/;

function responseText(response: PostToolUseInput["tool_response"]): string {
  return (response?.content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

async function main(): Promise<void> {
  const input = await readHookInput<PostToolUseInput>();
  if (input.tool_name !== "Agent") return;

  const { subagent_type: role, model, description = "" } = input.tool_input;
  const at = new Date().toISOString();
  const batchMatch = FANOUT_TAG.exec(description);

  const { config, warnings } = await loadConfig(input.cwd);
  if (warnings.length > 0) {
    process.stderr.write(`praxarch telemetry: ${warnings.join(" ")}\n`);
  }

  // Parse the verdict (if any) and log the delegation row *before* touching session state — a
  // corrupt state file (readSessionState throws on anything but ENOENT) must not cost the JSONL
  // log its only record of this delegation having happened at all.
  let parsedVerdict: { verdict: "CONFIRMED" | "REFUTED"; findingsCount: number; criticalOrMajorCount: number } | null =
    null;
  // Issue #15: an async dispatch's `tool_response` here is the dispatch-time launch receipt, not
  // the subagent's report — it carries no report text at all, only launch metadata (agentId,
  // resolvedModel, etc). Detect it positively and skip the parse rather than relying on it simply
  // failing to find a trailing JSON block; the real verdict, if any, is recorded later by
  // SubagentStop. Left as-is, any report-shaped text the receipt happens to carry (e.g. an echoed
  // prompt) would otherwise be parsed as if it were a genuine verdict.
  const isLaunchReceipt =
    input.tool_response?.status === "async_launched" || input.tool_response?.isAsync === true;
  const text = responseText(input.tool_response);
  if (!isLaunchReceipt && role !== undefined && config.verifyGate.verdictRoles.includes(role) && text) {
    const parsed = extractTrailingJson(text);
    if (parsed) {
      try {
        parsedVerdict = summarizeVerdict(parsed);
      } catch (err) {
        // Telemetry is a non-blocking observer (unlike record-verdict.ts, which must refuse
        // outright): a malformed verdict value must not unwind out of main() and cost the JSONL
        // log its only record of this delegation — treat it exactly like an unparseable block
        // (parsedVerdict stays null) and let the row/state write below proceed.
        if (!(err instanceof MalformedVerdictError)) throw err;
      }
    }
  }

  const resolvedModel = input.tool_response?.resolvedModel ?? null;
  const totalTokens = input.tool_response?.totalTokens ?? null;
  const durationMs = input.tool_response?.totalDurationMs ?? null;
  const agentId = typeof input.tool_response?.agentId === "string" ? input.tool_response.agentId : null;

  await appendJsonl(logFileForDate(), {
    at,
    sessionId: input.session_id,
    role: role ?? "unset",
    model: model ?? "inherited",
    resolvedModel,
    totalTokens,
    durationMs,
    batchId: batchMatch?.[1] ?? null,
    verdict: parsedVerdict?.verdict ?? null,
    criticalOrMajorCount: parsedVerdict?.criticalOrMajorCount ?? null,
  });

  // Read only for `baselineHead`/`baselineCwd`, which the measurements below need — never mutated
  // and never written back directly. The eventual write goes through `updateSessionState`, which
  // re-reads the freshest snapshot immediately before applying telemetry's owned mutations, so this
  // read being stale by the time we get to the bottom of this function is fine: it's not what gets
  // persisted. Moved ahead of the diffHash capture below (unlike before this anchor existed) because
  // resolving the measurement cwd needs `state.baselineCwd` — the JSONL log write above still stays
  // first, unaffected by this reordering, so a corrupt state file still can't cost that row.
  const state = await readSessionState(input.session_id);

  let verifierRecord: VerifierRecord | null = null;
  if (parsedVerdict) {
    // Resolved once and reused by both the fingerprint and the counts below — see
    // measurement-cwd.ts's doc comment for why a dead (or laundering) anchor becomes `null`
    // rather than falling back to `input.cwd`. Gated behind `parsedVerdict`, not run
    // unconditionally on every PostToolUse(Agent) call: it's an `access()` syscall (plus, for a
    // non-repo anchor, up to two more `git rev-parse` calls), and the far more common non-verdict
    // call never consumes its result at all.
    const measurementCwd = await resolveMeasurementCwd(state.baselineCwd, input.cwd);

    // Fingerprint the tree this verdict was recorded against, so verify-gate can later tell
    // whether it's still current.
    // A failure here degrades to null inside captureDiffHash — verify-gate treats a present-but-null
    // diffHash as unverifiable (no free pass), unlike a record that omits the key entirely
    // (genuinely predates this feature). A dead anchor (measurementCwd === null) degrades the same
    // way, never fingerprinting the wrong (hook) tree.
    const diffHash: string | null = measurementCwd !== null ? await captureDiffHash(measurementCwd) : null;

    // This read is gated behind `parsedVerdict`, not hoisted to every PostToolUse(Agent) call —
    // the whole point of moving the untracked snapshot into its own sidecar file was to keep
    // per-tool-call work flat (see untracked-baseline-store.ts and paths.ts's
    // `untrackedBaselinePath` comment: a 2000-entry snapshot took SessionStart from ~10ms to
    // ~3.5s when it lived inside the state file telemetry.ts rewrites on every call). A
    // verdict-bearing PostToolUse(Agent) call is rare relative to the hot path, so reading the
    // sidecar here does not reintroduce that cost.
    const untrackedBaseline = await readUntrackedBaseline(input.session_id);
    // A dead anchor never reaches diffStat — same fail-closed reasoning as verify-gate.ts (diffStat
    // returns `{0, 0}` for a non-repo cwd, which must not be handed back as "nothing changed").
    const { changedLines, changedFiles } =
      measurementCwd === null
        ? { changedLines: null, changedFiles: null }
        : await captureDiffCounts(measurementCwd, config.verifyGate.ignorePatterns, state.baselineHead, untrackedBaseline);
    // Invariant verify-gate relies on: diffHash must be a real `string | null` here, never
    // `undefined` — it distinguishes a legacy record (key absent) from a failed fingerprint
    // (key present, null) only because JSON.stringify drops undefined-valued keys but keeps
    // null ones. `diffHash` above is always assigned string|null, so this holds.
    verifierRecord = {
      ...parsedVerdict,
      recordedAt: at,
      diffHash,
      changedLines,
      changedFiles,
    };
  }

  // Merge-write: re-reads the freshest state immediately before writing and touches only the
  // fields telemetry owns (`delegations`, `lastVerifier`) — see updateSessionState's doc comment.
  // A concurrent verify-gate write landing anywhere before this call (including during the
  // diffStat/diffFingerprint work above) is preserved, instead of being clobbered by a stale
  // whole-object write built from the read at the top of this function.
  await updateSessionState(input.session_id, (fresh) => {
    fresh.delegations.push({
      role: role ?? "unset",
      model: model ?? "inherited",
      resolvedModel,
      totalTokens,
      durationMs,
      at,
      agentId,
    });
    if (verifierRecord) fresh.lastVerifier = verifierRecord;
  });
}

main().catch((err: unknown) => {
  // Telemetry must never block the session on failure — log to stderr and exit clean.
  process.stderr.write(`praxarch telemetry error (non-blocking): ${String(err)}\n`);
});
