# Spec: advisor support in praxarch

Status: draft, unreviewed. Execution tier: mech-executor — every judgment call is made here;
if a step turns out to be ambiguous or wrong in practice, stop and report rather than improvise.

## Background

Claude Code's advisor feature (https://code.claude.com/docs/en/advisor.md) pairs a session with a
stronger model consulted mid-task at decision points. It is configured with a single settings key,
`advisorModel` — no agent files, no frontmatter. Subagents inherit the session's `advisorModel`,
paired against their own model. That inheritance is the whole point for praxarch: executor-tier
roles (sonnet-bound) get frontier consultation at decision moments without touching role bindings.

Decisions already made (do not revisit during execution):

- Ship `advisorModel: "opus"` enabled in the settings fragment, not commented out.
- The main session's `model: "best"` may reject or decline an opus advisor under the pairing rule
  (advisor must be ≥ main). This is acceptable — the value is in subagent inheritance. Do not
  attempt to detect or work around it in code.
- `advisorModel` is one global key; per-role advisor scoping does not exist. The policy text (not
  code) carries the checker-cost caveat.
- route-guard is unchanged: advisor use is not a per-dispatch input and advisor calls are
  server-side, invisible to PreToolUse/PostToolUse hooks. Telemetry is knowingly blind to advisor
  cost; that is documented, not fixed, in this change.

## Task 1 — settings fragment

File: `templates/settings.fragment.json`

Add one key, directly after the `"fallbackModel"` line, same indentation as its siblings:

```json
"advisorModel": "opus",
```

The installer only merges an explicit key list (`src/cli/lib/settings-merge.ts`), not the fragment's
top-level keys generically — `advisorModel` must be added to that list too, with the same
only-set-if-absent semantics as `model`/`fallbackModel`.

## Task 2 — statusline advisor indicator

File: `src/hooks/lib/paths.ts`

Add, after `agentsDir()` (keeping the function-not-constant convention documented at the top of
the file):

```ts
// Claude Code's own settings file — outside praxarch's tree, like agentsDir above.
// PRAXARCH_TARGET_CLAUDE_HOME mirrors cli/lib/paths.ts's override so tests can point it at a
// fixture directory.
export function claudeSettingsPath(): string {
  const home = process.env["PRAXARCH_TARGET_CLAUDE_HOME"] ?? join(homedir(), ".claude");
  return join(home, "settings.json");
}
```

File: `src/statusline/statusline.ts`

1. Import `claudeSettingsPath` from `../hooks/lib/paths.js` and `readFile` from
   `node:fs/promises`.
2. Add a helper above `main()`:

```ts
// The armed advisor silently changes the effective capability of every dispatch (subagents
// inherit advisorModel), so the statusline surfaces it. Any read/parse failure renders nothing —
// an absent indicator must never be distinguishable from a broken settings file here.
async function advisorPart(): Promise<string | null> {
  try {
    const raw = await readFile(claudeSettingsPath(), "utf8");
    const settings = JSON.parse(raw) as { advisorModel?: unknown };
    return typeof settings.advisorModel === "string" && settings.advisorModel.length > 0
      ? `adv:${settings.advisorModel}`
      : null;
  } catch {
    return null;
  }
}
```

3. In `main()`, after `parts.push(...gateParts(state));` and before the `summary` line:

```ts
const advisor = await advisorPart();
if (advisor !== null) parts.push(advisor);
```

