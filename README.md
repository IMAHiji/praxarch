# praxarch

A multi-model orchestration harness for [Claude Code](https://claude.com/product/claude-code):
a frontier model plans, delegates, and reviews in your main session, while cheaper
role-pinned subagents (haiku/sonnet/opus) do the volume work — with hooks that
**enforce** the delegation policy instead of just hoping the model follows it.

Derived from [pilotfish](https://github.com/Nanako0129/pilotfish) (MIT), whose role/policy/settings
layering praxarch keeps wholesale. Praxarch adds what pilotfish's own design doc names as future
work: enforcement hooks, measured telemetry, structured (machine-checkable) verification,
per-project overrides, and a first-class parallel fan-out pattern. See [`docs/design.md`](docs/design.md)
for the full rationale and the delta from pilotfish.

繁體中文版：[README.zh-TW.md](README.zh-TW.md)

## What you get

- **Ten role-based subagents** (`scout`, `Explore` override, `mech-executor`, `executor`,
  `verifier`, `checker`, `security-executor`, `planner`, `implementer`, `plan-reviewer`), each
  pinned to a cost-appropriate model tier via frontmatter, named in policy — never by model ID —
  so the whole thing survives model deprecations untouched. `checker` is a sonnet-tier
  counterpart to opus `verifier`, scoped to re-verification after a REFUTED verdict and
  sub-threshold first-pass verification.
- **Enforcement hooks**, not just policy text:
  - `route-guard` hard-denies ad-hoc fan-out delegations with no explicit model, and
    security-flavored work not routed to `security-executor` — except for `executor`
    (`routeGuard.softDenyRoles`, config-extensible), where the same rule is a warning, not a
    block: `executor` shares `security-executor`'s model tier, so the deny there bought process
    overhead, not real classifier avoidance.
  - `verify-gate` blocks session completion on non-trivial diffs with no `CONFIRMED`,
    zero-critical/major verifier record on file (escape hatches included).
  - `telemetry` logs every delegation to JSONL, including the verifier's structured verdict.
  - `session-init` warns on config drift and `CLAUDE_CODE_SUBAGENT_MODEL` conflicts.
- **Structured verification**: the verifier role must emit a JSON verdict block
  (`CONFIRMED`/`REFUTED` + findings), not free-form prose, so the gate can check it mechanically.
- **Telemetry surfaces**: a status line showing live role-spend for the current session and
  verify-gate state (no verdict on record, verified/unverified, a standing waiver, blocks already
  spent this stop cycle), and a `praxarch report` CLI / `/praxarch-report` skill for historical role
  distribution and verifier pass rate.
- **Per-project overrides**: `.claude/praxarch.json` in any repo can retune verify-gate
  thresholds and route-guard strictness for that project. Role→model bindings are retuned the
  native way instead: shadow the agent file in `<project>/.claude/agents/`.
- **`/fan-out` skill**: the pattern for running several independent, fully-specified units of work
  concurrently in isolated git worktrees, with a single verification pass over the merged result.
- **`/orchestrate` skill**: a tiered plan/implement/review pipeline — a high-tier `planner` writes
  an implementation plan, you approve it, `implementer` executes it task-by-task (dispatching
  independent tasks in parallel via worktree isolation, same as `/fan-out`), and a high-tier
  `plan-reviewer` verifies the merged result.
- **`/issues` skill**: dispatches `planner` to draft tracker-grade issues from a task or roadmap,
  presents the drafts verbatim for approval, then creates them on the repo's GitLab or GitHub
  tracker (`glab`/`gh`, detected from `git remote get-url origin`) with `{{issue:slug}}`
  cross-references resolved to real issue numbers in dependency order. Nothing is posted without
  an explicit, separate approval step.

## Install

Requires Node.js and [pnpm](https://pnpm.io).

```sh
git clone git@gitlab.com:IMAHiji/praxarch.git
cd praxarch
pnpm install
pnpm build
node dist/cli/index.js install
```

This shows a plan of every file it would create or change under `~/.claude/` — nothing is written
until you confirm (or pass `--yes` for scripted use). Anything it overwrites is backed up first as
`<file>.praxarch-backup-<timestamp>`. It will **not** overwrite a `model`/`fallbackModel` you've
already set (e.g. via `/model`) — it only sets those if absent.

To use the `praxarch` command directly instead of `node dist/cli/index.js` (pnpm ≥ 10 dropped
`pnpm link --global`; use `link:` so the global install symlinks back to this repo):

```sh
pnpm add -g link:$(pwd)
praxarch install
```

If pnpm reports its global bin directory is not in PATH, add it (e.g.
`export PATH="$HOME/Library/pnpm/bin:$PATH"` in your shell profile on macOS).

**This makes `pnpm build` an install.** `~/.claude/praxarch/hooks` (and `statusline`, `report`)
are directory symlinks straight into this checkout's `dist/`, so `pnpm build` in a linked checkout
overwrites the hooks your Claude Code session is actively running — with no prompt and no
confirmation. Checking out and building someone else's branch to review it, or building mid-refactor
on your own, puts that code live immediately. Use `pnpm verify` (below) to run the full build +
test suite against a scratch output instead, leaving `dist/` — and the live hooks — untouched.
`praxarch doctor` reports if the installed hooks' build ref no longer matches this checkout's
HEAD. **To recover:** `git checkout main && pnpm build` restores the live hooks to merged code.

Prefer a manual, code-free install? See [`install/AGENT-INSTALL.md`](install/AGENT-INSTALL.md) —
paste it into a Claude Code session and it walks through the same changes by hand.

### Check the install

```sh
praxarch doctor
```

Reports which pieces are wired up and whether the installed version matches the repo, including
how many session-state and debug-payload files are past their retention window.

```sh
praxarch doctor --prune
```

Deletes session state under `~/.claude/praxarch/state/` older than `PRAXARCH_STATE_RETENTION_DAYS`
(default 30) and debug payloads under `~/.claude/praxarch/debug/` older than
`PRAXARCH_DEBUG_RETENTION_DAYS` (default 7). The current session's own files are never touched.

### Uninstall

```sh
praxarch uninstall
```

Removes praxarch's hook entries, role/skill files, and `~/.claude/praxarch/`. Leaves
`model`/`fallbackModel` alone and leaves backups in place.

### Record a verdict

```sh
praxarch record-verdict --session <id> --role verifier < verdict-output.txt
praxarch record-verdict --session <id> --role verifier --file verdict-output.txt
```

Records a verdict role's trailing JSON verdict block into session state for verify-gate, for
verdicts that arrive outside a hookable event (e.g. a resumed agent's reply). Input is the full
text of the role's response, read from stdin or `--file`; the fenced JSON verdict block must be
the last thing in it.

## Using it

Once installed, delegate from your main Claude Code session using the ten roles — see the
orchestration policy praxarch adds to your global `CLAUDE.md` for the full delegation protocol
(complete specs, cheapest-role-first, bounded escalation, mandatory security routing, verify
before claiming done). Run `/praxarch-report` any time to see what's actually been delegated
and how verification is going. Use `/fan-out` when you have three or more independent,
fully-specifiable units of work to run in parallel, or `/orchestrate <task>` for a full
plan/implement/review pipeline on a larger task.

## Per-project configuration

Copy [`templates/project/praxarch.json`](templates/project/praxarch.json) to
`<project>/.claude/praxarch.json` and edit the keys you want to override. Every key is optional —
project config merges over your global `~/.claude/praxarch/config.json`, which merges over
built-in defaults.

## Development

```sh
pnpm typecheck
pnpm lint
pnpm build
pnpm test
```

`pnpm build` writes to `dist/`, which a dev-mode symlink install (above) serves live — so this
loop is fine while you're building your own checkout, but it is not how to verify someone else's
branch. Use `pnpm verify` for that instead: it builds to a scratch directory outside `dist/` and
runs the suite against it, leaving `dist/` (and the live install) completely untouched.

```sh
pnpm verify
```

Hooks and the CLI are tested by spawning the compiled output against a fake `$HOME`/`PRAXARCH_HOME`
— see `src/**/*.test.ts`. No test touches your real `~/.claude/`.

## License

MIT — see [`LICENSE`](LICENSE). Role/policy/settings layering derived from
[pilotfish](https://github.com/Nanako0129/pilotfish) (MIT, Nanako0129).
