import { diffFingerprint, diffStat } from "./git-diff.js";

/**
 * Shared verdict-parsing and fingerprint-capture pipeline, used by both telemetry.ts (PostToolUse
 * on a resumed-capable Agent call) and the `praxarch record-verdict` CLI (the explicit path for
 * verdicts that arrive outside a hookable event, e.g. a resumed agent's SendMessage reply).
 *
 * Moved out of telemetry.ts verbatim — see telemetry.ts (and subagent-stop.ts, which shares the
 * same contract) for the ordering this must not disturb: the JSONL delegation log, where it
 * exists, is written before session state is ever touched; the state read comes first among the
 * measurement steps themselves, because `resolveMeasurementCwd` (issue #23) needs
 * `state.baselineCwd` before either `captureDiffHash` or `captureDiffCounts` can run against the
 * right tree — both now happen after the state read, not before it. Callers own their own call
 * order; this module only owns what each individual step does.
 */

export interface VerifierVerdictJson {
  verdict: "CONFIRMED" | "REFUTED";
  // `severity` is typed as an open string, not the `"critical" | "major" | "minor"` union it used
  // to carry: this value comes straight out of JSON.parse on agent-produced text, so the union was
  // a claim about untrusted input rather than a guarantee. `summarizeVerdict` below is what
  // actually classifies it, fail-closed.
  findings?: { severity?: string }[];
}

export interface ParsedVerdict {
  verdict: "CONFIRMED" | "REFUTED";
  findingsCount: number;
  criticalOrMajorCount: number;
}

/**
 * Parses the trailing ```json ... ``` fenced block in `text` as a verifier verdict. Deliberately
 * strict: requires a well-formed fence, valid JSON, and a `verdict` key present (not just
 * non-empty text that merely mentions CONFIRMED/REFUTED) — this is the boundary between
 * attacker-influenceable agent output and something recorded as an enforcement-relevant verdict,
 * so a malformed or partial match must fail closed (`null`), never guess.
 *
 * Anchors on the property that the real verdict block TERMINATES the output: the closing fence
 * must be the last ``` in `text` (only trailing whitespace after it — this must stay in sync with
 * how the fixtures below and in telemetry.test.ts / record-verdict.test.ts place the fence, always
 * as the literal end of the text). A finding that quotes a fenced json example inside a string
 * value embeds its own literal "```json" / "```" characters *inside* that final block, which does
 * not disturb this boundary — JSON.parse recovers the full structure once we stop giving up at the
 * first embedded backtick. To find the matching opener, candidate ```json openers before that
 * final close are tried from last (closest to the close) to first: an opener inside an embedded
 * example pairs with the real close only by including trailing JSON string/object content after
 * it, which is never valid top-level JSON on its own and so fails to parse — leaving the real,
 * outer opener (or, when a separate unrelated example precedes a separate real trailing block, the
 * real block's own opener) as the only candidate that parses into an object with a `verdict` key.
 * If no candidate parses, returns null — an illustrative example with no real trailing block, or a
 * fence not at the end of the output, is never recordable as a verdict.
 */
export function extractTrailingJson(text: string): VerifierVerdictJson | null {
  const trimmed = text.replace(/\s+$/, "");
  if (!trimmed.endsWith("```")) return null;
  const closeIndex = trimmed.length - 3;

  const openerRe = /```json\s*/g;
  const openers: number[] = [];
  for (const m of trimmed.matchAll(openerRe)) {
    if (m.index < closeIndex) openers.push(m.index);
  }

  for (let i = openers.length - 1; i >= 0; i--) {
    const openerIndex = openers[i];
    if (openerIndex === undefined) continue;
    const openMatch = /```json\s*/.exec(trimmed.slice(openerIndex));
    if (!openMatch) continue;
    const contentStart = openerIndex + openMatch[0].length;
    if (contentStart > closeIndex) continue;
    const candidate = trimmed.slice(contentStart, closeIndex);
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "verdict" in parsed &&
        (parsed as { verdict: unknown }).verdict !== undefined
      ) {
        return parsed as VerifierVerdictJson;
      }
    } catch {
      // Not this opener's pairing — try the next candidate further back.
    }
  }
  return null;
}

/** Thrown by `summarizeVerdict` when `findings` is present but not a well-formed array of objects. */
export class MalformedVerdictError extends Error {}

