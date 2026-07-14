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

- **Six role-based subagents** (`scout`, `Explore` override, `mech-executor`, `executor`,
  `verifier`, `security-executor`), each pinned to a cost-appropriate model tier via frontmatter,
  named in policy — never by model ID — so the whole thing survives model deprecations untouched.
- **Enforcement hooks**, not just policy text:
  - `route-guard` hard-denies ad-hoc fan-out delegations with no explicit model, and
    security-flavored work not routed to `security-executor`.
  - `verify-gate` blocks session completion on non-trivial diffs with no `CONFIRMED`,
    zero-critical/major verifier record on file (escape hatches included).
  - `telemetry` logs every delegation to JSONL, including the verifier's structured verdict.
  - `session-init` warns on config drift and `CLAUDE_CODE_SUBAGENT_MODEL` conflicts.
- **Structured verification**: the verifier role must emit a JSON verdict block
  (`CONFIRMED`/`REFUTED` + findings), not free-form prose, so the gate can check it mechanically.
- **Telemetry surfaces**: a status line showing live role-spend for the current session, and a
  `praxarch report` CLI / `/praxarch-report` skill for historical role distribution and verifier
  pass rate.
- **Per-project overrides**: `.claude/praxarch.json` in any repo can retune verify-gate
  thresholds and route-guard strictness for that project. Role→model bindings are retuned the
  native way instead: shadow the agent file in `<project>/.claude/agents/`.
- **`/fan-out` skill**: the pattern for running several independent, fully-specified units of work
  concurrently in isolated git worktrees, with a single verification pass over the merged result.

## Install

Requires Node.js and [pnpm](https://pnpm.io).

```sh
git clone git@github.com:IMAHiji/praxarch.git
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

Prefer a manual, code-free install? See [`install/AGENT-INSTALL.md`](install/AGENT-INSTALL.md) —
paste it into a Claude Code session and it walks through the same changes by hand.

### Check the install

```sh
praxarch doctor
```

Reports which pieces are wired up and whether the installed version matches the repo.

### Uninstall

```sh
praxarch uninstall
```

Removes praxarch's hook entries, role/skill files, and `~/.claude/praxarch/`. Leaves
`model`/`fallbackModel` alone and leaves backups in place.

## Using it

Once installed, delegate from your main Claude Code session using the six roles — see the
orchestration policy praxarch adds to your global `CLAUDE.md` for the full delegation protocol
(complete specs, cheapest-role-first, bounded escalation, mandatory security routing, verify
before claiming done). Run `/praxarch-report` any time to see what's actually been delegated
and how verification is going. Use `/fan-out` when you have three or more independent,
fully-specifiable units of work to run in parallel.

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

Hooks and the CLI are tested by spawning the compiled output against a fake `$HOME`/`PRAXARCH_HOME`
— see `src/**/*.test.ts`. No test touches your real `~/.claude/`.

## License

MIT — see [`LICENSE`](LICENSE). Role/policy/settings layering derived from
[pilotfish](https://github.com/Nanako0129/pilotfish) (MIT, Nanako0129).
