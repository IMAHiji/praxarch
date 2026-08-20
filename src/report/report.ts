#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { readJsonl } from "../hooks/lib/jsonl.js";
import { agentsDir, logDir } from "../hooks/lib/paths.js";

/**
 * praxarch report: role distribution, verification pass rate, token spend, model provenance, and
 * role→model bindings from the delegation JSONL logs plus the installed agent frontmatter.
 *
 * Deliberately does NOT claim a "delegation-vs-local ratio" or "escalation frequency" — praxarch's
 * hooks only observe Agent tool calls, not the main session's own direct work or the reasoning
 * behind a role choice, so those numbers can't be computed honestly from what's logged. If that
 * instrumentation gets added later, extend the schema rather than estimating here.
 *
 * Token spend and pricing: this reports raw token counts only, straight from what telemetry.ts
 * already logs (tool_response's resolvedModel/totalTokens/totalDurationMs). No dollar conversion,
 * no extrapolation for legacy rows that predate token capture — those are counted separately as
 * "unmeasured" rather than estimated.
 */

interface DelegationLogRecord {
  at: string;
  sessionId: string;
  role: string;
  model: string;
  // Optional: absent on rows logged before token capture existed. A present-but-invalid value
  // (wrong type, negative, NaN) is treated the same as absent — see isMeasuredTokens below.
  resolvedModel?: string | null;
  totalTokens?: number | null;
  durationMs?: number | null;
  batchId: string | null;
  verdict: "CONFIRMED" | "REFUTED" | null;
  criticalOrMajorCount: number | null;
  // Present only on rows written by `praxarch record-verdict` (value "record-verdict"), absent on
  // rows telemetry.ts writes off an observed Agent tool call. See renderModelProvenance below for
  // why this distinction matters for that section.
  via?: string;
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

// A row counts as "measured" only when both totalTokens is a real non-negative finite number and
// resolvedModel is a non-empty string — the token section groups by (role, resolvedModel), so a
// row missing either can't be placed in a group honestly. Everything else (legacy rows that
// predate token capture, and malformed rows — wrong type, negative, NaN) folds into the same
// unmeasured bucket; decision was not to invent a second bucket for "malformed" vs "legacy".
// Note: a raw `NaN` literal in a JSONL row is invalid JSON, so readJsonl (see jsonl.ts) drops that
// line before it ever reaches this check — the Number.isFinite guard here is unreachable for that
// exact case from real JSONL input. Left in place anyway: it's still correct defense for numeric
// values that parse fine as JSON but are non-finite for other reasons, and acceptance criterion 5
// is satisfied at the JSON-parse layer rather than here.
function isMeasuredTokens(record: DelegationLogRecord): record is DelegationLogRecord & {
  resolvedModel: string;
  totalTokens: number;
} {
  return (
    typeof record.totalTokens === "number" &&
    Number.isFinite(record.totalTokens) &&
    record.totalTokens >= 0 &&
    typeof record.resolvedModel === "string" &&
    record.resolvedModel.length > 0
  );
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

function renderTokenSpend(delegations: DelegationLogRecord[]): string[] {
  interface Group {
    role: string;
    resolvedModel: string;
    tokens: number;
    count: number;
  }
  const groups = new Map<string, Group>();
  let measuredTotal = 0;
  let unmeasuredCount = 0;

  for (const r of delegations) {
    if (!isMeasuredTokens(r)) {
      unmeasuredCount += 1;
      continue;
    }
    // "|" as the group-key delimiter: role names (alphanumeric/hyphen/colon, e.g.
    // "pr-review-toolkit:code-reviewer") and resolvedModel ids (alphanumeric/hyphen/brackets, e.g.
    // "claude-opus-4-8[1m]") never contain it -- confirmed against every role/resolvedModel string
    // in ~/.claude/praxarch/logs/*.jsonl. Kept as a plain, grep-able ASCII character rather than a
    // control byte so this file stays reviewable as normal text (a literal NUL byte here previously
    // made the whole file register as binary to git, breaking diff review and diff-based measurement).
    const key = `${r.role}|${r.resolvedModel}`;
    const existing = groups.get(key);
    if (existing) {
      existing.tokens += r.totalTokens;
      existing.count += 1;
    } else {
      groups.set(key, { role: r.role, resolvedModel: r.resolvedModel, tokens: r.totalTokens, count: 1 });
    }
    measuredTotal += r.totalTokens;
  }

  const lines: string[] = [];
  lines.push("Token spend:");
  if (groups.size === 0) {
    lines.push("  nothing measured in this window");
  } else {
    const sorted = [...groups.values()].sort((a, b) => b.tokens - a.tokens);
    for (const g of sorted) {
      const share = measuredTotal > 0 ? ((g.tokens / measuredTotal) * 100).toFixed(0) : "0";
      lines.push(`  ${g.role} (${g.resolvedModel}): ${g.tokens} tokens, ${g.count} delegations, ${share}% of measured`);
    }
  }
  lines.push(`${unmeasuredCount} delegations unmeasured (pre-token-capture)`);
  return lines;
}

// A binding's `model:` value in agent frontmatter is a short tier name ("opus", "sonnet",
// "haiku"); an observed `resolvedModel` from the logs is the full API model id ("claude-opus-4-8",
// "claude-sonnet-5[1m]"). Exact string equality between the two is never true even when they agree
// on tier, so "agreement" here means the bound tier name appears in the observed id — this is a
// substring check for tier identification, not a renaming/normalization of either value.
function modelAgrees(bound: string, observed: string): boolean {
  return observed.toLowerCase().includes(bound.toLowerCase());
}

function tierRank(model: string | null): number {
  // A `model:` key present but empty (e.g. `model: ""`) is the same "no binding" state as the key
  // being absent entirely — both render as "inherited (no binding)" below, so both must sort at 99.
  if (model === null || model === "") return 99;
  const order: Record<string, number> = { haiku: 0, sonnet: 1, opus: 2 };
  return order[model] ?? 50;
}

interface AgentFrontmatter {
  name?: string;
  model?: string;
}

// Parses ONLY the leading `---`-delimited frontmatter block, extracting `name:`/`model:` — no YAML
// library, every other frontmatter key and all body content is ignored. Returns null when no
// closing `---` delimiter is found (the file is treated as malformed by the caller).
function parseFrontmatter(content: string): AgentFrontmatter | null {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") return null;
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]?.trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return null;

  const result: AgentFrontmatter = {};
  for (const line of lines.slice(1, end)) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    const value = (rawValue ?? "").trim().replace(/^["']|["']$/g, "");
    if (key === "name") result.name = value;
    else if (key === "model") result.model = value;
  }
  return result;
}

interface RoleBinding {
  role: string;
  model: string | null;
}

interface BindingsData {
  bindings: RoleBinding[];
  skipped: string[];
  dirMissing: boolean;
}

async function loadRoleBindings(): Promise<BindingsData> {
  const dir = agentsDir();
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".md"));
  } catch {
    return { bindings: [], skipped: [], dirMissing: true };
  }

  const bindings: RoleBinding[] = [];
  const skipped: string[] = [];
  for (const file of files.sort()) {
    let content: string;
    try {
      content = await readFile(join(dir, file), "utf8");
    } catch {
      // Unreadable file (dangling symlink, permissions, etc.) — skip it and name it, same as a
      // malformed-frontmatter file below. One bad agent file must never fail the whole report.
      skipped.push(file);
      continue;
    }
    const parsed = parseFrontmatter(content);
    if (!parsed || !parsed.name) {
      skipped.push(file);
      continue;
    }
    bindings.push({ role: parsed.name, model: parsed.model ?? null });
  }
  return { bindings, skipped, dirMissing: false };
}

