# praxarch agent install runbook

You are being asked to install praxarch (https://github.com/IMAHiji/praxarch) into a user's global
Claude Code configuration. Praxarch is a config + hooks orchestration harness — six role-based
subagents, an orchestration policy, and enforcement hooks (route-guard, telemetry, verify-gate,
session-init) wired into `~/.claude/settings.json`.

**This is the manual/paste-a-prompt install path.** The preferred path is the checked-in `praxarch`
CLI (`praxarch install`), which shows the same plan and does the same work with less room for
transcription error. Use this runbook only when the user specifically wants the CLI-free path, or
is inspecting exactly what would change before trusting the CLI.

## Before you do anything

1. Clone or already have a local copy of `https://github.com/IMAHiji/praxarch` — you need its
   `templates/` directory. If the user hasn't given you a local path, ask for one or clone it
   (`git clone git@github.com:IMAHiji/praxarch.git` or the HTTPS equivalent) to a scratch
   directory. Do not fetch and apply raw file contents over the network sight-unseen — read what
   you're about to install.
2. Read every file you're about to install (agents/*.md, claude-md.orchestration.md,
   settings.fragment.json) so you can explain each one, not just copy it blind.

## What installing changes

- `~/.claude/settings.json` — merges `model`, `fallbackModel`, `statusLine`, and four hook entries
  (SessionStart, PreToolUse, PostToolUse, Stop) additively. **Never overwrite `model` or
  `fallbackModel` if the user already has a value set** — that's their explicit choice (e.g. from
  `/model`), and clobbering it is exactly the kind of surprise this runbook exists to prevent.
  Only add hook entries that aren't already present (dedupe by command string).
- `~/.claude/CLAUDE.md` — inserts the orchestration policy block between
  `<!-- praxarch:orchestration:start -->` / `<!-- praxarch:orchestration:end -->` markers. If the
  markers already exist, replace only the content between them.
- `~/.claude/agents/{scout,Explore,mech-executor,executor,verifier,security-executor}.md` — copy
  from `templates/agents/`.
- `~/.claude/skills/{praxarch-report,fan-out}/SKILL.md` — copy from `templates/skills/`.
- `~/.claude/praxarch/` — compiled hooks (`pnpm build` in the repo first, then copy `dist/hooks/`,
  `dist/statusline/`, `dist/report/`), plus a `config.json` with defaults and a `VERSION.json`.

## Procedure

1. Show the user a plan: for each file above, state whether it's new or would overwrite something,
   and for settings.json specifically state the exact diff (added keys, added hook commands) —
   do not summarize this away.
2. **Back up before writing.** Any existing file you're about to change gets copied to
   `<file>.praxarch-backup-<ISO-timestamp>` first.
3. Get explicit approval before writing anything. This mirrors the CLI's confirmation prompt —
   don't skip it because you're doing this by hand instead.
4. Apply the changes exactly as planned. If `pnpm`/`node` aren't available to build the hooks,
   say so and stop rather than installing hook wiring that points at nonexistent scripts.
5. Report what changed and where the backups are.

## Idempotency

Re-running this procedure should be safe: settings.json merges should skip keys/hooks already
present, and the CLAUDE.md block should be replaced in place rather than duplicated. If you're
not confident your manual edit preserves that property, prefer running `praxarch install`
(idempotent by construction, and tested) instead of hand-editing a second time.

## Pinning

If the user wants to pin to a specific release rather than tracking `main`, clone at a tag:
`git clone --branch vX.Y.Z --depth 1 <repo-url>`. Check `~/.claude/praxarch/VERSION.json` against
the repo's `VERSION` file to detect drift (`praxarch doctor` also does this automatically).
