<!-- praxarch:orchestration:start -->
## Orchestration (praxarch)

Delegation policy for code work — full version in `~/.claude/praxarch/POLICY.md`
(roles, the delegation protocol, rationale). Read it before any non-trivial delegation.
Four rules decide things before you get there:

- **Plan high, execute low — hard rule for code work** (content, research and instruction-file
  prose stay with the main session). Planning runs at the highest tier available and
  ends in a *written* plan, never an in-context handoff. Execution always runs at a
  lower-tier role, never the orchestrator itself — being the highest-tier session is a
  reason to delegate, not licence to do it yourself.
- **Security routing is not optional.** Auth, authz, secrets, crypto, trust-boundary
  validation → `security-executor`, always.
- **Never pass `model` to a defined role** — it overrides the role's frontmatter binding
  and silently defeats tiered routing. (`route-guard` enforces this.)
- **Retained locally:** single-file reads, final architectural decisions, user-directed
  judgment calls. Delegation overhead exceeds the savings below that line.

<!-- praxarch:orchestration:end -->