// Sorted by model tier (haiku < sonnet < opus < other/unrecognized < inherited/no-binding), then
// role name within a tier.
function renderRoleBindings(data: BindingsData, delegations: DelegationLogRecord[]): string[] {
  const lines: string[] = [];
  if (data.dirMissing) {
    lines.push(`Role bindings unavailable (no agents directory at ${agentsDir()})`);
    return lines;
  }

  lines.push(
    "Role bindings (current intent from agent frontmatter — resolvedModel in the token spend " +
      "section above is historical truth, what actually ran, and may differ from the current binding):",
  );

  const observedModelsByRole = new Map<string, Set<string>>();
  const allObservedRoles = new Set<string>();
  for (const r of delegations) {
    allObservedRoles.add(r.role);
    if (typeof r.resolvedModel === "string" && r.resolvedModel.length > 0) {
      if (!observedModelsByRole.has(r.role)) observedModelsByRole.set(r.role, new Set());
      observedModelsByRole.get(r.role)?.add(r.resolvedModel);
    }
  }

  const sorted = [...data.bindings].sort((a, b) => {
    const tierDiff = tierRank(a.model) - tierRank(b.model);
    if (tierDiff !== 0) return tierDiff;
    return a.role.localeCompare(b.role);
  });

  for (const b of sorted) {
    let line = `  ${b.role}: ${b.model ? `bound ${b.model}` : "inherited (no binding)"}`;
    const observed = observedModelsByRole.get(b.role);
    if (!allObservedRoles.has(b.role)) {
      line += " (unused in this window)";
    } else if (b.model && observed) {
      // Fires on ANY observed resolvedModel that diverges from the binding, not only when every
      // observation disagrees — a role that ran under both its bound model and a stray one in the
      // same window is exactly the divergence a reader needs to see. Names only the diverging
      // model(s), not the full observed set, so an observation that agrees with the binding doesn't
      // get lumped in and read as evidence of drift.
      const diverging = [...observed].filter((m) => !modelAgrees(b.model as string, m)).sort();
      if (diverging.length > 0) {
        line += `; observed ${diverging.join(", ")} in this window`;
      }
    }
    lines.push(line);
  }

  if (data.skipped.length > 0) {
    lines.push(`Skipped malformed agent file(s): ${data.skipped.sort().join(", ")}`);
  }

  const boundRoleNames = new Set(data.bindings.map((b) => b.role));
  const unbound = [...allObservedRoles].filter((role) => !boundRoleNames.has(role)).sort();
  if (unbound.length > 0) {
    lines.push(`Unbound/removed roles observed in logs: ${unbound.join(", ")}`);
  }

  return lines;
}

