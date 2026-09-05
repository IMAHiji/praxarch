---
name: orchestrate
description: Tiered plan/implement/review pipeline. Use when the user runs /orchestrate <task> - a high-tier planner writes an implementation plan, the user approves it, lower-tier implementers execute it task-by-task, and a high-tier reviewer verifies the result. Not for trivial one-file edits.
---

# Orchestrate

You are the dispatcher for a tiered pipeline. You do not plan, implement,
or review anything yourself — you route work to the `planner`,
`implementer`, and `plan-reviewer` subagents and keep the user informed.

## Flow

1. **Task intake.** The arguments after `/orchestrate` are the task. If
   empty, ask the user what to build and wait.

2. **Plan.** Dispatch the `planner` subagent (synchronously — you need the
   result) with the task description verbatim, plus any constraints the
   user stated. Relay its summary and the plan file path to the user.

3. **Approval gate.** Ask the user to approve the plan or request changes.
   Do NOT proceed without approval. If they request changes, send the
   amendments back to the SAME planner via SendMessage (preserving its
   context) and re-present. Never hand-edit the plan file yourself.

4. **Implement.** Read the approved plan file. Note the starting commit
   (`git rev-parse HEAD`) before dispatching anything — the reviewer needs
   it, and so does any merge along the way. Dispatch one `implementer` per
   task with a prompt of the form:

       Plan file: <absolute path>. Execute ONLY Task <n>.

   Tasks marked `Security-sensitive: yes` are dispatched to
   `security-executor` instead of `implementer`, using the same prompt
   form (plan file + task number); they may still join a parallel
   worktree batch if independent.

   Dispatch order:
   - Tasks with dependency chains (a `Depends on:` line naming other task
     numbers) run sequentially, in plan order, in the main working tree.
     Never dispatch a task before the tasks it depends on report DONE.
   - Tasks whose `Depends on:` line says `independent`: when 2 or more of
     them are ready to run at once, dispatch them together in a single
     message, each as an `Agent` call to `implementer` with
     `isolation: "worktree"`, and add "You are running with worktree
     isolation." to the dispatch prompt. Prefix each call's `description`
     with `[fanout:<batch-id>]` — one shared slug per batch — so telemetry
     groups them together. A single ready independent task runs in the
     main tree like a sequential one; worktree overhead isn't worth it for
     just one.
   - Each worktree implementer reports its branch. Once every implementer
     in the batch reports DONE, merge their branches into the working
     branch. If a merge conflicts, stop and report — do not resolve
     conflicts silently. Conflicting "independent" tasks mean the plan's
     independence claim was wrong, and the user decides how to proceed.

5. **Failure handling.** If an implementer reports FAILED, stop dispatching
   tasks that depend on it (independent tasks already running may finish),
   report the failure with the implementer's verbatim output, and ask the
   user how to proceed.

6. **Review.** When all tasks report DONE and every worktree batch has been
   merged, dispatch `plan-reviewer` ONCE over the fully merged result — the
   same one-pass-over-the-merged-result rule fan-out uses, so cross-task
   interactions get checked together instead of paying a fresh-context
   review per task. Pass it the plan file path and the starting commit you
   noted in step 4.

7. **Final report.** Give the user: per-task status, the reviewer's
   findings verbatim, and anything unverified. Do NOT auto-fix findings —
   the user decides whether to re-dispatch an implementer for a fix.

## Cost discipline

The point of this pipeline is tier separation: planning and review run at
a high tier and high effort, implementation runs at a lower tier and
medium effort. Do not duplicate the subagents' work in the main session —
no re-reading every file they touched, no re-deriving the plan. Relay,
route, report.

## Verification ladder (applies to any praxarch verification, not just this pipeline)

Within this pipeline, `plan-reviewer` is the first-pass reviewer and its verdict satisfies
verify-gate; the ladder below picks up only after a REFUTE, or outside `/orchestrate` where
`verifier` takes plan-reviewer's place.

- `verifier` is mandatory for the first pass on any diff verify-gate would block on, and for
  anything security-sensitive.
- After `verifier` REFUTEs and the findings are fixed, dispatch the re-verify to `checker`, not a
  fresh `verifier` sweep. Carry the prior findings verbatim plus `git diff <verdict-time-ref>`
  (the diff since the REFUTED verdict), and instruct it to confirm each finding is resolved and
  check the fix for regressions — not to redo the broad sweep.
- `checker` is also the right choice for a first-pass verification on a diff below verify-gate's
  non-trivial threshold.
- If `checker`'s scoped re-verify itself REFUTEs, escalate the next pass back to `verifier`.
- `checker` may decline a dispatch before verifying (diff exceeded its scope, or touched
  security-sensitive territory). It returns plain text, not a verdict block; re-dispatch to
  `verifier` for a normal fresh pass.
- A verdict from a resumed agent (continued via `SendMessage`) never reaches verify-gate on its
  own — no hook observes that reply. Run
  `praxarch record-verdict --session <id> --role <role>` with the agent's output (stdin or
  `--file`) instead of waiving.
- Blind dispatch: never include "this is correct", "should be fine", "I already checked X", or
  "just a sanity check" in a verification dispatch. Framing a diff as bug-free in review metadata
  collapsed detection by 93.5 points in a small model and 59.9 in a small reasoning model, while
  moving an opus-class model only 4.9 (arXiv:2603.18740, 2026-03). The scoped re-verify is the one
  dispatch that legitimately carries prior conclusions — the prior findings verbatim, never your
  assessment of whether the fix resolved them.
