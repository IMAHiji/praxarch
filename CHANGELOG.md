# Changelog

## Unreleased

### Added

- **`/orchestrate` skill and pipeline roles ported in-repo.** praxarch now ships its own
  plan/implement/review pipeline: `planner` (writes an implementation plan), `implementer`
  (executes one task from it), and `plan-reviewer` (verifies the merged result) — previously an
  external dependency on the cognex-agents work repo. Independent tasks (`Depends on: independent`
  in the plan) are dispatched in parallel worktrees when there are two or more ready at once, same
  isolation pattern as `/fan-out`, with a single `plan-reviewer` pass over the merged result rather
  than one per task. `plan-reviewer`'s JSON verdict block is now a built-in `verifyGate.verdictRoles`
  and `routeGuard.reviewRoles` entry, so a project's own config no longer needs to add it. (Note:
  `README.zh-TW.md` hasn't been updated for this change yet.)
- **route-guard: `routeGuard.knownRoles` config extends the defined-role set.** The built-in nine
  roles are praxarch's own; agents installed by other tools with their own frontmatter bindings
  (plugin agents) were caught by the ad-hoc rule: strict mode denied them for lacking `model`,
  and passing `model` to satisfy it overrides the binding the guard exists to protect.
  Config-listed roles now get the same treatment as built-ins (frontmatter owns the model;
  explicit `model` is denied). Additive merge, like `securityKeywords`.
- **telemetry/verify-gate: `verifyGate.verdictRoles` lets non-verifier reviews satisfy the gate.**
  Telemetry recorded trailing JSON verdicts only from the `verifier` role, so an /orchestrate
  run's plan-reviewer pass went unrecorded and verify-gate demanded a second review at session
  stop. Roles listed in `verifyGate.verdictRoles` (additive over the default
  `["verifier", "plan-reviewer"]`) now get their verdict blocks recorded; the added role's report
  contract must end with the verifier template's JSON verdict block.
- **route-guard: `routeGuard.reviewRoles` generalizes the verifier security exemption.** The
  2026-07-08 exemption was hardcoded to `subagent_type === "verifier"`, so other read-only
  review agents (pr-review-toolkit's reviewers) hit the identical deadlock: reviewing
  auth/secrets code mentions the keywords, strict mode denies the dispatch. Config-listed
  review roles are now exempt alongside verifier; additive merge over the default
  `["verifier", "plan-reviewer"]`, so the canonical exemption can be extended but never dropped.

### Fixed

- **verify-gate: the loop-guard counter and the recorded verdict are now both self-invalidating.**
  Two related holes let the Stop gate silently stop enforcing: (1) the consecutive-block counter
  was never cleared on a genuine allow path, so it could accumulate across unrelated stop cycles;
  worse, a *stale but unrelated* trip count could suppress enforcement of a batch of new,
  unverified work the guard had never actually seen — the counter is now cleared on every genuine
  allow path and whenever `stop_hook_active` is false, and additionally reset whenever the diff
  fingerprint (below) shows the tree has changed since the blocks that tripped it, so a fresh diff
  always gets its own count. It deliberately still does **not** clear on the loop-guard's own
  fail-open: once tripped in a cycle it stays tripped against an *unchanged* diff, by design —
  that's the bounded "2 blocks then quiet" guarantee working, not a bug. (2) a CONFIRMED verdict
  authorized every later diff in the session regardless of how much changed after it was recorded
  — telemetry now fingerprints the diff (a content hash, computed with a 64MB `maxBuffer` so large
  patches don't silently fail closed to "no change," plus changed-lines/changed-files counts)
  alongside the verdict, and verify-gate treats it as stale (falls through to blocking) once the
  hash differs *or is unknown* (e.g. the patch still exceeded the buffer) *and* the size delta
  since it was recorded clears `minChangedLines`/`minChangedFiles`. Verdicts recorded before this
  change (the `diffHash` field is entirely absent) are accepted unchanged — only in-flight
  sessions can hold one; a verdict whose hash was recorded but couldn't be computed (`diffHash`
  present but `null`) does *not* get that same pass. Known residual limit: the size-delta rule
  detects growth, not same-size in-place rewrites — documented in `docs/design.md`. Every fail-open
  (loop-guard or crash) is now logged to the monthly JSONL and surfaced via `systemMessage`, and
  `praxarch report` excludes those log rows from delegation stats and adds a
  `Verify-gate fail-opens: N` line.
- **verify-gate: the loop guard now has a second counter that continuous tree churn can't reset.**
  The consecutive-block counter above resets whenever the diff fingerprint changes, which is
  correct for a genuinely new batch of unverified work — but it also meant a session touching one
  file per round (a scratch edit, a formatter run) could block every single round without the
  counter ever reaching its limit: an unsatisfiable gate that never failed open, worse than the
  under-enforcement the whole change exists to fix. `verifyGateCycleBlocks` totals blocks across
  the whole stop cycle regardless of tree movement (limit 5) and fails open alongside the per-diff
  counter (limit 2, unchanged); the two reasons are distinguishable in both `systemMessage` and the
  JSONL row (`reason: "loop-guard"` vs `"loop-guard-cycle"`).
- **git-diff: `--no-ext-diff`/`--no-textconv` on every `git diff` call.** A `diff.external` config
  or an inherited `GIT_EXTERNAL_DIFF` env var replaced the patch text with whatever the external
  driver printed — including nothing — while `--numstat` was unaffected, collapsing the
  fingerprint to a real, constant value and silently reopening the exact hole the verdict-staleness
  fingerprint exists to close (600 unverified lines allowed past a CONFIRMED verdict, reproduced
  via both the git-config and env-var routes).
- **git-diff: untracked file contents are hashed as bytes, not decoded to utf8 first.** A lossy
  utf8 decode collapsed invalid byte sequences to U+FFFD before hashing, so distinct binary
  content could hash identically.
- **git-diff: the fingerprint is now lazy.** `diffStat` (counts only) and `diffFingerprint` (the
  hash — a full patch fetch plus every untracked file's contents, the expensive half) are separate
  functions; verify-gate only fingerprints past its trivial-diff early return, and telemetry only
  fingerprints when a verdict was actually parsed, instead of paying the cost of both on every
  Stop and every recorded verdict regardless of whether either was needed.

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
