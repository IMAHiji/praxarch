#!/usr/bin/env node
import { appendJsonl } from "./lib/jsonl.js";
import { logFileForDate } from "./lib/paths.js";
import { readSessionState, writeSessionState, type VerifierRecord } from "./lib/session-state.js";
import { readHookInput, type PostToolUseInput } from "./lib/hook-io.js";

/**
 * PostToolUse(Agent) — appends a delegation record to the monthly JSONL log and, for verifier
 * calls, parses the required trailing JSON verdict block into session state so verify-gate can
 * check it later.
 *
 * Known gap: PostToolUse does not expose token usage or duration for the subagent run (confirmed
 * against the hooks docs), so records are role/model/outcome only. If Claude Code exposes usage
 * data here in the future, extend DelegationRecord rather than working around its absence.
 */

const FANOUT_TAG = /^\[fanout:([a-zA-Z0-9_-]+)\]/;

interface VerifierVerdictJson {
  verdict: "CONFIRMED" | "REFUTED";
  findings?: { severity: "critical" | "major" | "minor" }[];
}

function extractTrailingJson(text: string): VerifierVerdictJson | null {
  const fenceMatches = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  const last = fenceMatches.at(-1);
  if (!last?.[1]) return null;
  try {
    const parsed = JSON.parse(last[1]) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "verdict" in parsed &&
      (parsed as { verdict: unknown }).verdict !== undefined
    ) {
      return parsed as VerifierVerdictJson;
    }
  } catch {
    return null;
  }
  return null;
}

async function main(): Promise<void> {
  const input = await readHookInput<PostToolUseInput>();
  if (input.tool_name !== "Agent") return;

  const { subagent_type: role, model, description = "" } = input.tool_input;
  const at = new Date().toISOString();
  const batchMatch = FANOUT_TAG.exec(description);

  await appendJsonl(logFileForDate(), {
    at,
    sessionId: input.session_id,
    role: role ?? "unset",
    model: model ?? "inherited",
    batchId: batchMatch?.[1] ?? null,
  });

  const state = await readSessionState(input.session_id);
  state.delegations.push({ role: role ?? "unset", model: model ?? "inherited", at });

  if (role === "verifier" && input.tool_output?.text) {
    const parsed = extractTrailingJson(input.tool_output.text);
    if (parsed) {
      const criticalOrMajor = (parsed.findings ?? []).filter(
        (f) => f.severity === "critical" || f.severity === "major",
      ).length;
      const record: VerifierRecord = {
        verdict: parsed.verdict,
        findingsCount: parsed.findings?.length ?? 0,
        criticalOrMajorCount: criticalOrMajor,
        recordedAt: at,
      };
      state.lastVerifier = record;
    }
  }

  await writeSessionState(state);
}

main().catch((err: unknown) => {
  // Telemetry must never block the session on failure — log to stderr and exit clean.
  process.stderr.write(`praxarch telemetry error (non-blocking): ${String(err)}\n`);
});
