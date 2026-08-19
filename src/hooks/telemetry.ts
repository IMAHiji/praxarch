#!/usr/bin/env node
import { loadConfig } from "./lib/config.js";
import { appendJsonl } from "./lib/jsonl.js";
import { logFileForDate } from "./lib/paths.js";
import { readSessionState, updateSessionState, type VerifierRecord } from "./lib/session-state.js";
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
 * roles (config verifyGate.verdictRoles, default ["verifier", "plan-reviewer"]), parses the
 * required trailing JSON verdict block into session state so verify-gate can check it later.
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
  const text = responseText(input.tool_response);
  if (role !== undefined && config.verifyGate.verdictRoles.includes(role) && text) {
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

  // Fingerprint the tree this verdict was recorded against, so verify-gate can later tell
  // whether it's still current. Only computed here (a verdict was actually parsed) — the far
  // more common PostToolUse(Agent) call, for a non-verdict role, never needs it. Hoisted above
  // the state read: unlike diffStat, diffFingerprint doesn't consume any field of session state,
  // so nothing stops it running before the read — shrinking (not eliminating; diffStat still
  // needs `baselineHead` from the read) the window in which a concurrent writer's change could
  // land before this hook's own merge-write below picks it up.
  // A failure here degrades to null inside captureDiffHash — verify-gate treats a present-but-null
  // diffHash as unverifiable (no free pass), unlike a record that omits the key entirely
  // (genuinely predates this feature).
  const diffHash: string | null = parsedVerdict ? await captureDiffHash(input.cwd) : null;

  // Read only for `baselineHead`, which diffStat needs below — never mutated and never written
  // back directly. The eventual write goes through `updateSessionState`, which re-reads the
  // freshest snapshot immediately before applying telemetry's owned mutations, so this read being
  // stale by the time we get to the bottom of this function is fine: it's not what gets persisted.
  const state = await readSessionState(input.session_id);

  let verifierRecord: VerifierRecord | null = null;
  if (parsedVerdict) {
    const { changedLines, changedFiles } = await captureDiffCounts(
      input.cwd,
      config.verifyGate.ignorePatterns,
      state.baselineHead,
    );
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
    });
    if (verifierRecord) fresh.lastVerifier = verifierRecord;
  });
}

main().catch((err: unknown) => {
  // Telemetry must never block the session on failure — log to stderr and exit clean.
  process.stderr.write(`praxarch telemetry error (non-blocking): ${String(err)}\n`);
});
