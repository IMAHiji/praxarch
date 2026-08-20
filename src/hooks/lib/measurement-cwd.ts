import { access } from "node:fs/promises";
import { isGitRepo } from "./git-diff.js";

/**
 * Single dispatch point every measurement site (verify-gate, telemetry, subagent-stop,
 * record-verdict) resolves against before touching `diffStat`/`diffFingerprint` -- see issue #23:
 * a hook or CLI invocation that runs from a different cwd than the one SessionStart captured
 * baselines in (e.g. a shell that `cd`'d into a worktree) must still measure the baseline's own
 * directory, never wherever it happens to be sitting. Exported as one function, not duplicated per
 * call site, because two hand-rolled fallbacks are exactly the kind of thing that drifts out of
 * sync with each other.
 *
 * - `baselineCwd === undefined` (legacy session, predates this field) -> `hookCwd`, today's
 *   behavior unchanged.
 * - `baselineCwd` set but missing/inaccessible on disk (deleted worktree, moved checkout) ->
 *   `null`. This is deliberately NOT a fallback to `hookCwd`: `diffStat` returns `{0, 0}` (allow)
 *   when its cwd argument isn't a git repo at all, so silently substituting the hook cwd here
 *   could hand back a trivially-empty diff instead of the measurement failure this actually is.
 * - `baselineCwd` set, exists on disk, but is not itself a git repo -> the outcome depends on
 *   `hookCwd`, because the two failure modes this must tell apart look identical from `access()`
 *   alone:
 *     - `hookCwd` IS inside a git repo -> `null`. This is the laundering case the anchor exists to
 *       catch: a session that genuinely started outside any repo, then `cd`'d into one and did
 *       real work there, must not have that work measured as "anchor is a non-repo dir, so treat
 *       as trivial" -- that is exactly `diffStat`'s `{0, 0}` fail-open, reached through the
 *       anchor instead of around it. Fail closed instead: the caller must demand a verifier pass.
 *     - `hookCwd` is ALSO not inside a git repo -> `baselineCwd` (the anchor), preserving today's
 *       behavior for a session that never entered a repo at all: `diffStat`'s own `{0, 0}` on a
 *       non-repo cwd already handles that case correctly, and returning `null` here instead would
 *       turn a genuinely non-repo session into a permanent, unwaivable block for no defect it
 *       caused. Both cwds agreeing that there's no repo in play is the one shape where "nothing to
 *       gate on" is still the right read.
 *   Exported `isGitRepo` (git-diff.ts) is reused rather than reimplemented, so this stays in sync
 *   with the exact same positive "is this a working tree" check `diffStat`/`diffFingerprint` use
 *   internally -- never inferred from a diff/status call having failed, which is the conflation
 *   the whole-repo fingerprinting work already had to close once (see git-diff.ts's own comment on
 *   `isGitRepo`).
 * - `baselineCwd` set, exists, and is a git repo -> `baselineCwd`, the anchor -- the common case.
 *
 * Callers must treat `null` as a measurement failure (verify-gate's `measurementFailed` path,
 * telemetry/subagent-stop/record-verdict's `diffHash: null` / counts `null`), never as "nothing
 * changed."
 */
export async function resolveMeasurementCwd(
  baselineCwd: string | undefined,
  hookCwd: string,
): Promise<string | null> {
  if (baselineCwd === undefined) return hookCwd;

  try {
    await access(baselineCwd);
  } catch {
    return null;
  }

  if (await isGitRepo(baselineCwd)) return baselineCwd;

  // Anchor exists but isn't a repo -- only a hook cwd that IS a repo makes this the divergence
  // (laundering) case; see the doc comment above for why the two branches diverge.
  return (await isGitRepo(hookCwd)) ? null : baselineCwd;
}
