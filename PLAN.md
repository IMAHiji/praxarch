# Praxarch — Build Plan

An orchestration harness for Claude Code, derived from [pilotfish](https://github.com/Nanako0129/pilotfish) (MIT, attribution required) but extending it from a **policy-only config kit** into a **config + hooks hybrid**: the same role/policy layering, plus the enforcement, telemetry, and verification machinery pilotfish explicitly deferred.

## Decisions (locked)

| Question | Decision |
|---|---|
| Form factor | Config + hooks hybrid (TypeScript hooks/scripts inside Claude Code) |
| Enforcement | Hooks enforce hard rules; policy covers soft judgment calls |
| Improvements | Cost/quota telemetry · per-project overrides · parallel fan-out + worktrees · structured verification |
| Home | Source repo in this directory; installs to `~/.claude/` |
| Roles | Pilotfish's six as-is: scout, Explore override, mech-executor, executor, verifier, security-executor |
| Telemetry surface | Status line + report command (JSONL-backed) |
| Verify gate | Hook-enforced: Stop hook blocks "done" on non-trivial diffs without a recorded verifier pass (with escape hatch) |
| Docs | English + 繁體中文 (zh-TW, Taiwan-standard vocabulary) |

## What pilotfish gets right (keep)

- **Three-layer separation**: settings (`model: "best"` + fallback chain) → roles (`agents/*.md` frontmatter pins tiers) → policy (CLAUDE.md speaks only in role names, never model IDs). Survives model deprecations untouched.
- **Six-role taxonomy** with cost/capability justification, including the Explore override (built-in Explore inherits the main-session model and burns frontier tokens on background searches).
- **Fresh-context adversarial verification** instead of self-critique.
- **Bounded escalation**: start cheapest, escalate after two failures, never three retries on one tier.
- **Complete-spec delegation protocol**: goal, constraints, success criteria, paths, reasoning — in one shot.
- **Security pre-routing**: security-sensitive work goes to security-executor (Opus) so frontier safety classifiers never see benign defensive tasks.

## What pilotfish is missing (build)

1. **Enforcement** — its own design doc admits hooks are "the documented next step if discipline slips." Policy text drifts in long sessions.
2. **Telemetry** — savings are claimed (46–74%), never measured per-session.
3. **Per-project layer** — global-only by design; real projects need role/policy tuning.
4. **Structured verification** — free-form CONFIRMED/REFUTED prose can't be gated on mechanically.
5. **Parallel fan-out** — no first-class pattern for concurrent executors in isolated worktrees.
6. **Real installer** — a "paste this prompt" runbook is clever but unauditable; ship checked-in code with the prompt as an alternative.

## Architecture

```
praxarch/                          # this repo (private, IMAHiji)
├── PLAN.md                        # this file
├── README.md / README.zh-TW.md
├── CHANGELOG.md · VERSION · LICENSE (MIT, pilotfish attribution)
├── package.json (pnpm) · tsconfig.json (strict) · eslint.config
├── src/
│   ├── hooks/
│   │   ├── route-guard.ts         # PreToolUse(Agent): hard rules
│   │   ├── telemetry.ts           # PostToolUse(Agent): JSONL delegation log
│   │   ├── verify-gate.ts         # Stop: block done-claims w/o verifier pass
│   │   ├── session-init.ts        # SessionStart: state file, env sanity checks
│   │   └── lib/                   # config merge, JSONL, session state, git diff sizing
│   ├── statusline/statusline.ts   # role-spend at a glance
│   ├── report/report.ts           # per-session + historical breakdowns
│   └── cli/                       # praxarch install | uninstall | doctor
├── templates/
│   ├── agents/                    # six role files (adapted from pilotfish)
│   ├── claude-md.orchestration.md # policy section for ~/.claude/CLAUDE.md
│   ├── settings.fragment.json     # model:"best", fallback chain, hook wiring
│   ├── skills/
│   │   ├── praxarch-report/       # /praxarch-report
│   │   └── fan-out/               # /fan-out parallel-executor pattern
│   └── project/praxarch.json      # per-project override schema example
├── install/AGENT-INSTALL.md       # pilotfish-style paste-a-prompt alternative
└── docs/design.md (+ .zh-TW)      # rationale, deltas from pilotfish
```

Installed footprint: `~/.claude/agents/*`, CLAUDE.md orchestration section, settings.json merge (hooks + statusline + model aliases), `~/.claude/praxarch/` (compiled hooks, logs, state).

## Component design

### Hooks (the enforcement layer)

- **route-guard** (PreToolUse on Agent) — *hard blocks*:
  - Fan-out Agent call with no explicit `model` and no `subagent_type` that pins one → deny with the correct role suggestion.
  - `subagent_type` matching a security-sensitive prompt heuristic (auth/secrets/crypto keywords) routed anywhere but security-executor → deny.
  - Warn-only: main session doing bulk mechanical edits (N+ Edit/Write calls to distinct files within a session window) that policy says belongs to mech-executor. Advisory to avoid false-positive friction.
- **telemetry** (PostToolUse on Agent) — append `{ts, session, role, model, duration, outcome}` to `~/.claude/praxarch/logs/YYYY-MM.jsonl`; parse the subagent transcript for token usage where available (open item — see Risks).
- **verify-gate** (Stop) — if session git diff exceeds a threshold (lines/files, configurable) and session state holds no verifier record with verdict `CONFIRMED`, block completion with instructions to run the verifier. Escape hatches: `PRAXARCH_SKIP_VERIFY=1` or an explicit waiver the user types.
- **session-init** (SessionStart) — create session state; warn if `CLAUDE_CODE_SUBAGENT_MODEL` is set (defeats tiered routing); detect template drift (doctor-lite).

All hooks: TypeScript, compiled to single-file executables at install time (fast startup — hooks run on every matching event), read a merged config (global `~/.claude/praxarch/config.json` ← project `.claude/praxarch.json`).

### Structured verification

Verifier agent template mandates a fenced JSON block as its final output:

```json
{ "verdict": "CONFIRMED | REFUTED",
  "findings": [{ "severity": "critical|major|minor", "file": "path", "line": 0,
                 "summary": "...", "failure_scenario": "inputs → wrong behavior" }] }
```

The telemetry hook parses it from the verifier's result, records it into session state (this is what verify-gate checks), and the policy instructs the orchestrator to gate on verdict + zero unresolved critical/major findings — not on prose vibes.

### Telemetry surfaces

- **Status line**: `praxarch ▸ scout×3 mech×1 exec×2 ✓verified` style live counts per role for the current session, from the JSONL tail.
- **/praxarch-report**: skill invoking `report.ts` — current-session breakdown, historical role distribution, delegation-vs-local ratio, escalation frequency, verification pass rate. This turns pilotfish's claimed savings into your measured numbers.

### Per-project overrides

`.claude/praxarch.json` in a project may override: role→model pinning (e.g., force executor to Sonnet in a low-stakes repo), verify-gate thresholds, route-guard strictness, extra security-routing keywords. Hooks merge project over global. Policy addenda go in the project's own CLAUDE.md as usual (Claude Code stacks memories natively).

### Parallel fan-out + worktrees

No new machinery needed — Claude Code's Agent tool already supports `isolation: "worktree"`. Deliverables are:
- **/fan-out skill**: the pattern — orchestrator writes N complete specs, launches N executors in worktree isolation in one block, collects results, runs one verifier over the merged diff, integrates.
- **Policy rules**: when fan-out is worth the overhead (≥3 independent, fully-specifiable units), explicit model on every fan-out call (route-guard enforces), single verification pass over the merge rather than per-worker.
- **Telemetry**: fan-out batches tagged in the log so reports show parallel vs serial delegation.

## Build phases

**Phase 0 — Scaffold.** `git init`, private GitHub repo (`IMAHiji/praxarch`), pnpm + TypeScript strict + ESLint, build tooling for single-file hook bundles.

**Phase 1 — Pilotfish parity.** Port and adapt the six agent templates, orchestration policy, settings fragment. Rewrite rather than copy verbatim; attribute in LICENSE/README. Manual install works end-to-end.

**Phase 2 — Hooks.** session-init → telemetry → route-guard → verify-gate, in that order (observe before you block). Each hook gets a fixture-driven unit test (hook stdin JSON → expected decision).

**Phase 3 — Telemetry surfaces.** Status line command + `/praxarch-report` skill over the JSONL logs.

**Phase 4 — Installer & doctor.** `praxarch install` (idempotent settings.json merge with plan-before-write), `uninstall`, `doctor` (drift, env-var conflicts, stale hooks). AGENT-INSTALL.md prompt variant for parity with pilotfish's UX.

**Phase 5 — Overrides & fan-out.** Project config merge in hooks; `/fan-out` skill; policy additions.

**Phase 6 — Docs & release.** README + design docs in EN and zh-TW (繁體，臺灣用語), CHANGELOG, tag v0.1.0.

Each phase ends with a live smoke test in a scratch project: run a real session, confirm routing, check the log, trip the gate on purpose.

## Risks / open items

- **Token counts in hooks**: PostToolUse payloads may not carry subagent token usage directly; may need to parse the transcript JSONL, or fall back to counting delegations + durations. Resolve empirically in Phase 2 — telemetry design degrades gracefully either way.
- **Stop-hook false positives**: diff-size threshold will misfire on generated files/lockfiles; needs ignore patterns and the waiver path from day one.
- **Settings.json merge safety**: installer must merge, never clobber, existing hooks/statusline config; show a diff and require confirmation (pilotfish's approval-gate pattern, but in code).
- **Alias drift**: `best` semantics and fallback chains are Anthropic-controlled; doctor should validate aliases still resolve.
- **Hook latency**: every Agent call pays route-guard + telemetry cost; keep bundles dependency-light and measure.
