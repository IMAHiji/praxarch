# Changelog

## Unreleased

### Added

- Ship `advisorModel: opus` in the settings fragment; surface it in the statusline
  (`adv:<model>`) and `praxarch doctor`.
- **Status line surfaces verify-gate state.** Shows "no verdict on record", a verified/unverified
  verdict (with the verdict-time diff size, e.g. `✓verified@120L/4f`), a standing waiver, and blocks
  already spent this stop cycle — from persisted session state only, no subprocess spawned. A
  Stop-hook block costs a full extra turn (block → read reason → dispatch a verifier → stop again);
  this lets the orchestrator see the gate before it blocks, not after.
- **`praxarch doctor --prune` — retention sweep for session state and debug payloads.** Deletes
  files under `~/.claude/praxarch/state/` older than 30 days and `~/.claude/praxarch/debug/` older
  than 7 days (overridable via `PRAXARCH_STATE_RETENTION_DAYS` / `PRAXARCH_DEBUG_RETENTION_DAYS`).
  Nothing was ever removing these before, and the state directory grows without bound (1,029 files
  / 4.1 MB measured on one machine). Deletion is gated on mtime plus an explicit skip of the
  current session's own files, and touches nothing outside those two directories. Plain
  `praxarch doctor` gains an informational (always-`ok`) check reporting how many files are
  prunable.
- **verify-gate's two escape hatches now leave an audit trail.** `PRAXARCH_SKIP_VERIFY=1` and an
  accepted `PRAXARCH_VERIFY_WAIVED:` waiver each append a JSONL row (`verifyGateSkipped` /
  `verifyGateWaived`) to the monthly log instead of writing nothing, and `praxarch report` now
  totals both on an `Escape-hatch exits:` line alongside the existing fail-open counter.
- **Blind-dispatch wording for `verifier`/`checker` and the orchestration policy, plus a
  verifier-precision design sketch.** A verification dispatch must never carry the orchestrator's
  own claim that the work is correct — only the diff/bundle, spec, and constraints — per measured
  confirmation-bias injection effects (arXiv:2603.18740, 2026-03: -93.5 points on a small model,
  -59.9 on a small reasoning model, -4.9 on an opus-class model). `docs/design.md` also sketches,
  without implementing, a `record-disposition` mechanism for a future verifier-precision metric.
- **`/issues` skill for planner-drafted, approval-gated issue creation.** Dispatches `planner`
  (no `model` override) to draft tracker-grade issues from a task or roadmap using an
  eight-section template (Goal, Context you must read first, Decisions already made,
  Specification, Hard guardrails, Acceptance criteria, Definition of done, Escalate instead of
  deciding), written to the plan file and presented to the user verbatim — never summarized —
  for review. Nothing is posted to a tracker without an explicit, separate approval step naming
  the exact destination; delivery routes to `glab` or `gh` depending on the origin host, with
  `{{issue:slug}}` cross-references resolved to real issue numbers in dependency order and issue
  titles/bodies passed to the CLI via temp files (`$(cat <file>)`) rather than interpolated
  directly into the shell command.
- **`/orchestrate` skill and pipeline roles ported in-repo.** praxarch now ships its own
  plan/implement/review pipeline: `planner` (writes an implementation plan), `implementer`
  (executes one task from it), and `plan-reviewer` (verifies the merged result) — previously an
  external dependency on the cognex-agents work repo. Independent tasks (`Depends on: independent`
  in the plan) are dispatched in parallel worktrees when there are two or more ready at once, same
  isolation pattern as `/fan-out`, with a single `plan-reviewer` pass over the merged result rather
  than one per task. `plan-reviewer`'s JSON verdict block is now a built-in `verifyGate.verdictRoles`
  and `routeGuard.reviewRoles` entry, so a project's own config no longer needs to add it. (Note:
  `README.zh-TW.md` hasn't been updated for this change yet.)
- **route-guard: `routeGuard.knownRoles` config extends the defined-role set.** The built-in ten
  roles are praxarch's own; agents installed by other tools with their own frontmatter bindings
  (plugin agents) were caught by the ad-hoc rule: strict mode denied them for lacking `model`,
  and passing `model` to satisfy it overrides the binding the guard exists to protect.
  Config-listed roles now get the same treatment as built-ins (frontmatter owns the model;
  explicit `model` is denied). Additive merge, like `securityKeywords`.
