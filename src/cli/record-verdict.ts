import { readFile } from "node:fs/promises";
import { loadConfig } from "../hooks/lib/config.js";
import { appendJsonl } from "../hooks/lib/jsonl.js";
import { resolveMeasurementCwd } from "../hooks/lib/measurement-cwd.js";
import { logFileForDate } from "../hooks/lib/paths.js";
import { readSessionState, updateSessionState, type VerifierRecord } from "../hooks/lib/session-state.js";
import { readUntrackedBaseline } from "../hooks/lib/untracked-baseline-store.js";
import {
  captureDiffCounts,
  captureDiffHash,
  extractTrailingJson,
  MalformedVerdictError,
  summarizeVerdict,
} from "../hooks/lib/verdict.js";

/**
 * `praxarch record-verdict` — the explicit-CLI path for recording a verdict that arrives outside
 * a hookable event, chiefly a resumed agent's SendMessage reply, which telemetry.ts's
 * PostToolUse(Agent) trigger never observes (see telemetry.ts:55 and issue #5).
 *
 * Security-relevant contract, not incidental validation:
 *  - `--role` must be a member of `config.verifyGate.verdictRoles`. Anything else is refused with
 *    a non-zero exit and session state is left untouched — an arbitrary agent's output must never
 *    be recordable as a verdict that unblocks verify-gate. The role check runs before any state
 *    mutation, and no failure path below it partially writes state.
 *  - Input is treated as attacker-influenceable: it's the full text of an agent's output, parsed
 *    defensively through the same `extractTrailingJson` telemetry.ts uses. No trailing JSON
 *    verdict block → refused, non-zero exit, no state written.
 *  - The diff fingerprint is captured HERE, at recording time, via the same
 *    diffStat/diffFingerprint path telemetry.ts uses — never accepted as counts or a hash on the
 *    command line. A caller cannot assert its own diff size or claim a specific fingerprint; both
 *    are always independently measured against the real working tree.
 *  - A fingerprint capture failure is not a refusal (matches telemetry.ts): the verdict is still
 *    recorded, with `diffHash: null`, so verify-gate's present-but-null rule denies it a free pass
 *    rather than the CLI silently discarding an otherwise-legitimate verdict.
 */

interface RecordVerdictArgs {
  session: string | null;
  role: string | null;
  file: string | null;
}

