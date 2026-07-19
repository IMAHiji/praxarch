# Changelog

## Unreleased

### Added

- **route-guard: `routeGuard.knownRoles` config extends the defined-role set.** The built-in six
  roles are praxarch's own; agents installed by other tools with their own frontmatter bindings
  (orchestrate's planner/implementer/plan-reviewer, plugin agents) were caught by the ad-hoc rule:
  strict mode denied them for lacking `model`, and passing `model` to satisfy it overrides the
  binding the guard exists to protect. Config-listed roles now get the same treatment as built-ins
  (frontmatter owns the model; explicit `model` is denied). Additive merge, like
  `securityKeywords`.
- **route-guard: `routeGuard.reviewRoles` generalizes the verifier security exemption.** The
  2026-07-08 exemption was hardcoded to `subagent_type === "verifier"`, so other read-only
  review agents (pr-review-toolkit's reviewers) hit the identical deadlock: reviewing
  auth/secrets code mentions the keywords, strict mode denies the dispatch. Config-listed
  review roles are now exempt alongside verifier; additive merge over the default
  `["verifier"]`, so the canonical exemption can be extended but never dropped.

## v0.1.1 — 2026-07-13

Fixes driven by the first week of live telemetry (includes the previously uncommitted
payload-handling fixes shipped in `d271412`).

### Fixed

- **route-guard: `verifier` is exempt from the security-keyword redirect.** A verifier reviewing
  auth/secrets/crypto changes necessarily mentions those keywords, and blocking it deadlocked
  against verify-gate, which requires a verifier pass on exactly those diffs. This exemption was
  approved and hand-patched into the live install on 2026-07-08 but never made it into source —
  reinstalling would have silently regressed it.
- **doctor: byte-compares installed hooks/statusline/report against the repo's dist build** instead
  of trusting VERSION strings. A stale install (exactly what happened with the `d271412` fixes)
  previously passed doctor 20/20.
- **session-init/doctor/uninstall: check `explore.md` (lowercase)**, matching the file the
  installer actually writes. The old `Explore.md` check only passed on case-insensitive
  filesystems, and uninstall silently orphaned the file elsewhere.
- **README: global CLI install uses `pnpm add -g link:$(pwd)`** — pnpm ≥ 10 removed
  `pnpm link --global`, so the documented command failed outright on current pnpm.

### Changed

- **route-guard: denies explicit `model` on defined-role delegations.** Live telemetry showed
  40/40 delegations passing `model` explicitly, silently overriding every role's frontmatter
  binding and defeating tiered routing. Policy rule 4 reworded to match: models come from role
  bindings; only ad-hoc (role-less) calls declare `model`.

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
