#!/usr/bin/env node
import { readdir } from "node:fs/promises";
import { readJsonl } from "../hooks/lib/jsonl.js";
import { LOG_DIR } from "../hooks/lib/paths.js";

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

async function loadRecords(since: string | null): Promise<DelegationLogRecord[]> {
  let files: string[];
  try {
    files = (await readdir(LOG_DIR)).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const relevant = since ? files.filter((f) => f >= `${since}.jsonl`) : files;
  const all: DelegationLogRecord[] = [];
  for (const file of relevant.sort()) {
    all.push(...(await readJsonl<DelegationLogRecord>(`${LOG_DIR}/${file}`)));
  }
  return all;
}

function render(records: DelegationLogRecord[]): string {
  if (records.length === 0) {
    return "No delegations recorded for the requested window.";
  }

  const byRole = new Map<string, number>();
  const byBatch = new Set<string>();
  let confirmedCount = 0;
  let refutedCount = 0;

  for (const r of records) {
    byRole.set(r.role, (byRole.get(r.role) ?? 0) + 1);
    if (r.batchId) byBatch.add(r.batchId);
    if (r.verdict === "CONFIRMED") confirmedCount += 1;
    else if (r.verdict === "REFUTED") refutedCount += 1;
  }

  const lines: string[] = [];
  lines.push(`Delegations: ${records.length}`);
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
