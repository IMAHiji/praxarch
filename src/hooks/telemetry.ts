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
 * tool_response carries the subagent's resolved model, token usage, and duration (verified
 * against a live capture — see fixtures/post-tool-use.agent.json), so each record includes real
 * cost data alongside role/model/outcome.
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

  let verifierRecord: VerifierRecord | null = null;
  const text = responseText(input.tool_response);
  if (role === "verifier" && text) {
    const parsed = extractTrailingJson(text);
    if (parsed) {
      const criticalOrMajor = (parsed.findings ?? []).filter(
        (f) => f.severity === "critical" || f.severity === "major",
      ).length;
      verifierRecord = {
        verdict: parsed.verdict,
        findingsCount: parsed.findings?.length ?? 0,
        criticalOrMajorCount: criticalOrMajor,
        recordedAt: at,
      };
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
    verdict: verifierRecord?.verdict ?? null,
    criticalOrMajorCount: verifierRecord?.criticalOrMajorCount ?? null,
  });

  const state = await readSessionState(input.session_id);
  state.delegations.push({
    role: role ?? "unset",
    model: model ?? "inherited",
    resolvedModel,
    totalTokens,
    durationMs,
    at,
  });
  if (verifierRecord) state.lastVerifier = verifierRecord;

  await writeSessionState(state);
}

main().catch((err: unknown) => {
  // Telemetry must never block the session on failure — log to stderr and exit clean.
  process.stderr.write(`praxarch telemetry error (non-blocking): ${String(err)}\n`);
});