Note the indicator renders only when a `session_id` was parsed (it sits on the existing
early-return path's far side); that is intended — keep it there.

File: `src/statusline/statusline.test.ts`

Add tests following the existing patterns in that file (same harness, temp dirs, env override):

- With `PRAXARCH_TARGET_CLAUDE_HOME` pointing at a fixture dir whose `settings.json` contains
  `{"advisorModel": "opus"}`, output contains `adv:opus`.
- With a fixture `settings.json` lacking the key, output does not contain `adv:`.
- With no `settings.json` at the fixture path, output does not contain `adv:` and the process
  still renders normally (no crash, still prefixed `praxarch ▸`).

## Task 3 — doctor check

File: `src/cli/doctor.ts`

Add a function after `checkEnv()`:

```ts
// Advisor health (see docs/spec-advisor.md). Three states:
// - not configured: informational pass — advisor is optional.
// - configured and kill switch set: fail — the setting looks armed but is silently inert.
// - configured, no kill switch: informational pass naming the model. Pairing validity against
//   each role's bound model is decided server-side per dispatch and can't be checked statically.
function checkAdvisor(settings: Record<string, unknown> | null): Check {
  const advisorModel = settings?.["advisorModel"];
  if (typeof advisorModel !== "string" || advisorModel.length === 0) {
    return { ok: true, message: "advisorModel is not configured (advisor disabled — optional)" };
  }
  if (process.env["CLAUDE_CODE_DISABLE_ADVISOR_TOOL"]) {
    return {
      ok: false,
      message: `advisorModel is "${advisorModel}" but CLAUDE_CODE_DISABLE_ADVISOR_TOOL is set — the advisor is silently disabled`,
    };
  }
  return { ok: true, message: `advisorModel is "${advisorModel}" — subagent dispatches inherit it` };
}
```

Wiring: `checkSettings()` currently returns only `Check[]`; `checkAdvisor` needs the parsed
settings object. Change `checkSettings()` minimally: at its end, after building `checks`, append
`checkAdvisor(settings)` to `checks` before returning (the `settings` object is already in scope
there). In every early-return branch of `checkSettings()` (absent / malformed / non-object), also
append `checkAdvisor(null)` to the returned array so the advisor line always renders. Do not
change `doctor()`'s check list.

Tests: `src/cli/cli.test.ts` (or wherever `checkSettings`/doctor output is currently asserted —
match the existing doctor test location; if doctor has no direct tests, add none rather than
building a new harness).

## Task 4 — orchestration template text

File: `templates/claude-md.orchestration.md`

Append this bullet to the existing rule list (same bullet style as its neighbors, placed last):

```markdown
- **Advisor rides on top of role bindings.** `advisorModel` in settings pairs every dispatch with
  a stronger consult-only model at decision points. It is not an exception to the no-explicit-
  `model` rule, it never substitutes for a `verifier` pass, and advisor cost is invisible to
  praxarch telemetry — treat frequent advisor use on cheap roles (`checker`, `Explore`) as a
  smell, not a feature.
```

## Task 5 — docs and changelog

- `docs/design.md`: in whatever section describes the settings fragment / model routing, add a
  short paragraph (3–5 sentences) stating: `advisorModel` ships in the fragment; subagents inherit
  it paired against their own bound model; advisor calls are server-side and therefore invisible
  to route-guard and telemetry; the statusline shows `adv:<model>` and doctor reports advisor
  state. No new section heading — extend the existing model-routing prose.
- `CHANGELOG.md`: add an entry under the unreleased/top section following the file's existing
  format: "Ship `advisorModel: opus` in the settings fragment; surface it in the statusline
  (`adv:<model>`) and `praxarch doctor`."

## Verification (run all; paste output in the report)

1. `pnpm build` — clean.
2. `pnpm test` — all pass, including the new statusline cases.
3. `pnpm lint` (or the repo's eslint invocation) — clean.
4. Fragment merge proof: with `PRAXARCH_TARGET_CLAUDE_HOME` pointed at a throwaway temp dir, run
   the installer (`node dist/cli/index.js install` or the repo's documented equivalent) and show
   that the temp dir's `settings.json` contains `"advisorModel": "opus"` inside the praxarch
   marker-managed region. Do not run the installer against the real `~/.claude`.
5. Statusline smoke: echo `{"session_id":"nonexistent"}` into `node dist/statusline/statusline.js`
   with `PRAXARCH_TARGET_CLAUDE_HOME` at a fixture containing `advisorModel` — output ends with
   `adv:opus`.

## Out of scope (do not touch)

- `~/.claude/praxarch/POLICY.md` and `~/.claude/CLAUDE.md` — installed-side, updated by the
  orchestrator separately.
- route-guard, telemetry, verify-gate.
- Any attempt to observe, log, or meter actual advisor calls.
- Live verification of main-session pairing behavior with `model: "best"`.