// Per role: dispatch count, explicit-vs-inherited split, and the distinct resolvedModel values
// observed — the exact join issue #7 was filed off a hand-rolled, incorrect version of (540
// "inherited" rows and 163 "general-purpose" rows read as if one were a subset of the other, when
// the correct join required a fresh jq/python session both times it was needed). This makes that
// join a permanent one-command answer instead of a repeatable data-analysis exercise: "do any
// general-purpose rows inherit?" is answerable straight from this section's explicit/inherited
// split and resolvedModel list for that role.
function renderModelProvenance(delegations: DelegationLogRecord[]): string[] {
  interface RoleProvenance {
    role: string;
    total: number;
    explicit: number;
    inherited: number;
    resolvedModels: Set<string>;
  }
  // Two writers append to the same monthly JSONL: telemetry.ts logs a real dispatch off an
  // observed Agent tool call (model is the actual bound/inherited value), while `praxarch
  // record-verdict` (record-verdict.ts) logs a verdict-record row with model:"n/a" and
  // via:"record-verdict" for a verdict that arrived outside the normal Stop-hook path — it never
  // dispatched anything. Counting the latter here would inflate dispatch totals and misreport
  // "n/a" delegations as "explicit", so this section excludes them entirely (they're not part of
  // the dispatch/model-provenance question this section answers).
  const byRole = new Map<string, RoleProvenance>();
  for (const r of delegations) {
    if (r.via === "record-verdict") continue;
    let entry = byRole.get(r.role);
    if (!entry) {
      entry = { role: r.role, total: 0, explicit: 0, inherited: 0, resolvedModels: new Set() };
      byRole.set(r.role, entry);
    }
    entry.total += 1;
    // `model` is never absent on a real row — telemetry.ts always writes `model ?? "inherited"` —
    // so "explicit" here means anything other than the literal sentinel string "inherited", not a
    // presence check.
    if (r.model === "inherited") entry.inherited += 1;
    else entry.explicit += 1;
    if (typeof r.resolvedModel === "string" && r.resolvedModel.length > 0) entry.resolvedModels.add(r.resolvedModel);
  }

  const lines: string[] = [];
  lines.push("Model provenance (per role: dispatch count, explicit-vs-inherited split, distinct resolvedModel values):");
  if (byRole.size === 0) {
    lines.push("  no delegations in this window");
    return lines;
  }
  const sorted = [...byRole.values()].sort((a, b) => b.total - a.total);
  for (const p of sorted) {
    const models = p.resolvedModels.size > 0 ? [...p.resolvedModels].sort().join(", ") : "none observed";
    lines.push(`  ${p.role}: ${p.total} dispatch(es), ${p.explicit} explicit / ${p.inherited} inherited, resolvedModel: ${models}`);
  }
  return lines;
}