- **telemetry/verify-gate: `verifyGate.verdictRoles` lets non-verifier reviews satisfy the gate.**
  Telemetry recorded trailing JSON verdicts only from the `verifier` role, so an /orchestrate
  run's plan-reviewer pass went unrecorded and verify-gate demanded a second review at session
  stop. Roles listed in `verifyGate.verdictRoles` (additive over the default
  `["verifier", "checker", "plan-reviewer"]`) now get their verdict blocks recorded; the added role's
  report contract must end with the verifier template's JSON verdict block.
- **route-guard: `routeGuard.reviewRoles` generalizes the verifier security exemption.** The
  2026-07-08 exemption was hardcoded to `subagent_type === "verifier"`, so other read-only
  review agents (pr-review-toolkit's reviewers) hit the identical deadlock: reviewing
  auth/secrets code mentions the keywords, strict mode denies the dispatch. Config-listed
  review roles are now exempt alongside verifier; additive merge over the default
  `["verifier", "checker", "plan-reviewer", "planner"]`, so the canonical exemption can be
  extended but never dropped.
- **route-guard: `routeGuard.softDenyRoles` downgrades the security-keyword deny to a warning for
  `executor`.** `executor` shares `security-executor`'s model tier, so the hard deny on a matched
  keyword was buying process overhead — reword-and-retry loops — rather than real classifier
  avoidance; transcript mining (2026-08-19) found 40+ blocks tripped by benign mentions of
  `credential`/`secret` in registry/npmrc prose, and a laundering workaround had already appeared
  in one project's agent memory. Roles listed in `routeGuard.softDenyRoles` (default `["executor"]`,
  additive — never removes `executor`) now get `permissionDecision: "allow"` with a systemMessage
  naming the matched keyword and suggesting `security-executor`, instead of a deny — but only when
  nothing else in route-guard's rule chain would deny the delegation anyway (explicit-model-override
  on a known role, or an ad-hoc call with no model, still deny outright and the warning is dropped
  in that case). Everything else — `mech-executor`, `scout`/`Explore`/`implementer`, ad-hoc
  dispatches — keeps the hard deny.
- **New `checker` role: sonnet-bound re-verification, cheaper than opus `verifier`.** Verdict
  telemetry showed the opus `verifier` role dominating spend (~11.3M tokens vs ~4.2M for
  `executor`), with 53 back-to-back verifier→verifier dispatches where every post-fix re-verify
  paid full opus price for a scoped follow-up. `checker` (model `sonnet`, effort `medium`) covers
  two cases: re-verifying a fix against a prior REFUTED verdict (scoped — the dispatch carries the
  prior findings plus `git diff` since that verdict, no full sweep), and first-pass verification on
  diffs below verify-gate's non-trivial thresholds. It's wired into `BUILTIN_ROLES`, the default
  `verdictRoles` and `reviewRoles`, and installer/doctor/uninstaller, with the same frozen verdict
  block contract as `verifier`. A checker dispatch that finds the diff exceeds its scope or touches
  security-sensitive territory declines rather than verifying: no verdict block, plain-text
  explanation, re-dispatch to `verifier` — verify-gate simply stays blocked on a decline, which is
  the safe state. A REFUTED checker re-verify escalates the next pass back to opus `verifier`.
