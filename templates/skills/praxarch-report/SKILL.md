---
name: praxarch-report
description: Show delegation and verification telemetry — which roles ran, how often, and verification pass rate. Use when the user asks "what's my delegation breakdown", "how often does verification catch problems", or wants to sanity-check praxarch is actually routing work.
---

Run the report CLI and present its output to the user, adding brief interpretation (don't just dump the
raw numbers — call out anything notable: a role that's barely used, a low verification pass rate).

```
node ~/.claude/praxarch/report/report.js [--session current|all] [--since YYYY-MM]
```

`--session current` filters to `$CLAUDE_SESSION_ID` when that's set in the invoking shell; otherwise it
falls back to all sessions in the window. Default scope with no flags is every session across all
logged months.

## What the report actually measures — and what it doesn't

Praxarch's telemetry hook observes `Agent` tool calls only. It has no visibility into the main
session's own direct work, so it **cannot** compute a delegation-vs-local ratio or escalation
frequency (that would require tracking that two delegations were retries of the same task, which
isn't logged). Don't imply the report shows those — it doesn't, and claiming otherwise would be
guessing dressed up as data.

What it does report, honestly:

- **Role distribution** — count per role. Worth flagging if `executor` (expensive) is doing high
  volume that looks like it could've been `mech-executor` work — that's a judgment call for the
  user to make, the report just surfaces the raw counts.
- **Verifier pass rate** — `CONFIRMED` vs `REFUTED` across logged verifier runs. A low rate isn't
  necessarily bad — it means the gate is catching things — but it's worth surfacing either way.
- **Fan-out batch count** — how many `/fan-out` batches ran (delegations tagged
  `[fanout:<id>]` in their description), as a rough signal of whether parallel fan-out is being
  used at all, plus a per-batch token subtotal.
- **Token spend** — total tokens per (role, resolved model) pair, straight from what telemetry
  already captures (`resolvedModel`/`totalTokens` on each delegation row) — no dollar conversion,
  no pricing. Rows logged before token capture existed (or carrying a malformed token count) are
  counted separately as "unmeasured (pre-token-capture)", never backfilled or estimated.
- **Role bindings** — the role→model binding table read live from `~/.claude/agents/*.md`
  frontmatter, plus reconciliation against the log window: a bound role never seen in the logs is
  flagged unused, a role seen in the logs with no matching agent file is flagged unbound/removed,
  and a role whose current binding disagrees with what was actually observed running is flagged
  explicitly. This table reflects *current intent* (frontmatter, right now); the token-spend
  section's `resolvedModel` reflects *historical truth* (what actually ran) — the two can diverge
  after a binding change, and the report labels them separately rather than conflating them.

If the log directory doesn't exist yet or the window is empty, the report says so plainly — that
means no delegations have happened in the requested window, not that the tool is broken. Likewise,
if `~/.claude/agents` doesn't exist or isn't readable, the role-bindings section says so rather
than silently showing an empty table.