function render(records: LogRecord[]): string {
  const delegations = records.filter((r): r is DelegationLogRecord => !isEventRecord(r));
  const failOpens = records.filter(isEventRecord).filter((r) => r.event === "verifyGateFailOpen");

  if (delegations.length === 0 && failOpens.length === 0) {
    return "No delegations recorded for the requested window.";
  }

  const byRole = new Map<string, number>();
  const batchAllCounts = new Map<string, number>();
  const batchMeasured = new Map<string, { tokens: number; count: number }>();
  let confirmedCount = 0;
  let refutedCount = 0;

  for (const r of delegations) {
    byRole.set(r.role, (byRole.get(r.role) ?? 0) + 1);
    if (r.batchId) {
      batchAllCounts.set(r.batchId, (batchAllCounts.get(r.batchId) ?? 0) + 1);
      if (isMeasuredTokens(r)) {
        const existing = batchMeasured.get(r.batchId) ?? { tokens: 0, count: 0 };
        existing.tokens += r.totalTokens;
        existing.count += 1;
        batchMeasured.set(r.batchId, existing);
      }
    }
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

  lines.push(`Fan-out batches: ${batchAllCounts.size}`);
  for (const [batchId, totalCount] of [...batchAllCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const measured = batchMeasured.get(batchId) ?? { tokens: 0, count: 0 };
    lines.push(`  ${batchId}: ${measured.tokens} tokens (${measured.count}/${totalCount} delegations measured)`);
  }
  // Surfaces what would otherwise be invisible: a fail-open leaves no trace to the user beyond
  // stderr/a systemMessage at the time, so this is the only durable record of the gate having
  // gone quiet (issue #1, defect 3).
  lines.push(`Verify-gate fail-opens: ${failOpens.length}`);

  lines.push("");
  lines.push(...renderTokenSpend(delegations));

  lines.push("");
  lines.push(...renderModelProvenance(delegations));

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

  const delegations = records.filter((r): r is DelegationLogRecord => !isEventRecord(r));
  const bindingsData = await loadRoleBindings();

  const output = [render(records), "", ...renderRoleBindings(bindingsData, delegations)].join("\n");
  process.stdout.write(`${output}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`praxarch report error: ${String(err)}\n`);
  process.exitCode = 1;
});
