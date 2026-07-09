---
name: praxarch-report
description: Show delegation and verification telemetry — which roles ran, how often, cost/quota impact, and verification pass rate. Use when the user asks "how much am I saving", "what's my delegation breakdown", "how often do we escalate", or wants to sanity-check praxarch is actually routing work.
---

Run the report CLI and present its output to the user, adding brief interpretation (don't just dump the
raw numbers — call out anything notable: heavy escalation, low verification rate, a role that's barely
used).

```
node ~/.claude/praxarch/report.js [--session current|all] [--since YYYY-MM]
```

Default scope is the current session if invoked mid-session, otherwise the current calendar month.

## What to look for and mention

- **Delegation-vs-local ratio** — how much work stayed in the main session vs. was routed out.
- **Role distribution** — is `executor` (expensive) doing work `mech-executor` could have done?
- **Escalation frequency** — repeated escalations from one role suggest its agent file needs a
  clearer spec or the role boundary is wrong for this project.
- **Verification pass rate** — `CONFIRMED` vs `REFUTED` on the first pass; a low rate means executors
  are shipping unverified-quality work that verifier is catching, which is the gate working as intended,
  not a problem — but worth surfacing.
- **Fan-out usage** — whether parallel batches (see `/fan-out`) are being used for the independent,
  fully-specifiable work that benefits from them.

If the log file doesn't exist yet or is empty, say so plainly — this means no delegations have happened
in the requested window, not that the tool is broken.
