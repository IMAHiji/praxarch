# Design rationale

繁體中文版：[design.zh-TW.md](design.zh-TW.md)

## Starting point: pilotfish

[Pilotfish](https://github.com/Nanako0129/pilotfish) established the shape praxarch keeps:

1. **Settings layer** (`~/.claude/settings.json`) — model aliases (`best`) and a fallback chain,
   so the config survives model deprecations without edits.
2. **Role layer** (`~/.claude/agents/*.md`) — nine roles, each pinned to a cost-appropriate model
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
  `PRAXARCH_SKIP_VERIFY=1` and an explicit `PRAXARCH_VERIFY_WAIVED: <reason>` in the final
  message — because a hard gate with no escape becomes something users route around by lying to
  it, which is worse than no gate.
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
      is why the two are separate rather than one combined call that always does both.
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
    `"loop-guard-cycle"` for the per-cycle ceiling) — a stuck session (same diff, repeatedly
    unverified) and a churning one (diff keeps moving, never gets verified either) are different
    failure modes worth telling apart when reading the log. Every fail-open — either loop-guard
    reason, or a crash — is logged to the monthly JSONL (`event: "verifyGateFailOpen"`) and
    surfaced via `systemMessage`, and `praxarch report` totals them separately from delegation
    stats so a gate that's gone quiet doesn't look identical to one that's passing.
  - **Known limit of the size-delta rule**: it detects *growth* (or a hash-unknown situation),
    not just any change. A same-size in-place rewrite after the verdict was recorded — the file
    count and line count both stay flat, only the content differs — passes as fresh, because its
    hash-differs condition alone isn't enough without an accompanying size delta. This is the
    accepted tradeoff of the hash+delta approach (a `git write-tree` snapshot would close it, but
    was ruled out as too heavy for a hook) — worth knowing rather than discovering by surprise.
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
