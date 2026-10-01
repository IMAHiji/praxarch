<!-- praxarch:orchestration:start -->
## Orchestration (praxarch)

This section governs how the main session delegates work. It applies to **this session only** —
subagents do not read or apply these rules to their own behavior; the orchestrator applies them
when deciding whether and how to delegate.

Roles are named, not modeled. Never write a specific model name in this policy — role bindings
live in `~/.claude/agents/*.md` frontmatter and shift independently as models change.

### Roles

| Role | Use for |
|---|---|
| `scout` | Read-only recon: symbol usages, config discovery, "where is X" |
| `Explore` | Broad fan-out search across many files when you only need the conclusion |
| `mech-executor` | Fully-specified mechanical work: renames, pattern refactors, docs, boilerplate |
| `executor` | Work needing local design judgment: features, fixes, non-security tradeoffs |
| `verifier` | Fresh-context adversarial review of non-trivial completed work |
| `checker` | Cheaper sonnet-tier re-verify after a REFUTED verdict, or a sub-threshold first pass — never the first pass on a diff the gate would block on, never security-sensitive work |
| `security-executor` | Auth, authz, secrets, crypto, trust-boundary validation — always, no exceptions |
| `planner` | Plan pipeline: writes the numbered plan file (highest tier) |
| `implementer` | Plan pipeline: executes one plan task; independent tasks run in parallel worktrees |
| `plan-reviewer` | Plan pipeline: verifies the merged result against the plan (satisfies verify-gate) |

**Plan pipeline** (dispatched by hand; the `/orchestrate` skill was retired 2026-10-01):
1. Dispatch `planner` with the task verbatim plus stated constraints; relay its summary and plan
   file path.
2. Get the user's approval. Amendments go back to the same planner via SendMessage; never
   hand-edit the plan file.
3. Record `git rev-parse HEAD`, then dispatch one `implementer` per task:
   `Plan file: <absolute path>. Execute ONLY Task <n>.` A task marked
   `Security-sensitive: yes` goes to `security-executor` with the same prompt.
   - Tasks with `Depends on:` run sequentially in plan order in the main tree, each after its
     dependencies report DONE.
   - Two or more ready `independent` tasks go out in one message with `isolation: "worktree"`,
     "You are running with worktree isolation." in the prompt, and a shared
     `[fanout:<batch-id>]` description prefix. Merge their branches when all report DONE; on a
     conflict, stop and report.
   - On FAILED, stop dependent tasks and report the implementer's output verbatim.
4. Once every task is DONE and every batch merged, dispatch `plan-reviewer` once over the
   merged result with the plan file path and the starting commit.
5. Report per-task status, the reviewer's findings verbatim and anything unverified. Don't
   auto-fix findings; the user decides on re-dispatch.

### Plan/execute tier rule (hard rule)

- **Planning** runs at the highest tier you currently have available — this varies with usage,
  so check what's actually selected rather than assuming a fixed name. For code, that's the
  `planner` role (the plan pipeline above), or the orchestrator's own session when it's already at
  that tier. Planning always ends in a written plan (the planner's plan file; an equivalent
  written-down plan for ad-hoc delegation) — never a handoff based only on in-context reasoning.
- **Execution** always runs at a role bound to a lower tier (`implementer`, `executor`,
  `mech-executor`) — never the orchestrator itself, even when the orchestrator's own session
  happens to already be at the highest tier. Being the highest-tier session is a reason to
  delegate execution, not license to do it yourself.
- Unlike the process skills in Autonomy, this is hard, not suggest-only — it governs everything
  above the "single-file read / quick judgment call" line in Retained locally below, which is
  unchanged.
- Scope: code/praxarch roles only for now. `adobe-practice-research` already has an equivalent
  split; other content-creation skills don't yet — treat as a separate, tracked follow-up.
- **Advisor rides on top of role bindings.** `advisorModel` in settings pairs every dispatch with
  a stronger consult-only model at decision points. It is not an exception to the no-explicit-
  `model` rule, it never substitutes for a `verifier` pass, and advisor cost is invisible to
  praxarch telemetry — treat frequent advisor use on cheap roles (`checker`, `Explore`) as a
  smell, not a feature.

### Delegation protocol

1. **Complete specs only.** Every delegation includes: goal, constraints, success criteria,
   relevant paths, and the reasoning behind the ask — not just a task description. Subagents
   start cold; a thin spec produces a thin result.
2. **Cheapest capable role first.** Don't reach for `executor` when `mech-executor` covers it,
   and don't delegate at all for single-file reads or quick judgment calls the orchestrator can
   make directly — delegation overhead exceeds the savings below a certain size.
3. **Bounded escalation.** After two failed attempts at a role, escalate one tier or take the
   work over directly. Never retry the same tier a third time.
4. **Models come from role bindings.** Never pass `model` when delegating to a defined role —
   an explicit `model` overrides the role's frontmatter binding and silently defeats tiered
   routing. Only ad-hoc calls that use no defined role declare `model` explicitly; never rely
   on inheriting the main session's model. (praxarch's route-guard hook enforces both.)