/**
 * Reduces a parsed verdict block to the counts session state and verify-gate actually consume.
 * `verdict` itself is constrained here to exactly `"CONFIRMED"` or `"REFUTED"` — the JSON parse in
 * `extractTrailingJson` only requires a `verdict` key to be present, so an arbitrary string (or
 * `null`) would otherwise flow straight into session state and silently overwrite a previously
 * recorded good verdict. Anything else is malformed input, not a third valid state.
 * `findings`, if present, must be an array of objects (each expected to carry a `severity`) — a
 * non-array or an array containing a non-object entry is malformed input, not an empty list. Both
 * checks throw `MalformedVerdictError` rather than silently coercing to something summarizable.
 * Callers that must stay non-blocking on any failure (e.g. telemetry.ts) already wrap their entire
 * pipeline in a catch-all; callers that must refuse a malformed verdict outright
 * (record-verdict.ts) catch this specifically.
 * Severity classification is fail-closed: a finding counts toward `criticalOrMajorCount` unless its
 * `severity` trims and lowercases to exactly `"minor"` — so `"Critical"`, an unrecognized severity,
 * and a missing severity all count, rather than silently reading as zero.
 */
export function summarizeVerdict(parsed: VerifierVerdictJson): ParsedVerdict {
  if (parsed.verdict !== "CONFIRMED" && parsed.verdict !== "REFUTED") {
    throw new MalformedVerdictError(`verdict must be "CONFIRMED" or "REFUTED", got ${JSON.stringify(parsed.verdict)}`);
  }
  if (
    parsed.findings !== undefined &&
    (!Array.isArray(parsed.findings) || parsed.findings.some((f) => typeof f !== "object" || f === null))
  ) {
    throw new MalformedVerdictError("findings must be an array of objects");
  }
  // Fail closed on anything that isn't unambiguously minor. Three defects this closes at once,
  // all of which used to let a CONFIRMED verdict with real critical findings pass verify-gate's
  // `criticalOrMajorCount === 0` check (verify-gate.ts:224):
  //  - case: "Critical"/"MAJOR" matched neither literal and counted as zero.
  //  - unknown severities: "blocker", "high", "sev1" counted as zero.
  //  - missing or non-string severity: counted as zero.
  // A severity is only excluded from the count when it trims and lowercases to exactly "minor".
  const criticalOrMajor = (parsed.findings ?? []).filter((f) => {
    const severity = typeof f.severity === "string" ? f.severity.trim().toLowerCase() : "";
    return severity !== "minor";
  }).length;
  return {
    verdict: parsed.verdict,
    findingsCount: parsed.findings?.length ?? 0,
    criticalOrMajorCount: criticalOrMajor,
  };
}

/**
 * Fingerprints the current tree. A failure here is not a caller error — see verify-gate.ts's
 * present-but-null rule — so this never throws; a failed fingerprint comes back as `null`, exactly
 * as telemetry.ts's own inline try/catch used to behave before this was extracted.
 */
export async function captureDiffHash(cwd: string): Promise<string | null> {
  try {
    return await diffFingerprint(cwd);
  } catch {
    return null;
  }
}

export interface DiffCountsResult {
  changedLines: number | null;
  changedFiles: number | null;
}

/**
 * Measures the diff against `baseline`. `diffStat` itself already returns `null` (not the
 * caller's job to distinguish) on a real measurement failure — this wrapper only adds the same
 * throw-to-null degrade telemetry.ts used to apply inline, so a caller never has to destructure a
 * possibly-null return without a catch around it.
 *
 * `untrackedBaseline` passes straight through to `diffStat` — see its own doc comment for the
 * fail-closed contract (absent/null counts every untracked path; only an exact content-key match
 * excludes one). This function does not interpret the value itself, only forwards it, so a missing
 * or unusable snapshot degrades identically here to how it degrades inside `diffStat`.
 */
export async function captureDiffCounts(
  cwd: string,
  ignorePatterns: string[],
  baseline: string | null | undefined,
  untrackedBaseline?: Record<string, string> | null,
): Promise<DiffCountsResult> {
  try {
    const counts = await diffStat(cwd, ignorePatterns, baseline ?? null, untrackedBaseline);
    if (counts) return { changedLines: counts.changedLines, changedFiles: counts.changedFiles };
    return { changedLines: null, changedFiles: null };
  } catch {
    return { changedLines: null, changedFiles: null };
  }
}
