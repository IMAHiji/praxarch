# Changelog

## v0.1.0 — 2026-07-08

Initial release. A config + hooks orchestration harness for Claude Code, derived from
[pilotfish](https://github.com/Nanako0129/pilotfish) and extending it with the machinery its own
design doc named as future work. See [`docs/design.md`](docs/design.md) for full rationale.

### Added

- Six role-based subagent templates (`scout`, `Explore` override, `mech-executor`, `executor`,
  `verifier`, `security-executor`), an orchestration policy fragment for `CLAUDE.md`, and a
  settings fragment wiring model aliases and hooks — pilotfish-parity, adapted rather than copied.
- Four enforcement hooks: `route-guard` (hard-denies unmodeled fan-out and misrouted
  security-sensitive delegations), `verify-gate` (blocks completion on non-trivial diffs without a
  confirmed verifier pass, with `PRAXARCH_SKIP_VERIFY`/waiver escape hatches), `telemetry`
  (JSONL delegation log + structured verifier verdict parsing), `session-init` (drift and env
  warnings). All fail open on internal error.
- Structured verification contract: the verifier role emits a JSON verdict block instead of
  free-form prose, so the gate and reports can check it mechanically.
- Telemetry surfaces: a live status line and a `praxarch report` CLI / `/praxarch-report` skill
  reporting role distribution and verifier pass rate from logged history.
- Per-project overrides via `.claude/praxarch.json` (role→model bindings, verify-gate thresholds,
  route-guard strictness), merged over global config, merged over built-in defaults.
- `/fan-out` skill for running independent, fully-specifiable work in parallel worktrees with a
  single merged-result verification pass.
- `praxarch install` / `uninstall` / `doctor` CLI: idempotent, additive settings.json merging
  (never overwrites an existing `model`/`fallbackModel`), automatic backups of anything changed,
  plan-then-confirm flow. `install/AGENT-INSTALL.md` as a manual, code-free alternative.
- 30 tests covering every hook, the config merge/override precedence, and a full
  install→doctor→uninstall cycle against a fake `$HOME`.
