<!-- praxarch:orchestration:start -->
## Orchestration (praxarch)

These rules govern how this session delegates. Subagents do not read them; the orchestrator
applies them. This section is the CLAUDE.md instruction that authorizes subagent use — the
harness default of "no subagents unless asked" is satisfied by it.

Roles are named, not modeled. Never write a model name in this policy; bindings live in
`~/.claude/agents/*.md` frontmatter. Each role's description in your tool list says what it is for.

### Hard rules

- **Plan high, execute low.** Planning runs at the highest tier available (the `planner` role via
  `/orchestrate`, or this session when it is already at that tier) and always ends in a written
  plan. Execution runs at a lower-tier role (`implementer`, `executor`, `mech-executor`) — never
  this session, even when this session is the highest tier. Only the "Retained locally" items
  below are exempt.
- **Models come from role bindings.** Never pass `model` when delegating to a defined role; an
  explicit `model` silently defeats tiered routing. Only ad-hoc calls with no defined role declare
  `model`. (route-guard enforces this.)
- **Security routing.** Authentication, authorization, secrets, cryptography, and trust-boundary
  validation go to `security-executor`, always. Security *review* goes to `verifier` as normal.
  (route-guard enforces this; a soft-deny warning is not a substitute for routing deliberately.)
- **One verification pass, then done.** Non-trivial changes get one fresh-context `verifier` pass
  before you report completion; gate on its `verdict` and zero unresolved `critical`/`major`
  findings, not on prose tone. That pass is the whole verification step: do not self-verify, re-run
  the verifier's checks, or dispatch a second reviewer unless the first REFUTEs. After a REFUTE and
  fix, the re-verify goes to `checker` with the prior findings verbatim; `checker` escalates back
  to `verifier` if it REFUTEs or declines. (verify-gate enforces the gate; `/orchestrate` and the
  verifier/checker prompts carry the procedure, including `praxarch record-verdict` for verdicts
  from resumed agents.)
- **Blind dispatch.** A verification dispatch carries the diff, the spec, and the constraints —
  never your own view of whether the work is correct. Framing a diff as bug-free measurably
  collapses defect detection, and more so on smaller models.

### Delegation protocol

1. **Complete specs.** Goal, constraints, success criteria, relevant paths, and why the work was
   asked for. Executor-tier models follow instructions literally and do not generalize from one
   item to the next — state scope explicitly ("every route file under `src/pages/api/`, not just
   the first").
2. **Cheapest capable role first**, and no delegation for work you can finish in a handful of tool
   calls. Every subagent re-establishes context and reports back; below a certain size that costs
   more than it saves.
3. **Brief once, then commit.** Give the whole spec up front. Once delegated, do not redo or
   re-derive the subagent's work.
4. **Bounded escalation.** After two failed attempts at a role, escalate one tier or take it over.
   Never retry the same tier a third time.
5. **Keep working while subagents run.** Launch independent agents in one message and continue on
   other tracks rather than blocking on each result.
6. **Fan out independent units.** Three or more independent, fully-specifiable pieces of work run
   together in worktree isolation (`/fan-out`), with one verifier pass over the merged result.
7. **Scout findings are leads, not facts.** Sanity-check anything the plan depends on.

`advisorModel` pairs every dispatch with a consult-only model; it is not an exception to the
`model` rule, never substitutes for a `verifier` pass, and is invisible to praxarch telemetry.

### Retained locally (do not delegate)

- Single-file reads and quick lookups you can answer directly.
- Final architectural and design decisions.
- User-directed judgment calls — the user is talking to the orchestrator, not a subagent.

<!-- praxarch:orchestration:end -->
