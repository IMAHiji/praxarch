import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * The commit a session's diff should actually be measured from: the pinned SessionStart baseline,
 * advanced *only* across commits the session received rather than wrote. `pinned` is never
 * modified or persisted — this function returns a per-measurement derivation, and the caller is
 * responsible for feeding the result straight into a `git diff`/`git diff --numstat` invocation
 * without ever writing it back to `state.baselineHead` (`session-state.ts:74`, `verify-gate.ts:148`
 * document why that pin is load-bearing: a moving baseline lets a waived or verified diff silently
 * fall out of scope, which is a fail-*open*, strictly worse than the over-count this exists to fix).
 *
 * The reference used to find "already upstream" is `refs/remotes/<remote>/HEAD` — the remote's
 * default branch — and deliberately **not** `@{upstream}` (the current branch's configured
 * tracking ref). Verified against real repos: after `git push` on a feature branch,
 * `merge-base(HEAD, @{upstream})` advances onto the commit the session itself just pushed, which
 * would launder unreviewed work past the gate the moment it's pushed rather than merged.
 * `merge-base(HEAD, origin/HEAD)` does not move in that scenario, because laundering would require
 * the remote's default branch itself to move. Two ways that can happen, both worth naming:
 * pushing directly to the default branch (normally branch-protected, and against policy
 * regardless — the actual mitigation for this route lives outside this module), and running
 * `git remote set-head <remote> <branch>` locally to repoint which branch this module treats as
 * "default" (verified: `git remote set-head origin feature` after pushing a feature branch makes
 * this function return the session's own commit instead of the pin). The second route needs no
 * remote permissions at all — it's a local config change — so it is the cheaper of the two, though
 * still one this module cannot see happen; it can only trust whatever `origin/HEAD` resolves to at
 * measurement time. That distinction (the reference, not the git commands around it) is the entire
 * security property this module provides; do not substitute `@{upstream}` for the reference.
 *
 * Every failure mode below returns `pinned` unchanged (fail closed — uncertainty must never
 * resolve to counting less than the pinned baseline would):
 * - `pinned` itself is unset (`null`/`undefined`) — nothing to advance from, and nothing to fall
 *   back to either; the caller's own "diff from HEAD" default applies.
 * - no remote configured for the current branch (falls back to trying `"origin"`, but that guess
 *   can still fail at the next step) or a detached HEAD (no current branch to look up at all).
 * - `refs/remotes/<remote>/HEAD` doesn't exist. This is not reliably "however the repo was set
 *   up": on a current git (verified on 2.54.0), `git init` + `git remote add` + `git fetch` sets
 *   it exactly the way `git clone` does. The ref is genuinely absent only when it was explicitly
 *   removed (`git remote set-head <remote> -d`) or never created because the fetch that would
 *   have set it happened on an old git version and was never repeated — the user-side fix in
 *   either case is `git remote set-head <remote> -a`.
 * - `git merge-base HEAD <tip>` fails outright (e.g. the remote-tracking ref is unreachable from
 *   HEAD in a way merge-base can't resolve).
 * - the candidate merge-base is **not** a descendant-or-equal of `pinned`. This is the guard that
 *   keeps the baseline from ever moving *backwards* relative to the pin (a `reset --hard`, a
 *   checkout of an unrelated branch, a rewritten history) — the returned commit is always both
 *   reachable from HEAD and a descendant-or-equal of `pinned`, so the measured diff is always a
 *   *subset* of the pinned-baseline diff and can never exclude real working-tree changes.
 *
 * Any git invocation itself failing (missing binary, cwd not a repo, etc.) is folded into the same
 * "return pinned" outcome — this function has no independent `null` result of its own beyond
 * mirroring an unset `pinned`.
 */
export async function resolveEffectiveBaseline(cwd: string, pinned: string | null | undefined): Promise<string | null> {
  // Hardened, not just `pinned ?? null`: `pinned` is unreachable as `""` today (`state.baselineHead`
  // is only ever a real `rev-parse HEAD` result or `null`), but `"" ?? null` evaluates to `""` --
  // `??` only replaces `null`/`undefined`, not other falsy values -- and Task 7's planned caller
  // does `effective ?? "HEAD"`, which has the same blind spot. An empty string is not a usable
  // baseline under any reading of this contract, so every falsy `pinned` collapses to the same
  // `null` result here rather than passing a footgun on to whichever caller reaches for `??` next.
  if (!pinned) return null;

  const remote = await resolveRemoteName(cwd);

  let tip: string;
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/HEAD^{commit}`],
      { cwd },
    );
    tip = stdout.trim();
    if (!tip) return pinned;
  } catch {
    // No remote-tracking default branch to advance onto — see the doc comment above for when this
    // ref is genuinely absent (it's not "however the repo happened to be set up").
    return pinned;
  }

  let candidate: string;
  try {
    const { stdout } = await execFileAsync("git", ["merge-base", "HEAD", tip], { cwd });
    candidate = stdout.trim();
    if (!candidate) return pinned;
  } catch {
    return pinned;
  }

  // Descendant check: only advance when the candidate is reachable forward from the pin. Exit 0
  // means "is an ancestor of (or equal to)"; any non-zero exit (including the git-defined "is not
  // an ancestor" case) or a thrown error both collapse to the same fail-closed outcome.
  try {
    await execFileAsync("git", ["merge-base", "--is-ancestor", pinned, candidate], { cwd });
  } catch {
    return pinned;
  }

  return candidate;
}

// The current branch's configured remote, falling back to "origin" when either the branch can't
// be resolved (detached HEAD) or has no `branch.<name>.remote` config (a branch created without
// `--track`, or one whose tracking config was never set). The fallback is a guess, not a
// guarantee: if "origin" doesn't exist, the caller's own `refs/remotes/<remote>/HEAD` lookup fails
// next and folds back to `pinned` the same way an explicit remote lookup failure would.
async function resolveRemoteName(cwd: string): Promise<string> {
  try {
    const { stdout: branch } = await execFileAsync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd });
    const branchName = branch.trim();
    if (!branchName) return "origin";
    const { stdout: remote } = await execFileAsync("git", ["config", "--get", `branch.${branchName}.remote`], {
      cwd,
    });
    const remoteName = remote.trim();
    return remoteName || "origin";
  } catch {
    return "origin";
  }
}
