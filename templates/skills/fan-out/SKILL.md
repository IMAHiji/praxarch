---
name: fan-out
description: Run several independent, fully-specifiable units of work in parallel using isolated git worktrees, then verify and integrate the merged result in one pass. Use when you have three or more genuinely independent pieces of work — not for anything with shared state or ordering dependencies between the pieces.
---

## When this applies

Use fan-out only when all of the following hold:

- **Three or more** independent units of work (below that, the coordination overhead isn't worth it).
- Each unit is **fully specifiable up front** — if you'd need to check in mid-task, it's not a fan-out
  candidate, it's a regular `executor` delegation.
- The units **don't share mutable state** and have **no ordering dependency** on each other. If unit B
  needs unit A's output, this isn't fan-out — do them serially.

Classic fits: independent bug fixes across unrelated files, parallel per-module test coverage,
mechanical migrations applied to N independent packages.

## Method

1. **Write N complete specs**, one per unit — same bar as any delegation (goal, constraints, success
   criteria, paths, reasoning). Do this before launching anything.
2. **Launch all N in one message**, each as an `Agent` call with `isolation: "worktree"` and an explicit
   `model` per the role table in the orchestration policy. Do not launch them one at a time across
   multiple turns — the point is concurrency.
3. **Collect results.** Each worktree agent reports back its branch/path. Do not merge yet.
4. **One verifier pass over the merged result**, not one per worker. Merge the branches (or diff them
   together) first, then run a single `verifier` against the combined change — this catches
   cross-worker interactions a per-worker verification would miss, and avoids paying the verifier's
   fresh-context cost N times for work that's about to be reviewed together anyway.
5. **Integrate** only after that single verification pass confirms the merged result.

## Reporting

praxarch's telemetry hook tags fan-out delegations as a batch (shared batch id) so `/praxarch-report`
can distinguish parallel from serial delegation and show whether fan-out is earning its overhead.
