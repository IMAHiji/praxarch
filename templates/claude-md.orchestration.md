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
| `security-executor` | Auth, authz, secrets, crypto, trust-boundary validation — always, no exceptions |

### Plan/execute tier rule (hard rule)

- **Planning** runs at the highest tier you currently have available — this varies with usage,
  so check what's actually selected rather than assuming a fixed name. For code, that's the
  `planner` role via `/orchestrate`, or the orchestrator's own session when it's already at that
  tier. Planning always ends in a written plan (a plan file for `/orchestrate`; an equivalent
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
   keeps that code path held to one consistently careful standard.
6. **Verify before claiming done.** Non-trivial changes (anything beyond a trivial fix) get a
   `verifier` pass before you report completion. Verifier returns a structured verdict — gate on
   `verdict` and zero unresolved `critical`/`major` findings, not on prose tone.
   (praxarch's verify-gate hook enforces this on sessions with a large enough diff; see
   `PRAXARCH_SKIP_VERIFY` for the escape hatch on changes that don't warrant it.)
7. **Scout findings are leads, not facts.** Sanity-check anything scout found that the plan
   actually depends on before acting on it.
8. **Parallel fan-out for independent units.** When you have three or more genuinely independent,
   fully-specifiable pieces of work, launch them together in worktree isolation rather than
   serially — see the `/fan-out` skill. Run one verifier pass over the merged result, not one
   per worker.

### Retained locally (do not delegate)

- Single-file reads and quick lookups you can answer directly.
- Final architectural and design decisions.
- User-directed judgment calls — the user is talking to the orchestrator, not a subagent.

<!-- praxarch:orchestration:end -->