- **route-guard: crashes now append a `guard-crash` JSONL row instead of failing open silently
  (issue #24).** verify-gate already logged its own crash-fail-opens (`event:
  "verifyGateFailOpen"`, `reason: "error"`); route-guard's crash path failed open the same way but
  left no trace in telemetry — an operator had no way to tell "route-guard never fired" from
  "route-guard fired and crashed" after the fact. route-guard now appends `event: "guard-crash"`
  (a distinct event name from verify-gate's, kept separate deliberately — see `docs/design.md`)
  best-effort on its own crash catch, still failing open regardless of whether the log write
  itself succeeds.
- **`praxarch doctor`: inherited-model audit cross-checks recent `model:"inherited"` dispatches
  against installed agent bindings (issue #24).** route-guard enforces "no explicit model on a
  known role" only at dispatch time, before a model resolves — whether an inherited dispatch
  actually landed on its role's bound tier was previously unanswerable without a manual telemetry
  read. `doctor` now reads the last 7 days of monthly JSONL logs, groups `resolvedModel` by role,
  and warns when an observed model diverges from the role's frontmatter binding, or when a role
  with recent dispatches has no installed agent file to check it against.
- **`praxarch report`: new "Model provenance" section — per-role dispatch count, explicit-vs-
  inherited split, and distinct `resolvedModel` values (issue #7, #24).** issue #7 was filed off a
  hand-rolled join (540 "inherited" rows and 163 "general-purpose" rows misread as one being a
  subset of the other) that took a fresh jq/python session to redo each time the question came up.
  This section makes that join a permanent one-command answer. Rows written by `praxarch
  record-verdict` (`model: "n/a"`, `via: "record-verdict"`) are excluded — they're verdict
  records, not dispatches, and counting them would inflate totals and misreport "n/a" as
  "explicit".

### Fixed

- **verify-gate: a hook killed at the harness timeout no longer fails open silently.** Claude Code
  treats a Stop hook killed at its configured `timeout` as a non-blocking allow with no JSONL row
  and no `systemMessage` — indistinguishable on disk from a clean pass. verify-gate now installs
  its own watchdog before reading hook input and fires at 80% of the budget
  (`PRAXARCH_VERIFY_GATE_TIMEOUT_MS`, default 60 000ms), emitting an allow and logging
  `event: "verifyGateFailOpen", reason: "timeout"` before the harness would otherwise kill it.
  `templates/settings.fragment.json` now pins `timeout: 60` explicitly on the `Stop` hook entry so
  the watchdog's default budget matches what Claude Code actually enforces.
- **subagent-stop: automatic verdicts are no longer invisible to `praxarch report`.** The hook
  now appends its own `event: "subagentVerdict"` JSONL row (before touching session state,
  same ordering contract as telemetry.ts) in addition to writing `lastVerifier`; `praxarch report`
  gains a new `Automatic verdicts (SubagentStop): N/M (X%) CONFIRMED` line. `docs/design.md`,
  which claimed `subagent-stop` merges its verdict into the dispatch-time delegation row, is
  corrected to describe the new dedicated, append-only row.
- **session-state: a kill mid-write no longer permanently disables verify-gate for the rest of
  the session.** `writeSessionState` wrote in place, so a process killed mid-write left truncated
  JSON on disk; `readSessionState` threw a `SyntaxError` on that, which escaped verify-gate's
  `main()` into its crash handler — emitting an allow on every subsequent `Stop` for that session,
  a silent, permanent enforcement bypass. Writes are now atomic (temp file in the same directory,
  then `rename(2)`), and an unparseable or wrong-shaped (`null`/array/scalar) state file is
  quarantined to a `.corrupt-<epoch>` sidecar and read back as empty state — the fail-**closed**
  outcome, since empty state has no `lastVerifier` and the gate demands a fresh verifier pass
  rather than allowing.
- **verify-gate/telemetry/record-verdict: the diff measurement now anchors to the session's own
  checkout, not the hook/CLI's cwd (issue #23).** Reported live: a session shell that `cd`'d into
  `.claude/worktrees/agent-*` had every Stop charge a 6-line fix as "1202 lines across 7 files" —
  the worktree's own diff plus its untracked `.claude/` — against a baseline pinned in the primary
  checkout, and `record-verdict` run from that same cwd recorded the inflated numbers into
  `lastVerifier`. `session-init` now records `state.baselineCwd` from SessionStart's cwd (never on
  resume/clear/compact, so an in-flight session's anchor can't move), and a single
  `resolveMeasurementCwd` dispatch (`measurement-cwd.ts`) is what every measurement site resolves
  through before touching `diffStat`/`diffFingerprint`. A legacy session (no recorded anchor)
  measures from the hook cwd exactly as before; a recorded-but-now-missing anchor fails closed —
  `null`, never a silent fallback to the hook cwd, since `diffStat` returns `{0, 0}` for a cwd
  that isn't a git repo and a fallback there would read a dead anchor as a trivial diff instead of
  the measurement failure it is. `verify-gate` blocks on a dead anchor naming the missing path;
  `loadConfig` deliberately keeps resolving from the hook cwd everywhere, since which project's
  settings apply doesn't depend on which tree is measured.
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
  — telemetry now fingerprints the diff (a content hash, plus changed-lines/changed-files counts)
  alongside the verdict, and verify-gate treats it as stale (falls through to blocking) once the
  hash differs *or is unknown* *and* the size delta since it was recorded clears
  `minChangedLines`/`minChangedFiles`. Verdicts recorded before this change (the `diffHash` field
  is entirely absent) are accepted unchanged — only in-flight sessions can hold one; a verdict
  whose hash was recorded but couldn't be computed (`diffHash` present but `null`) does *not* get
  that same pass. Known residual limit: the size-delta rule detects growth, not same-size
  in-place rewrites — documented in `docs/design.md`. Every fail-open (loop-guard or crash) is now
  logged to the monthly JSONL and surfaced via `systemMessage`, and `praxarch report` excludes
  those log rows from delegation stats and adds a `Verify-gate fail-opens: N` line.
  - **The fingerprint's basis: `git status`, never `git diff`.** Four adversarial review rounds
    each found the same defect in a different coat — a `maxBuffer` overflow, a
    `diff.external`/`GIT_EXTERNAL_DIFF`/textconv driver blanking the patch while `--numstat` kept
    working, a HEAD-fallback laundering a baseline overflow into a real-looking empty diff — all
    of them symptoms of measuring the diff by fetching multi-MB patch text through a child
    process. The fingerprint is now `sha256(HEAD sha, or "NOHEAD" for an unborn HEAD, then every
    entry of git status --porcelain -z --no-renames --untracked-files=all, sorted by path, each
    contributing its path, status code, and a kind-dispatched read of that path)`. Committed work
    is covered entirely by the HEAD sha; dirty and untracked files are covered by reading their
    current on-disk state directly in Node. `diffFingerprint` no longer runs `git diff` at all, so
    the whole class of failure above is structurally impossible rather than defended against, and
    it no longer takes a `baseline` parameter — it's a pure function of the current tree.
    `git status` failing or exceeding the 64MB `MAX_GIT_BUFFER` still yields `null`, never a
    truncated listing. Untracked/dirty file contents are hashed as raw bytes, not decoded to utf8
    first — a lossy decode would collapse distinct binary content to the same run of U+FFFD
    replacement characters before it ever reached the hash.
  - **Round 6: the read loop was dispatching on the status code, not the filesystem, and that lied
    twice.** Deleted paths (`D` in either status column) were assumed to have no content and
    skipped — true for an ordinary delete, false for an unmerged delete/modify conflict (`UD`/
    `DU`), which is a single status entry with the full, unreviewed working-tree content a session
    edits to resolve it; the fingerprint held constant across edits to a conflicted file. Status
    paths were also joined against `cwd`, not the repo root porcelain paths are actually relative
    to, so any session running from a subdirectory of a dirty repo got a permanently `null`
    fingerprint. Both are fixed by resolving the repo root via `git rev-parse --show-toplevel`
    (failure while `status` succeeded → `null`, never a `cwd` fallback) and replacing the
    status-code assumption with an `fs.lstat` dispatch per entry: `ENOENT` → path + status code
    + an `"ABSENT"` marker (a real deletion and a delete-between-status-and-read race read
    identically); any other `lstat` failure → `null`; a symlink → path + status code + a
    `"SYMLINK"` marker + its `readlink` target (never followed — a dangling target isn't a
    failure, a retarget still moves the hash, and content outside the repo can never be read
    through it); a directory → path + status code + a `"DIR"` marker only (a dirty submodule and
    an untracked embedded repo both collapse to one directory-path status entry in git itself, so
    this is inherited blindness, not a new gap); a regular file → path + status code + byte length
    + content, now streamed through the hash instead of buffered via `readFile`, so memory use no
    longer scales with file size.
  - **Round 7: the dispatch fell through to streaming for every kind it hadn't named, and the
    ENOENT entry left no trace of its own boundary.** Round 6's dispatch tested `isSymbolicLink()`
    then `isDirectory()` and treated everything else as a regular file — a tracked file replaced
    by a FIFO (`mkfifo` over an existing path, reported by porcelain as an ordinary modification)
    reached `createReadStream`, which blocks forever with no writer on the other end: the Stop
    hook hung until the harness killed it at timeout, and a timed-out hook reads as non-blocking —
    a session stall plus a silent fail-open with no log line. The dispatch is now total: streaming
    only happens under an explicit `st.isFile()` check, and every other non-regular,
    non-symlink, non-directory kind (FIFO, socket, block/character device) hashes as path + status
    code + a `"SPECIAL"` marker — a marker, not `null`, because a special file in the tree is a
    persistent state and `null` would leave the fingerprint unknown for as long as it stays that
    kind. Separately, the `ENOENT` branch previously contributed nothing beyond the already-hashed
    path and status code, so its entry's byte image had no boundary of its own — a symlink entry
    could in principle share bytes with two adjacent ENOENT entries, undermining the doc's
    prefix-free claim (no reachable collision was ever constructed; this closes the gap on
    principle rather than in response to a proven exploit). `ENOENT` now emits its own `"ABSENT"`
    marker alongside the existing `"SYMLINK"`/`"DIR"`/new `"SPECIAL"` markers, so every branch is
    prefix-free by construction. This changes fingerprints for any tree containing a deletion
    recorded before this change; only in-flight sessions can hold such a verdict, and a changed
    fingerprint reads as "differs" — the conservative direction — so no compatibility shim was
    added.
- **verify-gate: the loop guard now has a second counter that continuous tree churn can't reset.**
  The consecutive-block counter above resets whenever the diff fingerprint changes, which is
  correct for a genuinely new batch of unverified work — but it also meant a session touching one
  file per round (a scratch edit, a formatter run) could block every single round without the
  counter ever reaching its limit: an unsatisfiable gate that never failed open, worse than the
  under-enforcement the whole change exists to fix. `verifyGateCycleBlocks` totals blocks across
  the whole stop cycle regardless of tree movement (limit 5) and fails open alongside the per-diff
  counter (limit 2, unchanged); the two reasons are distinguishable in both `systemMessage` and the
  JSONL row (`reason: "loop-guard"` vs `"loop-guard-cycle"`).
- **verify-gate: negative size deltas now read as English.** A reverted file count or line count
  rendered literally (`"the file count grew by -3"`, `"-1 lines"`); each delta now gets its own
  sign-aware phrasing (`"N lines changed"`/`"N lines reverted"`, `"grew by N"`/`"shrank by N"`).
- **git-diff: the fingerprint is now lazy.** `diffStat` (counts only) and `diffFingerprint` (the
  hash — a full patch fetch plus every untracked file's contents, the expensive half) are separate
  functions; verify-gate only fingerprints past its trivial-diff early return, and telemetry only
  fingerprints when a verdict was actually parsed, instead of paying the cost of both on every
  Stop and every recorded verdict regardless of whether either was needed.
- **verify-gate/telemetry/record-verdict: `diffStat` no longer charges the session for work it did
  not do (issue #16).** Reported live: a `git pull` of two already-verified MRs turned a standing
  CONFIRMED verdict stale (`382/6 -> 539/16`) purely from received commits, and separately, a
  pre-existing untracked file was recounted in full on every Stop. Both are fixed without unpinning
  `state.baselineHead`, which stays untouched on disk for the whole session.
  - A SessionStart snapshot (`session-init.ts`) records a content key for every untracked path that
    already exists; `diffStat` now counts an untracked path only when its current key is absent
    from or differs from that snapshot — an identical key means the session never touched it. A
    changed pre-existing file still counts in full, not as a delta (over-count, the accepted
    direction); a genuinely new file always counts.
  - Each measurement derives an *effective* tracked baseline —
    `git merge-base HEAD refs/remotes/<remote>/HEAD`, used only when it is a descendant of the
    pinned `baselineHead` — rather than moving the pin itself. The reference is the remote's
    *default branch*, deliberately not `@{upstream}`: with `@{upstream}`, pushing a commit to a
    feature branch advanced the effective baseline onto the session's own unverified work,
    laundering it out of the measurement. Any uncertainty (no remote, no `origin/HEAD`, a
    merge-base that isn't a descendant of the pin) falls back to the pinned baseline unchanged.
  - Same rewrite closed a live symlink hazard in the untracked half: the old loop called `readFile`
    on every listed path, which follows symlinks — an untracked symlink pointing outside the repo
    read out-of-repo content into the count, and one pointing at a FIFO blocked the hook forever,
    the same hang class as `diffFingerprint`'s own FIFO fix above. The new dispatch uses `lstat`
    and never follows a symlink. A related under-count was closed the same way: untracked listing
    from a subdirectory used to return only that subtree with cwd-relative paths; it is now always
    whole-repo and root-relative regardless of `cwd`.
  - Residual, accepted: a `git pull` still drops a standing `PRAXARCH_VERIFY_WAIVED` waiver, because
    the waiver compares raw fingerprints (HEAD-sensitive by design), not size deltas.
  - Four fail-opens below were found by mutation testing, not by review, and are documented at
    length in `docs/design.md` rather than fixed-and-forgotten, because each is one plausible
    "cleanup" away from returning: the untracked snapshot's own sidecar storage (moving it back into
    `SessionState` reintroduces a 3495ms SessionStart), `Buffer`-typed paths end to end (a `string`
    round-trip corrupts a non-UTF-8 path to U+FFFD and silently zeroes its measurement), stripping
    git path output with `/\n$/` only (a `.trim()` or `/\r?\n$/` variant eats legal trailing
    whitespace in a real path and freezes a fingerprint), and permission-dependent tests gated on a
    functional probe rather than `process.getuid()` (CI running as root makes a uid guard skip
    exactly where it matters).
- **verify-gate/verdict: severity matching is now case-insensitive and fail-closed, and the waiver
  string must start a line.** `summarizeVerdict` compared `severity` against exactly the literals
  `"critical"`/`"major"`, so a `"Critical"` finding or an unrecognized severity like `"blocker"`
  counted as zero and let a CONFIRMED verdict with real critical findings pass the gate; a finding
  now counts toward `criticalOrMajorCount` unless it trims and lowercases to exactly `"minor"`.
  Separately, `WAIVER_PATTERN` matched `PRAXARCH_VERIFY_WAIVED: <reason>` anywhere in the final
  message, including mid-sentence — and the gate's own block message quoted that literal string, so
  an assistant quoting the instruction back could accidentally waive. The pattern is now
  line-start-anchored (`^PRAXARCH_VERIFY_WAIVED:[ \t]*(.+)$`, multiline), and every instruction the
  gate emits was reworded to say "start a line" instead of quoting the waiver string.
- **session-state: `updateSessionState` is now locked, closing issue #4's residual race.** The
  merge-write it added narrowed the window but didn't close it — two callers racing the function
  itself could still interleave read/write pairs, and a fan-out's N parallel `SubagentStop` hooks
  could lose one another's `lastVerifier` update, a silent verify-gate bypass. Every
  read-modify-write now serializes through a per-session lockfile (`open(path, "wx")`,
  `<state file>.lock`); a lock held past 10s is treated as belonging to a dead process and broken
  rather than waited out, and lock acquisition itself never throws — a hook that failed here would
  be worse than the race it closes. verify-gate's three whole-object `writeSessionState` calls
  (loop-guard clear, waiver, block) are converted to `updateSessionState` merge-writes touching
  only the four fields verify-gate owns, so a concurrent writer's `lastVerifier` update always
  survives a verify-gate write.

### Changed

- **verify-gate: the blocking Stop path spawns fewer git subprocesses — no behaviour change.**
  Removed a duplicate `git rev-parse --is-inside-work-tree` probe (`diffStat` now trusts an
  `isGitRepo` result already proven by `resolveMeasurementContext`), and parallelized `diffStat`'s
  three independent probes (baseline chain + numstat, repo root, untracked listing),
  `diffFingerprint`'s three independent probes (status, HEAD, show-toplevel), and
  `session-init`'s ten role-file existence checks. Every failure/classification rule and every
  return value stays exactly as it was; only the number and ordering of git subprocess spawns
  changed.

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
