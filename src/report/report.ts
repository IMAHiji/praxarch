#!/usr/bin/env node
import { readdir } from "node:fs/promises";
import { readJsonl } from "../hooks/lib/jsonl.js";
import { logDir } from "../hooks/lib/paths.js";

/**
 * praxarch report: role distribution and verification pass rate from the delegation JSONL logs.
 *
 * Deliberately does NOT claim a "delegation-vs-local ratio" or "escalation frequency" — praxarch's
 * hooks only observe Agent tool calls, not the main session's own direct work or the reasoning
 * behind a role choice, so those numbers can't be computed honestly from what's logged. If that
 * instrumentation gets added later, extend the schema rather than estimating here.
 */

interface DelegationLogRecord {
  at: string;
  sessionId: string;
  role: string;
  model: string;
  batchId: string | null;
  verdict: "CONFIRMED" | "REFUTED" | null;
  criticalOrMajorCount: number | null;
}

// Event rows (currently just verify-gate fail-opens) share the same monthly JSONL but aren't
// delegations — they carry `event` instead of `role`. Kept as a separate shape so they can't
// silently pass the DelegationLogRecord checks below and pollute role/verdict stats.
interface EventLogRecord {
  at: string;
  sessionId: string;
  event: string;
  reason?: string;
  detail?: string;
}

type LogRecord = DelegationLogRecord | EventLogRecord;

function isEventRecord(record: LogRecord): record is EventLogRecord {
  return "event" in record && typeof (record as EventLogRecord).event === "string";
}

interface Args {
  session: "current" | "all";
  since: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { session: "all", since: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--session") args.session = argv[++i] === "current" ? "current" : "all";
    else if (argv[i] === "--since") args.since = argv[++i] ?? null;
  }
  return args;
}

async function loadRecords(since: string | null): Promise<LogRecord[]> {
  let files: string[];
  try {
    files = (await readdir(logDir())).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const relevant = since ? files.filter((f) => f >= `${since}.jsonl`) : files;
  const all: LogRecord[] = [];
  for (const file of relevant.sort()) {
    all.push(...(await readJsonl<LogRecord>(`${logDir()}/${file}`)));
  }
  return all;
}

function render(records: LogRecord[]): string {
  const delegations = records.filter((r): r is DelegationLogRecord => !isEventRecord(r));
  const failOpens = records.filter(isEventRecord).filter((r) => r.event === "verifyGateFailOpen");

  if (delegations.length === 0 && failOpens.length === 0) {
    return "No delegations recorded for the requested window.";
  }

  const byRole = new Map<string, number>();
  const byBatch = new Set<string>();
  let confirmedCount = 0;
  let refutedCount = 0;

  for (const r of delegations) {
    byRole.set(r.role, (byRole.get(r.role) ?? 0) + 1);
    if (r.batchId) byBatch.add(r.batchId);
    if (r.verdict === "CONFIRMED") confirmedCount += 1;
    else if (r.verdict === "REFUTED") refutedCount += 1;
  }

  const lines: string[] = [];
  lines.push(`Delegations: ${delegations.length}`);
  lines.push("Role distribution:");
  for (const [role, count] of [...byRole.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${role}: ${count}`);
  }

  const verifierRuns = confirmedCount + refutedCount;
  if (verifierRuns > 0) {
    const rate = ((confirmedCount / verifierRuns) * 100).toFixed(0);
    lines.push(`Verifier pass rate: ${confirmedCount}/${verifierRuns} (${rate}%) CONFIRMED on first log`);
  } else {
    lines.push("Verifier pass rate: no verifier runs recorded");
  }

  lines.push(`Fan-out batches: ${byBatch.size}`);
  // Surfaces what would otherwise be invisible: a fail-open leaves no trace to the user beyond
  // stderr/a systemMessage at the time, so this is the only durable record of the gate having
  // gone quiet (issue #1, defect 3).
  lines.push(`Verify-gate fail-opens: ${failOpens.length}`);

  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  let records = await loadRecords(args.since);

  if (args.session === "current") {
    const currentSessionId = process.env["CLAUDE_SESSION_ID"];
    if (currentSessionId) {
      records = records.filter((r) => r.sessionId === currentSessionId);
    }
  }

  process.stdout.write(`${render(records)}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`praxarch report error: ${String(err)}\n`);
  process.exitCode = 1;
});
