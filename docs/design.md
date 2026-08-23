# Design rationale

繁體中文版：[design.zh-TW.md](design.zh-TW.md)

## Starting point: pilotfish

[Pilotfish](https://github.com/Nanako0129/pilotfish) established the shape praxarch keeps:

1. **Settings layer** (`~/.claude/settings.json`) — model aliases (`best`) and a fallback chain,
   so the config survives model deprecations without edits.
2. **Role layer** (`~/.claude/agents/*.md`) — ten roles, each pinned to a cost-appropriate model
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
- **`verify-gate`** (Stop) blocks session completion when the diff since the session's baseline
  commit (falling back to HEAD, plus untracked new files) is large enough to count as non-trivial
  (configurable thresholds) and no `CONFIRMED` verifier record with zero
  critical/major findings is on file for the session. Two escape hatches exist on purpose —
  `PRAXARCH_SKIP_VERIFY=1` and an explicit `PRAXARCH_VERIFY_WAIVED: <reason>` starting a line of
  the final message (the match is line-start-anchored, so the gate's own quoted instructions can't
  accidentally waive) — because a hard gate with no escape becomes something users route around by
  lying to it, which is worse than no gate.
  - **The diff measurement is session-scoped in both halves (issue #16).** Before this, `diffStat`
    charged the session with work it did not do, in two directions at once, and both were observed
    live: a 118-line pre-existing untracked file counted in full on every Stop, and a `git pull` of
    two already-verified MRs turned a standing verdict stale purely from received commits
    (`382/6 -> 539/16`).
    - *Untracked half.* SessionStart snapshots a content key (sha256 for regular files, a kind
      marker for anything else) for every untracked path that already exists — `baselineUntracked`
      in spirit, though the field that name would suggest carries only a marker (see the sidecar
      note below). A later measurement counts a path only when its key is absent or differs from
      the snapshot; an identical key means the session never touched it and it contributes nothing.
      A changed pre-existing file still counts in full, not as a delta — an over-count, and the
      accepted direction. Genuinely new files (absent from the snapshot) always count.
    - *Tracked half.* `state.baselineHead` stays pinned on disk for the whole session — nothing in
      this fix writes a new value to it. Instead, each measurement derives an *effective* baseline:
      `git merge-base HEAD <remote>/HEAD`, used only when it is a descendant of the pinned baseline
      (`resolveEffectiveBaseline`, `upstream-baseline.ts`). The reference is deliberately the
      remote's *default branch* (`refs/remotes/<remote>/HEAD`, set by `git clone`) and not
      `@{upstream}` — with `@{upstream}`, pushing a local commit to a feature branch advanced the
      effective baseline onto the session's own unverified work, laundering it out of the
      measurement. Restricting to the default branch raises the cost of laundering but does not
      close it: `git remote set-head <remote> <branch>` repoints `refs/remotes/<remote>/HEAD`
      locally, needs no remote permission and no write to the default branch, and moves the
      effective baseline onto the session's own work. This is a guardrail. It already ships
      `PRAXARCH_SKIP_VERIFY=1` and `PRAXARCH_VERIFY_WAIVED:` as first-class escape hatches, so
      nobody needs `set-head` to get out of it. Any uncertainty (no remote, no `origin/HEAD`,
      merge-base failure, a candidate that isn't a descendant of the pin) falls back to the pinned
      baseline unchanged.
  - **A pre-existing, but reachable, symlink hazard was closed by the same rewrite.** The old
    untracked loop called `readFile` on every listed path, which follows symlinks: an untracked
    symlink pointing outside the repo read out-of-repo content into the count, and one pointing at
    a FIFO blocked the read forever — the same hang class as the fingerprint's own FIFO fix below,
    reached through a different entry point. The new dispatch (`untracked.ts`) uses `lstat`, never
    follows a symlink, and reads a regular file only after `lstat` has proven it one. A related
    fail-open closed at the same time: listing untracked files from a subdirectory used to return
    only that subtree with cwd-relative paths, silently under-counting; listing now always runs
    whole-repo and root-relative (`git ls-files --others --exclude-standard --full-name -- :/`).
  - **Residual, accepted:** a `git pull` still drops a standing `PRAXARCH_VERIFY_WAIVED` waiver,
    because the waiver compares raw fingerprints (HEAD-sensitive by design) rather than a size
    delta — the gate re-blocks once after a pull even when nothing the session touched actually
    changed. Fixing this would mean weakening the waiver into a size-delta rule, which was judged
    the worse tradeoff; the gate re-blocking once is a nuisance, a waiver silently surviving a
    HEAD move it was never evaluated against is a correctness bug.
  - A recorded verdict expires if the tree has moved past it: `telemetry` fingerprints the diff
    (a content hash plus changed-lines/changed-files counts) alongside every verdict it records,
    and `verify-gate` treats the verdict as stale — falling through to the normal block path —
    once the current tree's hash differs from (or can't be compared to) the recorded one *and*
    the size delta since it was recorded clears `minChangedLines`/`minChangedFiles`. Both
    conditions are required deliberately: a hash difference alone (e.g. lockfile churn
    `verify-gate` doesn't filter out of the hash) can't expire a verdict on its own, and a
    shrinking diff (work reverted since the pass) is never treated as stale. An unfingerprintable
    diff counts as "differs," never as "unchanged," since treating an unknown as fresh is exactly
    the failure mode this exists to close. Verdicts recorded before this existed omit the hash
    field entirely and are accepted unconditionally — only in-flight sessions can hold one; a
    verdict whose hash was recorded but couldn't be computed (present, `null`) does *not* get that
    same pass.
    - **The fingerprint never generates a patch.** Four rounds of adversarial review each found
      the same defect in a different coat: a multi-MB `git diff` patch fetch, piped through a
      child process with layered fallbacks, has an open-ended failure surface (a `maxBuffer`
      overflow, a `diff.external`/`GIT_EXTERNAL_DIFF`/textconv driver blanking the output while
      `--numstat` kept working, a HEAD-fallback laundering a baseline overflow into a real-looking
      empty diff) and any miss anywhere silently collapses the fingerprint to a constant value.
      The fingerprint is now `sha256(HEAD sha, then each entry of git status --porcelain -z
      --no-renames --untracked-files=all, sorted by path, contributing path + status code + a
      kind-dispatched read of that path)`. Committed work is covered entirely by the HEAD sha —
      any commit moves HEAD, which moves the fingerprint — so there is no patch-text baseline to
      fetch and the whole class of failure above is structurally impossible rather than defended
      against: nothing in `diffFingerprint` ever runs `git diff`. Dirty and untracked files are
      covered by reading their current on-disk state directly in Node, dispatched by `fs.lstat`
      (never `stat` — a symlink is inspected as itself, not followed) rather than assumed from the
      status code:
      The dispatch is now genuinely total: every branch below emits its own kind marker or the
      regular-file length prefix, never an implicit fallthrough into another branch's encoding.
      - `lstat` `ENOENT` → path + status code + the `"ABSENT"` marker. This covers a real
        deletion (no content by definition) and a delete-between-status-and-read race
        identically — the fingerprint describes the tree as it is now. There is no longer a
        status-code-driven deletion shortcut: an unmerged delete/modify conflict (`UD`/`DU`) is a
        single status entry with full working-tree content — the file a session edits to resolve
        the conflict — and it naturally falls through to the regular-file case below instead of
        being misread as a deletion. (Five rounds of review lived with this gap; round 6 found it
        by reproducing a conflicted file with 201 unreviewed lines and a fingerprint that never
        moved.)
      - Any other `lstat` failure → `null`.
      - A symlink → path + status code + the `"SYMLINK"` marker + the `readlink` target string,
        never the followed content. Not following means a dangling target is no longer a read
        failure, a retargeted link still moves the hash (the target string changes), and content
        outside the repo can never be read through a symlink planted inside it.
      - A directory → path + status code + the `"DIR"` marker, nothing else. A dirty submodule and
        an untracked embedded repo both surface as a single directory-path status entry; git
        itself collapses their inner content the same way, so a fingerprint that can't see past
        that entry is inherited blindness, not a gap — the same blindness `diffStat`'s numstat
        already has.
      - Anything else non-regular (FIFO, socket, block/character device) → path + status code +
        the `"SPECIAL"` marker. Streaming below is reached only through an explicit `st.isFile()`
        check, never as an implicit fallback: round 6's dispatch tested symlink then directory
        and fell straight through to `createReadStream` for everything else, so a tracked file
        replaced by a FIFO (`mkfifo` over an existing path, reported by porcelain as an ordinary
        modification) blocked the read stream forever with no writer on the other end — the Stop
        hook hung until the harness killed it at timeout, which then treats a timed-out hook as
        non-blocking: a session stall plus a silent fail-open with no log line. `"SPECIAL"` is a
        marker, not `null` — a special file in the tree is a persistent state, and `null` would
        leave the fingerprint permanently unknown for as long as it stays that kind, the same
        degradation the dangling-symlink fix closed for symlinks. One marker covers every such
        kind; which specific special kind sits at a path isn't a state worth distinguishing.
      - A regular file → path + status code + byte length + content, streamed through the hash
        (`createReadStream`, not a buffered `readFile`) so memory use stays bounded regardless of
        file size.
      Kind markers (`"ABSENT"`, `"SYMLINK"`, `"DIR"`, `"SPECIAL"`) are non-numeric and
      NUL-terminated, so no marker can be read as a length and no two markers — or a marker and
      the numeric length prefix — can collide: every branch's encoding is prefix-free by
      construction, not merely undisproven.
    - **Failure is loud by construction, not by fallback.** `git status` failing or exceeding the
      64MB `MAX_GIT_BUFFER` (status output is paths, not patch text, so hitting this is
      pathological) → `null`, never an empty or truncated listing. `git rev-parse --show-toplevel`
      failing while `git status` succeeded → `null` — porcelain paths are repo-root-relative, not
      cwd-relative, and joining them against `cwd` instead (the round-6 major) silently produced
      wrong paths, and a permanently inert fingerprint, for any session run from a subdirectory;
      falling back to `cwd` on a resolution failure would just reproduce the same bug more rarely,
      so it isn't done. `git rev-parse --verify HEAD` failing *while `git status` succeeded* is
      treated as a genuinely unborn HEAD — status succeeding proves a working repo, so a HEAD that
      won't resolve in a working repo means there is no HEAD, not that something went wrong — and
      contributes the sentinel `"NOHEAD"` instead of a real sha; a transient split between the two
      calls makes the fingerprint read as "differs," the conservative direction.
    - `git-diff.ts` splits this into two functions: `diffStat` (counts only, cheap, still
      `baseline`-relative via `--numstat` against the session's recorded HEAD) and
      `diffFingerprint` (the hash — a pure function of the current tree, no baseline parameter);
      callers only pay for the fingerprint once they've established they actually need one, which
      is why the two are separate rather than one combined call that always does both. `diffStat`'s
      own untracked-file half (issue #16) mirrors `diffFingerprint`'s dispatch precisely rather than
      duplicating it: both live behind `untracked.ts`'s `readUntrackedEntry`, listing is always
      whole-repo and root-relative regardless of `cwd` (`--full-name -- :/`), symlinks are read via
      `lstat` and never followed, a directory (an embedded repo or nested worktree) counts as one
      file with zero lines rather than being descended into, and the ignore-pattern check runs
      *before* any read so an ignored tree (default `dist/`) is never opened just to be discarded.
      An unreadable entry still contributes its 1 file / 0 lines here — deliberately not
      `diffFingerprint`'s `null` — because a permanently unreadable path would otherwise make the
      whole measurement un-measurable, and therefore permanently blocking, for the rest of the
      session; counting it conservatively keeps the gate usable.
  - The loop guard runs two independent counters, and fails open when *either* clears its limit.
    `verifyGateConsecutiveBlocks` (limit 2) is scoped to a single stop cycle *and* to a single
    diff: it's cleared on every genuine allow path and whenever `stop_hook_active` is false, so a
    stale count from an earlier cycle can't leak into a later one and cause an immediate, unearned
    fail-open, and it's additionally reset if the tree has changed since the blocks that tripped
    it (compared by the same diff fingerprint above) — new, unverified work doesn't inherit a trip
    count run up against a *different* diff. That per-diff reset is also its blind spot:
    `verifyGateCycleBlocks` (limit 5) is the backstop — a per-stop-cycle total that is **never**
    reset by tree movement, only by the same cycle-boundary/genuine-allow events as the per-diff
    counter. Without it, a session that touches one file per round (a scratch edit, a formatter
    run, anything that changes the hash) resets the per-diff counter before it ever reaches its
    limit, even though every single round blocks — an unsatisfiable gate that never fails open.
    What neither counter does: clear on the loop-guard's own fail-open. Once tripped in a cycle,
    it stays tripped for the rest of that cycle — that's the guard working as designed, not a
    residual bug; clearing there would turn the bounded "N blocks then quiet" guarantee into
    block, block, allow forever. An unfingerprintable current diff never resets the per-diff
    counter either, for the same reason: treating "unknown" as "changed" here would hand back an
    infinite-loop vector. The two fail-open reasons are distinguishable in both the
    `systemMessage` and the JSONL row (`reason: "loop-guard"` for the per-diff limit,
    `"loop-guard-cycle"` for the per-cycle ceiling). A third reason, `"timeout"`, is written by
    verify-gate's own watchdog when it exceeds 80% of its configured hook timeout (`timeout: 60`
    on the Stop entry in `templates/settings.fragment.json`, overridable per-invocation with
    `PRAXARCH_VERIFY_GATE_TIMEOUT_MS`) — without it, a hook the harness kills at the timeout is a
    fail-open with no row and no `systemMessage` at all. A stuck session (same diff, repeatedly
    unverified) and a churning one (diff keeps moving, never gets verified either) are different
    failure modes worth telling apart when reading the log. Every fail-open — loop-guard,
    loop-guard-cycle, timeout, or a crash — is logged to the monthly JSONL
    (`event: "verifyGateFailOpen"`, `reason: "error"` for the crash case) and surfaced via
    `systemMessage`, and `praxarch report` totals them separately from delegation stats so a gate
    that's gone quiet doesn't look identical to one that's passing.

    **`route-guard`'s crash logging uses a distinct event name (issue #24), deliberately.**
    route-guard also fails open on its own internal errors, and also appends a JSONL row for it —
    but as `event: "guard-crash"`, not `verifyGateFailOpen`. The two hooks are not sharing one
    "hook crashed" event: `verifyGateFailOpen` is verify-gate's schema (loop-guard,
    loop-guard-cycle, timeout, and its own crash case all share it, distinguished by `reason`), and
    `guard-crash` is route-guard's own event for the same "crashed and failed open" shape.
    Unifying them under one event name would mean either route-guard's non-crash reasons don't
    exist (there are none, so this would work today) or verify-gate's `reason` field gets bolted
    onto an event it doesn't otherwise use — and either way, it would rewrite the meaning of
    `verifyGateFailOpen` rows already on disk, which issue #24's guardrail (no schema changes to
    existing rows) forbids. An auditor wants two separate queries, not one: verify-gate's crashes
    are `event=="verifyGateFailOpen" && reason=="error"`; route-guard's crashes are
    `event=="guard-crash"`.
  - **The measurement is anchored to the session's own checkout, not the hook's cwd (issue #23).**
    Observed live: a session shell that `cd`'d into `.claude/worktrees/agent-*` had every Stop
    measure that worktree's diff (1202 lines across 7 files) against a baseline pinned in the
    primary checkout, for an actual 6-line fix. `session-init.ts` now records `state.baselineCwd`
    from SessionStart's `input.cwd` (guarded identically to `baselineUntrackedCaptured`: only on
    `source === "startup"`, never on resume/clear/compact, so a mid-flight session never gets its
    anchor moved out from under it). `resolveMeasurementCwd` (`measurement-cwd.ts`) is the single
    dispatch every measurement site resolves through before touching `diffStat`/`diffFingerprint`:
    `verify-gate`'s waiver fingerprint, `diffStat`, and the block-path fingerprint; telemetry's
    `captureDiffHash`/`captureDiffCounts`; `record-verdict`'s equivalents. An absent anchor (a
    session that predates this field) falls back to the hook/CLI cwd exactly as before — legacy
    sessions keep today's behavior. A recorded-but-now-missing anchor (a deleted worktree, a moved
    checkout) resolves to `null`, which every caller treats as a measurement failure, never a
    fallback to the hook cwd: `diffStat` returns `{0, 0}` (allow) for a cwd that isn't a git repo,
    so quietly substituting the hook cwd there would hand back a trivially-empty diff instead of
    the failure this actually is. In `verify-gate`, `null` drives `measurementFailed` and blocks
    with a message naming the missing anchor path rather than the generic unmeasurable-diff text.
    `loadConfig` deliberately keeps resolving from the hook cwd in every caller — which project's
    settings apply is a property of the invocation, not of which tree is being measured.
  - **Known limit of the size-delta rule**: it detects *growth* (or a hash-unknown situation),
    not just any change. A same-size in-place rewrite after the verdict was recorded — the file
    count and line count both stay flat, only the content differs — passes as fresh, because its
    hash-differs condition alone isn't enough without an accompanying size delta. This is the
    accepted tradeoff of the hash+delta approach (a `git write-tree` snapshot would close it, but
    was ruled out as too heavy for a hook) — worth knowing rather than discovering by surprise.
