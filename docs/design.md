# Design rationale

繁體中文版：[design.zh-TW.md](design.zh-TW.md)

## Starting point: pilotfish

[Pilotfish](https://github.com/Nanako0129/pilotfish) established the shape praxarch keeps:

1. **Settings layer** (`~/.claude/settings.json`) — model aliases (`best`) and a fallback chain,
   so the config survives model deprecations without edits.
2. **Role layer** (`~/.claude/agents/*.md`) — six roles, each pinned to a cost-appropriate model
   tier via frontmatter: `scout` (recon), `Explore` (override of the built-in agent, which
   otherwise silently inherits the main session's model), `mech-executor` (fully-specified
   mechanical work), `executor` (judgment-requiring work), `verifier` (fresh-context adversarial
   review), `security-executor` (auth/secrets/crypto, deliberately kept off the frontier model so
   its safety classifiers don't refuse benign defensive-security work).
3. **Policy layer** (`~/.claude/CLAUDE.md`) — delegation rules written entirely in role names,
   never model IDs, so role→model bindings can change underneath the policy without touching it.

Pilotfish's own design document is unusually honest about what it deliberately left out:
per-project config, enforcement hooks, and pinned model IDs, on the grounds that "policy-only
works first; machinery is the documented next step if discipline slips." That's the entry point
for praxarch: build the machinery pilotfish named but didn't build, without discarding the parts
that already work.

## What praxarch adds, and why

### Enforcement hooks, not just policy text

Policy text is cheap to write and easy to ignore under pressure — a long session, a frustrated
user, a model that decides the rule doesn't apply "this once." Praxarch wires four Claude Code
hooks that check the two rules most worth enforcing mechanically:

- **`route-guard`** (PreToolUse on the Agent tool) hard-denies two specific failure modes: an
  ad-hoc fan-out delegation with no explicit `model` (which would otherwise silently inherit the
  main session's — often frontier-tier — model), and a delegation that looks security-sensitive
  (keyword-matched) but isn't routed to `security-executor`. Both checks are deliberately narrow:
  broad "is this a good delegation" judgment stays a policy matter, not a hook matter, because
  that judgment needs context a keyword match can't have.
- **`verify-gate`** (Stop) blocks session completion when the working-tree diff is large enough to
  count as non-trivial (configurable thresholds) and no `CONFIRMED` verifier record with zero
  critical/major findings is on file for the session. Two escape hatches exist on purpose —
  `PRAXARCH_SKIP_VERIFY=1` and an explicit `PRAXARCH_VERIFY_WAIVED: <reason>` in the final
  message — because a hard gate with no escape becomes something users route around by lying to
  it, which is worse than no gate.
- **`telemetry`** (PostToolUse) and **`session-init`** (SessionStart) don't enforce anything; they
  observe and warn. Enforcement only applies to the two rules where a false negative (an
  unenforced violation) is worse than a false positive (an occasional unnecessary block).

Every enforcing hook fails open on its own internal errors — a bug in route-guard must never trap
a session in a state where no Agent call can succeed.

### Structured verification

Pilotfish's verifier returns free-form CONFIRMED/REFUTED prose. That's fine for a human reading the
transcript, but it can't be gated on mechanically — "did it say something that sounds like
CONFIRMED" is not the same check as "did it confirm." Praxarch's verifier role is contractually
required to end its response with a fenced JSON block:

```json
{ "verdict": "CONFIRMED", "findings": [] }
```

`telemetry` parses this out of the tool output and both records it in session state (for
`verify-gate` to check immediately) and appends it to the JSONL log (for `praxarch report` to
compute a pass rate across history). The verdict is derived, not asserted: `CONFIRMED` requires
zero `critical`/`major` findings, regardless of what the `verdict` field itself claims — a defense
against a verifier that writes "CONFIRMED" out of habit while listing a critical finding.

### Telemetry: measured, not claimed

Pilotfish cites benchmark numbers (e.g. "Sonnet workers at 96% of all-Fable performance for 46% of
the cost") as the expected payoff of tiered delegation, but nothing in the tool itself measures
*your* actual role distribution or savings. Praxarch's `telemetry` hook logs every delegation
(role, model, timestamp, verifier verdict where applicable) to a monthly JSONL file; the status
line surfaces the current session's counts live, and `praxarch report` aggregates role
distribution and verifier pass rate across history.

**What this deliberately does not claim**: a "delegation-vs-local ratio" or "escalation
frequency." Both would require observing the main session's own direct work and linking repeated
delegations as retries of the same task — neither is derivable from what a PostToolUse hook on the
Agent tool can see. An earlier draft of the `/praxarch-report` skill promised these; it was
corrected once the actual telemetry schema made clear they couldn't be honestly computed. Reporting
a number that looks measured but is actually guessed is worse than not reporting it.

**A related known gap**: Claude Code's PostToolUse hook does not expose token usage or duration
for a subagent run (confirmed against the hooks documentation while building this). Delegation
records are role/model/outcome only — no cost figures. If Claude Code exposes usage data at this
hook in the future, the schema should be extended rather than estimated around.

### Per-project overrides

Pilotfish is global-only by design, on the grounds that an audit of real projects found zero
project-level model policy in the wild. Praxarch adds a narrow, optional override surface —
`.claude/praxarch.json` — scoped to exactly the three things a project might legitimately need to
retune: role→model bindings, verify-gate thresholds (a doc-heavy repo's "non-trivial" diff size
differs from a monorepo's), and route-guard strictness/extra security keywords. It does not
duplicate the policy layer — delegation *rules* still live in CLAUDE.md, stacked per Claude Code's
native project/global memory behavior; `praxarch.json` only tunes the hooks' thresholds.

### Parallel fan-out

No new mechanism was needed here — Claude Code's Agent tool already supports
`isolation: "worktree"`. What was missing was a named pattern: when fan-out is worth the
coordination overhead (three or more independent, fully-specifiable units), how to tag the batch
for telemetry (`[fanout:<batch-id>]` in each call's description), and the rule that a fan-out gets
*one* verification pass over the merged result, not one per worker. This is codified as the
`/fan-out` skill rather than a hook, because "is this actually independent work" is a judgment call
a hook can't safely make.

## Known limitations

- **No token/cost telemetry** (see above) — logged data is role/model/outcome only.
- **Report metrics are intentionally narrower than pilotfish's claims** — role distribution and
  verifier pass rate only, not savings percentages or escalation frequency.
- **`verify-gate`'s diff-size heuristic is a proxy, not a semantic judgment** — a large
  formatting-only diff can trigger it unnecessarily (mitigated by `ignorePatterns` and the waiver
  escape hatch); a small but behaviorally significant change can slip under the threshold
  (mitigated by policy still asking for verification regardless of gate enforcement).
- **`route-guard`'s security-keyword match is a blunt instrument** — false positives are possible
  on prose that happens to mention a keyword without being security-sensitive work; `strict: false`
  in a project's `praxarch.json` downgrades denials to warnings if this proves too noisy for a
  given codebase.