function parseArgs(argv: string[]): RecordVerdictArgs {
  const args: RecordVerdictArgs = { session: null, role: null, file: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--session") args.session = argv[(i += 1)] ?? null;
    else if (argv[i] === "--role") args.role = argv[(i += 1)] ?? null;
    else if (argv[i] === "--file") args.file = argv[(i += 1)] ?? null;
  }
  return args;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function fail(reason: string): number {
  process.stderr.write(`praxarch record-verdict: ${reason}\n`);
  return 1;
}

export async function recordVerdict(argv: string[], cwd: string = process.cwd()): Promise<number> {
  const args = parseArgs(argv);
  if (!args.session || !args.role) {
    return fail("--session <id> and --role <role> are required");
  }

  if (!args.file && process.stdin.isTTY) {
    return fail("no --file given and stdin is a TTY — pipe verdict text in or pass --file <path>");
  }

  let text: string;
  try {
    text = args.file ? await readFile(args.file, "utf8") : await readStdin();
  } catch (err) {
    return fail(`could not read input: ${String(err)}`);
  }

  const { config, warnings } = await loadConfig(cwd);
  if (warnings.length > 0) process.stderr.write(`praxarch record-verdict: ${warnings.join(" ")}\n`);

  // Authorization check first, and before any state is touched: a role outside verdictRoles is
  // refused regardless of whether the input even contains a valid verdict block.
  if (!config.verifyGate.verdictRoles.includes(args.role)) {
    return fail(
      `role "${args.role}" is not in verdictRoles (${config.verifyGate.verdictRoles.join(", ")}) — refusing to record`,
    );
  }

  const parsed = extractTrailingJson(text);
  if (!parsed) {
    return fail("no trailing JSON verdict block found in input — refusing to record");
  }

  let summary: ReturnType<typeof summarizeVerdict>;
  try {
    summary = summarizeVerdict(parsed);
  } catch (err) {
    if (err instanceof MalformedVerdictError) {
      return fail(`malformed verdict block: ${err.message} — refusing to record`);
    }
    throw err;
  }
  const at = new Date().toISOString();

  // State read first (for baselineHead and baselineCwd) — the CLI's own `cwd` argument (default
  // `process.cwd()`) is exactly the vector that recorded the issue's 1202/7 repro: a verdict
  // recorded from whatever directory the shell happened to be in. `cwd` now only serves as the
  // legacy fallback inside `resolveMeasurementCwd` when the session predates the anchor.
  let baselineHead: string | null | undefined;
  let baselineCwd: string | undefined;
  try {
    const state = await readSessionState(args.session);
    baselineHead = state.baselineHead;
    baselineCwd = state.baselineCwd;
  } catch (err) {
    return fail(`session state unwritable: ${String(err)}`);
  }
  // Resolved once and reused by both the fingerprint and the counts below — see
  // measurement-cwd.ts's doc comment for why a dead anchor becomes `null` rather than falling back
  // to the CLI's own cwd, which would silently reintroduce the bug this anchor exists to close.
  const measurementCwd = await resolveMeasurementCwd(baselineCwd, cwd);

  // Fingerprint captured here, independently, against the real (resolved) tree — never derived
  // from anything the caller supplied. A dead anchor degrades to null exactly like an unhashable
  // diff does (see captureDiffHash's own doc comment), never fingerprinting the CLI's own cwd.
  const diffHash = measurementCwd === null ? null : await captureDiffHash(measurementCwd);
  // One store read, alongside the state read above — matches telemetry.ts's fail-safe contract (a
  // missing/corrupt sidecar reads as `null`, never throws).
  const untrackedBaseline = await readUntrackedBaseline(args.session);
  // A dead anchor never reaches diffStat — same fail-closed reasoning as verify-gate.ts and
  // telemetry.ts (diffStat returns `{0, 0}` for a non-repo cwd, which must not be handed back as
  // "nothing changed").
  const { changedLines, changedFiles } =
    measurementCwd === null
      ? { changedLines: null, changedFiles: null }
      : await captureDiffCounts(measurementCwd, config.verifyGate.ignorePatterns, baselineHead, untrackedBaseline);

  const verifierRecord: VerifierRecord = {
    ...summary,
    recordedAt: at,
    diffHash,
    changedLines,
    changedFiles,
  };

  try {
    await updateSessionState(args.session, (fresh) => {
      fresh.lastVerifier = verifierRecord;
    });
  } catch (err) {
    return fail(`session state unwritable: ${String(err)}`);
  }

  // Marked `via: "record-verdict"` so `praxarch report` and any future audit can tell a
  // CLI-recorded verdict apart from one telemetry.ts observed directly off a tool call.
  //
  // The verdict is already recorded in session state by this point (see updateSessionState
  // above) — a failure here (e.g. an unwritable log dir) must not misreport that as an overall
  // failure, or an operator reading a non-zero exit + stack trace would conclude the verdict
  // never landed and waive the gate, which is exactly the failure this feature exists to prevent.
  let logWriteError: unknown;
  try {
    await appendJsonl(logFileForDate(), {
      at,
      sessionId: args.session,
      role: args.role,
      model: "n/a",
      resolvedModel: null,
      totalTokens: null,
      durationMs: null,
      batchId: null,
      verdict: summary.verdict,
      findingsCount: summary.findingsCount,
      criticalOrMajorCount: summary.criticalOrMajorCount,
      via: "record-verdict",
    });
  } catch (err) {
    logWriteError = err;
  }

  process.stdout.write(
    `praxarch record-verdict: recorded ${args.role} verdict ${summary.verdict} ` +
      `(${summary.findingsCount} finding(s), ${summary.criticalOrMajorCount} critical/major) — ` +
      "verify-gate will see this on the next stop.\n",
  );
  if (logWriteError !== undefined) {
    process.stderr.write(
      `praxarch record-verdict: verdict recorded, but the delegation-log row could not be written: ${String(logWriteError)}\n`,
    );
  }
  return 0;
}