- **`telemetry`** (PostToolUse), **`subagent-stop`** (SubagentStop), and **`session-init`**
  (SessionStart) don't enforce anything; they observe and warn/record. Enforcement only applies to
  the two rules where a false negative (an unenforced violation) is worse than a false positive
  (an occasional unnecessary block).

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

As of issue #15, `PostToolUse` only ever sees a dispatch-time launch receipt — Claude Code doesn't
deliver a subagent's actual output there, so `telemetry` cannot parse a verdict out of it.
Automatic verdict recording instead happens on the `SubagentStop` hook, which fires on real
subagent completion and parses this JSON block out of the transcript. It writes the verdict into
session state (for `verify-gate` to check immediately) and appends its own `event:
"subagentVerdict"` row to the monthly JSONL (for `praxarch report` to count, on its own "Automatic
verdicts (SubagentStop)" line). It never rewrites the dispatch-time delegation row — the log is
append-only. The verdict is derived, not asserted: `CONFIRMED` requires
zero `critical`/`major` findings, regardless of what the `verdict` field itself claims — a defense
against a verifier that writes "CONFIRMED" out of habit while listing a critical finding.
`praxarch record-verdict` is the manual fallback for any completion `subagent-stop` misses (e.g. a
subagent that errors or is interrupted before stopping normally). Severity classification is
fail-closed: a finding counts as critical/major unless its severity is exactly `minor`,
case-insensitively — an unrecognized or missing severity counts rather than reading as zero.

### Telemetry: measured, not claimed

Pilotfish cites benchmark numbers (e.g. "Sonnet workers at 96% of all-Fable performance for 46% of
the cost") as the expected payoff of tiered delegation, but nothing in the tool itself measures
*your* actual role distribution or savings. Praxarch's `telemetry` hook logs every delegation
(role, model, timestamp) to a monthly JSONL file at dispatch time; `subagent-stop` appends a
separate `event: "subagentVerdict"` row once the subagent actually completes, and updates the
matching in-session `delegations[]` entry in session state; the dispatch-time JSONL row is never
rewritten. The status line
surfaces the current session's counts live, and `praxarch report` aggregates role distribution and
verifier pass rate across history.

**What this deliberately does not claim**: a "delegation-vs-local ratio" or "escalation
frequency." Both would require observing the main session's own direct work and linking repeated
delegations as retries of the same task — neither is derivable from what a PostToolUse hook on the
Agent tool can see. An earlier draft of the `/praxarch-report` skill promised these; it was
corrected once the actual telemetry schema made clear they couldn't be honestly computed. Reporting
a number that looks measured but is actually guessed is worse than not reporting it.

**Update (v0.1.x, verified against a live payload capture)**: Claude Code's PostToolUse hook
*does* expose subagent cost data — `tool_response` carries the resolved model ID, total token
usage, and run duration. Delegation records now include `resolvedModel`, `totalTokens`, and
`durationMs`. An earlier revision of this document claimed the opposite based on a reading of the
hooks documentation; the lesson folded back into the codebase is that hook payload assumptions
get verified against captures (`PRAXARCH_DEBUG_PAYLOADS=1` dumps raw payloads to
`~/.claude/praxarch/debug/`), which also serve as contract-test fixtures.

### Per-project overrides

Pilotfish is global-only by design, on the grounds that an audit of real projects found zero
project-level model policy in the wild. Praxarch adds a narrow, optional override surface —
`.claude/praxarch.json` — scoped to exactly the two things the hooks might legitimately need
retuned per project: verify-gate thresholds (a doc-heavy repo's "non-trivial" diff size differs
from a monorepo's) and route-guard strictness/extra security keywords. It does not duplicate the
policy layer — delegation *rules* still live in CLAUDE.md, stacked per Claude Code's native
project/global memory behavior; `praxarch.json` only tunes the hooks' thresholds.

Role→model bindings are deliberately *not* overridable here. An earlier revision shipped a
`roleModelOverrides` key that nothing consumed; rather than wiring it up, it was removed, because
Claude Code already has the right mechanism: a project-level `.claude/agents/<role>.md` shadows
the user-level agent of the same name (verified empirically — a project scout pinned to sonnet
resolved to sonnet in delegation telemetry). One source of truth for bindings: agent frontmatter.

### Parallel fan-out

No new mechanism was needed here — Claude Code's Agent tool already supports
`isolation: "worktree"`. What was missing was a named pattern: when fan-out is worth the
coordination overhead (three or more independent, fully-specifiable units), how to tag the batch
for telemetry (`[fanout:<batch-id>]` in each call's description), and the rule that a fan-out gets
*one* verification pass over the merged result, not one per worker. This is codified as the
`/fan-out` skill rather than a hook, because "is this actually independent work" is a judgment call
a hook can't safely make.

## Known limitations

- **Report metrics are intentionally narrower than pilotfish's claims** — role distribution and
  verifier pass rate only, not savings percentages or escalation frequency. (Per-delegation token
  and duration data is now logged — see above — but the report CLI doesn't yet aggregate it.)
- **`verify-gate`'s diff-size heuristic is a proxy, not a semantic judgment** — a large
  formatting-only diff can trigger it unnecessarily (mitigated by `ignorePatterns` and the waiver
  escape hatch); a small but behaviorally significant change can slip under the threshold
  (mitigated by policy still asking for verification regardless of gate enforcement).
- **`route-guard`'s security-keyword match is a blunt instrument** — false positives are possible
  on prose that happens to mention a keyword without being security-sensitive work; `strict: false`
  in a project's `praxarch.json` downgrades denials to warnings if this proves too noisy for a
  given codebase.
- **Verdict-expiry's size-delta rule detects growth, not any change** — a same-size in-place
  rewrite of the diff after a verdict was recorded (file/line counts stay flat, only content
  differs) passes as fresh, since the hash-differs condition alone isn't sufficient without an
  accompanying size delta past `minChangedLines`/`minChangedFiles`. Accepted tradeoff of the
  hash+delta approach over a heavier `git write-tree` snapshot; see the `verify-gate` bullet above.
- **A changed pre-existing untracked file is counted in full, not as a delta** — the untracked
  baseline snapshot (issue #16) tells `diffStat` whether a path's content key matches what it was
  at SessionStart, not how much of it changed. A one-line edit to a large pre-existing untracked
  file therefore counts the whole file, over-counting. The safe direction, and the same semantics
  untracked content already had before the snapshot existed.
- **No `refs/remotes/<remote>/HEAD` means the tracked baseline stays pinned** — `git init` +
  `git remote add` + `git fetch` never sets this ref (only `git clone` does), so
  `resolveEffectiveBaseline` has nothing to advance onto and every measurement falls back to the
  pinned `state.baselineHead`; received-but-not-yet-reviewed work is still charged to the session in
  that setup, exactly as before this fix. `git remote set-head <remote> -a` is the fix, left to the
  user rather than a config key — `verifyGate.upstreamRef` was considered and ruled a deliberate
  non-goal here.
- **A `git pull` still invalidates a standing `PRAXARCH_VERIFY_WAIVED` waiver** — the waiver
  compares raw fingerprints, which are HEAD-sensitive by design, not size deltas. See the residual
  note under the `verify-gate` bullet above.
- **A primary-checkout session's edits inside a worktree checkout aren't charged to it** — the
  measurement anchor (issue #23) is the directory SessionStart captured baselines in, so a session
  that only `cd`'s into `.claude/worktrees/agent-*` without having been launched there measures its
  own checkout, not the worktree's. This is the deterministic version of the behavior those edits
  already had whenever the shell happened to sit at the session's root before this change — a
  worktree session is charged for its own work exactly as it always was, since it launches with
  the worktree as its own `baselineCwd`.

### Fail-opens mutation testing found, not review (issue #16)

Every one of these shipped green through the normal suite; each surfaced only once a mutant was
written to exercise it. Documented here, not just fixed, because each is one plausible "cleanup"
away from returning — the `\r?\n$` one below already did, within the same day it was first closed.

- **The untracked snapshot lives in its own sidecar file, `<stateDir>/<sessionId>.untracked.json`
  (`untracked-baseline-store.ts`), never inside `SessionState`.** `SessionState` carries only
  `baselineUntrackedCaptured?: boolean` — a marker that a capture was attempted, not the captured
  content. The snapshot was originally written straight into `SessionState.baselineUntracked`
  because "every consumer already reads session state" made it look free; that reasoning is exactly
  backwards, because `telemetry.ts` rewrites the state file on *every* PostToolUse(Agent) call.
  Measured at 1999 untracked files (~20MB of content hashed): SessionStart went from ~10ms to
  **3495ms**, and the state file grew to **187KB**, re-parsed and re-serialized on every tool call
  regardless of whether that call had anything to do with untracked files. A write-once/read-rarely
  blob must never share storage with a record that gets rewritten constantly, however convenient
  the existing read looks. If this ever gets "simplified" back into `SessionState`, that
  regression returns with it.
- **`repoRoot` returns a `Buffer`, and `readUntrackedEntry` takes `Buffer` paths end to end —
  never a `string`.** `execFile` with `encoding: "buffer"` keeps git's stdout from being UTF-8
  decoded before a path is built from it. A repo root, or an untracked path, with a real on-disk
  name containing invalid-UTF-8 bytes (permitted by ext4/xfs, and reachable without an unusual
  filesystem — a hook's `cwd` can arrive through an ASCII-named symlink that still resolves to a
  non-UTF-8-named physical directory) gets silently corrupted to U+FFFD the moment it round-trips
  through a `string`. That corruption made a 400-line untracked file measure as 0 — the decoded
  path no longer matched the file on disk, so every fs call on it failed and the read degraded to
  "path only." A `string`-typed path parameter reintroduces this the moment someone adds one,
  regardless of how careful the body is.
- **Git output carrying a path is stripped with `/\n$/` — never `.trim()`, and never `/\r?\n$/`.**
  Both wider patterns eat legal trailing whitespace that is part of a real directory or file name,
  not padding. `.trim()` strips leading whitespace too, which a repo root can also legitimately
  have. `/\r?\n$/` looks like defensive Windows-compatibility hardening — reasonable-sounding
  enough that it recurred within a day of first being removed — but git terminates this class of
  output with a bare `0x0A` on every platform, never `0x0D 0x0A`, when writing through a pipe; the
  `\r?` protects against nothing real and instead strips a legal trailing carriage return that was
  part of the name. In `diffFingerprint` this produced a hash that never moved for a repo whose
  root ended that way, so a CONFIRMED verdict never went stale no matter how much changed
  afterward — a silent, permanent free pass, not a crash or a visible wrong number.
- **Permission-dependent tests use a functional probe (`fixtures/permission-probe.ts`), never
  `process.getuid() === 0`.** CI runs as root on some runners, and a uid check built to skip "when
  we can't test this" instead skips exactly where the behavior under test — a permission denial —
  is guaranteed to actually happen, silently removing the coverage where it matters most. The probe
  attempts the real operation (e.g. writing to a locked-down path) and skips only on an actual
  failure to set up the precondition, so the test still runs, and still means something, under
  root.