5. **Security routing is not optional.** Anything touching authentication, authorization, secrets,
   cryptography, or trust-boundary input validation goes to `security-executor`, full stop — this
   keeps benign defensive-security work away from safety classifiers tuned for general use, and
   keeps that code path held to one consistently careful standard. (An ad-hoc call — no defined
   role — that passes `model: "opus"` gets a warning instead of a block on a security-keyword
   match; every defined role gets the block. Route deliberately, don't rely on the warning as the
   check.)
6. **Verify before claiming done.** Non-trivial changes (anything beyond a trivial fix) get a
   `verifier` pass before you report completion. Verifier returns a structured verdict — gate on
   `verdict` and zero unresolved `critical`/`major` findings, not on prose tone.
   (praxarch's verify-gate hook enforces this on sessions with a large enough diff; see
   `PRAXARCH_SKIP_VERIFY` for the escape hatch on changes that don't warrant it.) A verdict from a
   **resumed** agent (e.g. continued via `SendMessage`) never reaches verify-gate on its own — no
   hook observes that reply. Run `praxarch record-verdict --session <id> --role <role>` with the
   agent's output (stdin or `--file`) instead of waiving; that's what keeps re-verification cheap
   without training you to reach for `PRAXARCH_VERIFY_WAIVED` on genuinely verified work.
   When the verifier or checker is reviewing a worker's PR, branch, or worktree rather than
   your own working tree, say so in the brief and tell it to set its verdict `scope` to
   `branch:<name>` — a missing scope counts as `session` and would clear your own gate for
   code it never read.
   **Scoped re-verify:** `verifier` remains mandatory for the first pass on any diff the gate would
   block on, and for anything security-sensitive. But once `verifier` REFUTEs and you fix the
   findings, dispatch the re-verify to `checker` instead of a fresh `verifier` sweep — carry the
   prior findings verbatim plus `git diff <verdict-time-ref>` (the diff since the REFUTED verdict),
   and instruct it to confirm each finding is resolved and check the fix for regressions, not redo
   the broad sweep. `checker` is also the right choice for a first-pass verification you want on a
   diff below verify-gate's non-trivial threshold. If `checker`'s scoped re-verify itself REFUTEs,
   escalate the next pass back to `verifier`. `checker` may also decline a dispatch before
   attempting verification — the diff exceeded its scope, or touched security-sensitive
   territory — in which case it returns plain text, not a verdict block, and you re-dispatch to
   `verifier` for a normal fresh pass.
   **Blind dispatch.** A verification dispatch must not carry your own claim about whether the work
   is correct. Give the verifier the diff (or a bundle path), the spec or task description, and the
   constraints. Never include "this is correct", "this should be fine", "I already checked X", "just
   a sanity check", or a summary of why the change works — item 1's "reasoning behind the ask" means
   why the work was requested, not your verdict on the result. Confirmation-bias injection is
   measured, and its size tracks model tier: framing a diff as bug-free in review metadata collapsed
   detection by 93.5 points in a small model (97.2% → 3.6%) and 59.9 points in a small reasoning
   model, while moving an opus-class model only 4.9 (arXiv:2603.18740, 2026-03). That gradient is
   precisely why a `checker` dispatch needs framing discipline at least as much as a `verifier` one.
   The single exception is the scoped re-verify, which by construction carries the prior findings —
   carry those verbatim, never your assessment of whether the fix resolved them.
7. **Scout findings are leads, not facts.** Sanity-check anything scout found that the plan
   actually depends on before acting on it.
8. **Parallel fan-out for independent units.** When you have three or more genuinely independent,
   fully-specifiable pieces of work, launch them together in worktree isolation rather than
   serially — see the `/fan-out` skill. Run one verifier pass over the merged result, not one
   per worker.
9. **Invalid results are loud, never folded in.** A subagent result with zero tool calls, an
   empty body, or placeholder text is invalid — relaunch it once, then report it as failed;
   never fold an invalid result into a synthesis. After any fan-out, report per-agent status
   (agent | tool calls | outcome) before writing the merged result. (Incidents: a scout
   returned a 0-tool-call placeholder; a verifier died on a structured-output retry cap.)

### Workflow sizing and cache economics (added 2026-08-30 from the usage audit)

- **Size workflow fan-outs deliberately.** Over the audited 30 days, `workflow-subagent`
  dispatches were 94% of all subagent requests (10,489 of 11,153) and roughly 40% of total
  cache token volume, with one parent session fanning out 704 agents wide. Keep Workflow
  runs within the configured size guideline (medium, under 10 agents) unless the task genuinely
  warrants more — width beyond the guideline is an explicit per-run decision, never a
  default. Prefer `pipeline()` over full-width `parallel()` when stages gate each other.
- **Batch subagent work inside the 5-minute cache window.** Subagent prefixes cache at the
  5-minute TTL (main sessions get 1 hour), so a dispatch running past ~5 minutes wall-clock
  re-writes its prefix on later requests. Scope each dispatch so its unit of work completes
  within the window, or split a long task into sequential short dispatches against a warm
  prefix. Audited incidence: 573 dispatches exceeded the window in 30 days (~22M tokens of
  measured TTL-forced re-writes).

### Retained locally (do not delegate)

- Single-file reads and quick lookups you can answer directly.
- Final architectural and design decisions.
- User-directed judgment calls — the user is talking to the orchestrator, not a subagent.

<!-- praxarch:orchestration:end -->
