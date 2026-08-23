import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { sessionLockPath, sessionStatePath } from "./paths.js";

export interface VerifierRecord {
  verdict: "CONFIRMED" | "REFUTED";
  findingsCount: number;
  criticalOrMajorCount: number;
  recordedAt: string;
  /** Fingerprint of the diff this verdict was recorded against. Null in records predating capture. */
  diffHash?: string | null;
  changedLines?: number | null;
  changedFiles?: number | null;
}

export interface DelegationRecord {
  role: string;
  /** Model requested in the Agent call, or "inherited" when unset. */
  model: string;
  /** Model the subagent actually ran on, from tool_response. Null in records predating capture. */
  resolvedModel: string | null;
  totalTokens: number | null;
  durationMs: number | null;
  at: string;
  /**
   * Dispatch-time `tool_response.agentId`, the correlation key `SubagentStop` matches against its
   * own `agent_id` to update this record in place. Null when the field was absent (e.g. records
   * predating capture, or a shape that omitted it) — SubagentStop must never guess a match in
   * that case, only skip the update.
   */
  agentId?: string | null;
  /**
   * Fields below are filled in later by SubagentStop, once the delegation completes — null (or
   * absent) until then. Distinct from `lastVerifier`, which is what verify-gate actually reads;
   * these exist so `delegations[]` (and anything downstream reading it) reflects the same
   * outcome per-delegation rather than only the session's single latest verdict.
   */
  verdict?: "CONFIRMED" | "REFUTED" | null;
  findingsCount?: number | null;
  criticalOrMajorCount?: number | null;
}

export interface SessionState {
  sessionId: string;
  startedAt: string;
  delegations: DelegationRecord[];
  lastVerifier: VerifierRecord | null;
  /** Consecutive verify-gate blocks in the current stop cycle — the gate's loop guard. */
  verifyGateConsecutiveBlocks?: number;
  /**
   * Diff fingerprint recorded alongside the last consecutive block, so verify-gate can tell
   * whether the tree has moved since the blocks that tripped the loop guard — a changed tree
   * resets the counter (new, unverified work shouldn't inherit an old, unrelated trip count); an
   * unknown fingerprint (`null`) never resets it, since that would hand back an infinite-loop
   * vector via a diff the gate can no longer see.
   */
  verifyGateBlockHash?: string | null;
  /**
   * Total verify-gate blocks in the current stop cycle, across ALL diffs — unlike
   * `verifyGateConsecutiveBlocks`, this is never reset by tree movement, only by a cycle boundary
   * or a genuine allow. It's the hard backstop against a churning tree (a file touched between
   * every round) resetting `verifyGateConsecutiveBlocks` before it ever reaches its own limit,
   * which would otherwise make the loop guard unreachable.
   */
  verifyGateCycleBlocks?: number;
  /**
   * `HEAD` sha captured at SessionStart, used by verify-gate to diff against the state at the
   * start of the session rather than the working tree's uncommitted changes only. Null when
   * cwd wasn't a git repo (or had no commits yet) at session start.
   */
  baselineHead?: string | null;
  /**
   * Marks that a SessionStart untracked-file capture was attempted for this session -- the
   * untracked counterpart to `baselineHead`, but not the snapshot's content: the actual result
   * (content keys per untracked path, or `null` if the capture came back unusable) is stored
   * separately, in its own file keyed by session ID (see `untrackedBaselinePath` in `lib/paths.ts`
   * and `lib/untracked-baseline-store.ts`), never inlined here. Session state is re-read,
   * re-parsed, and re-written on every PostToolUse (telemetry.ts); an untracked snapshot is written
   * once and read rarely -- sharing one file for both meant every hot-path write paid the cost of
   * serializing a snapshot that could hold thousands of entries.
   *
   * Absent (key missing from the object entirely) means never captured: a session predating this
   * field, or a hook run that hasn't reached SessionStart's capture step yet. **Absent is not the
   * same as "captured but unusable" here** -- unlike the snapshot file's own `null`, which does mean
   * that -- because the marker's only job is to gate re-capture (see `session-init.ts`'s guard):
   * once present, it must never be retried mid-session regardless of the value captured, or a
   * baseline that moved partway through would launder in-session files out of scope by making them
   * look pre-existing on a later Stop. `true` is the only value ever written.
   */
  baselineUntrackedCaptured?: boolean;
  /**
   * cwd (SessionStart's `input.cwd`, stored verbatim) that every later measurement must return to
   * -- `baselineHead` and the untracked snapshot above are captured from this same directory, so a
   * hook or CLI invocation that later runs from a different cwd (e.g. a shell that `cd`'d into a
   * worktree) must still measure this one, not wherever it happens to be sitting; see
   * `resolveMeasurementCwd` in `lib/measurement-cwd.ts`, the single place every measurement site
   * resolves against this field. Absent (key missing) means legacy: a session that started before
   * this field existed, which must keep measuring from the hook/CLI cwd exactly as before -- an
   * absent anchor is never "captured late" on a resume, the same laundering trap
   * `baselineUntrackedCaptured` guards against (see that field's comment and
   * `session-init.ts`'s guard). Present-but-unusable -- either the directory no longer exists, or
   * it exists but isn't a git repo while the hook cwd is -- is a distinct case from absent and must
   * fail the measurement closed rather than falling back to the hook cwd -- silently falling back
   * would resurrect exactly the bug this field exists to close. See `resolveMeasurementCwd` in
   * `lib/measurement-cwd.ts` for the authoritative resolution rules, including the one case where a
   * non-repo anchor is still returned rather than failing closed.
   */
  baselineCwd?: string;
  /**
   * Diff fingerprint at the moment a `PRAXARCH_VERIFY_WAIVED:` waiver was accepted. The gate
   * measures the whole session's diff against `baselineHead`, so without this a waived diff
   * re-blocks on every subsequent stop — including turns that changed nothing at all, since the
   * cumulative diff is still there. Holding the fingerprint lets the waiver stand until the work
   * actually moves; the moment the diff differs, the waiver no longer applies and the gate blocks
   * again on its own. Never set to null: an unhashable diff must not become permanently waived.
   */
  verifyGateWaivedHash?: string;
}

function emptyState(sessionId: string): SessionState {
  return {
    sessionId,
    startedAt: new Date().toISOString(),
    delegations: [],
    lastVerifier: null,
    baselineHead: null,
  };
}

/**
 * Moves an unparseable state file aside and returns empty state. Empty state is the fail-CLOSED
 * outcome: it has no `lastVerifier`, so verify-gate demands a verifier pass rather than allowing.
 * The alternative — throwing — escapes verify-gate's `main()` into its crash handler, which emits
 * an allow, permanently disabling the gate for that session.
 */
async function quarantineCorruptState(path: string, sessionId: string): Promise<SessionState> {
  try {
    await rename(path, `${path}.corrupt-${Date.now()}`);
  } catch {
    // Best-effort: if the rename fails the caller still gets empty state (the fail-closed
    // outcome), and the next write replaces the corrupt file anyway.
  }
  process.stderr.write(
    `praxarch: session state for ${sessionId} was corrupt — quarantined to ${path}.corrupt-* and reset to empty state\n`,
  );
  return emptyState(sessionId);
}

export async function readSessionState(sessionId: string): Promise<SessionState> {
  const path = sessionStatePath(sessionId);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyState(sessionId);
    // A non-ENOENT read failure (permissions, the path being a directory) is an environment
    // problem, not corruption — quarantining it would fail too. Propagate, unchanged.
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return await quarantineCorruptState(path, sessionId);
  }
  // Well-formed JSON that isn't a plain object (`null`, `[]`, `42`) would null-dereference in
  // every caller — same quarantine treatment as a parse failure.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return await quarantineCorruptState(path, sessionId);
  }
  return parsed as SessionState;
}

/**
 * Atomic write: a full temp file in the same directory, then `rename(2)` over the target. A plain
 * in-place `writeFile` leaves truncated JSON behind when the process is killed mid-write, and
 * `readSessionState` used to throw on that — which, from verify-gate's crash handler, is a
 * permanent silent fail-open for the rest of that session. `rename` is atomic within a filesystem,
 * so a reader sees either the whole old file or the whole new one, never a partial.
 */
export async function writeSessionState(state: SessionState): Promise<void> {
  const path = sessionStatePath(state.sessionId);
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(tmpPath, JSON.stringify(state, null, 2), "utf8");
    await rename(tmpPath, path);
  } catch (err) {
    // Best-effort cleanup so a failed write doesn't leave a stray temp file behind; the original
    // failure is what the caller must see.
    try {
      await unlink(tmpPath);
    } catch {
      // Nothing useful to do — the temp file may never have been created.
    }
    throw err;
  }
}

// A lock held longer than this is assumed to belong to a dead process (a hook killed at the
// harness timeout, a crashed CLI) and is broken rather than waited out. Generous relative to a
// real update, which is a read, a mutate and an atomic rename.
const LOCK_STALE_MS = 10_000;
// Poll interval while a live lock is held. Short enough that a normal handoff is imperceptible.
const LOCK_RETRY_INTERVAL_MS = 25;
// Total time spent waiting before giving up and proceeding UNLOCKED. Never throws: a hook that
// fails here would be worse than the lost-update race this exists to close — telemetry and
// subagent-stop would fail outright, and verify-gate would take its crash path, which fails OPEN.
const LOCK_MAX_WAIT_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Per-session advisory lock. `open(path, "wx")` is O_CREAT|O_EXCL — the atomic "create only if
 * absent" primitive this needs; nothing here relies on advisory locking support in the filesystem.
 * Returns a release function that is always safe to call, including when the lock was never
 * acquired.
 */
async function acquireSessionLock(sessionId: string): Promise<() => Promise<void>> {
  const path = sessionLockPath(sessionId);
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;
  let mkdirRetried = false;
  for (;;) {
    try {
      const handle = await open(path, "wx");
      try {
        await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`, "utf8");
      } finally {
        await handle.close();
      }
      return async () => {
        try {
          await unlink(path);
        } catch {
          // Already gone (broken as stale by another process) — nothing to do.
        }
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" && !mkdirRetried) {
        // State dir doesn't exist yet (fresh PRAXARCH_HOME) — create it and retry the open once.
        // An EEXIST on the retry falls into the normal wait loop below.
        mkdirRetried = true;
        try {
          await mkdir(dirname(path), { recursive: true });
          continue;
        } catch (mkdirErr) {
          process.stderr.write(
            `praxarch: session lock unavailable (${(mkdirErr as NodeJS.ErrnoException).code}), proceeding unlocked\n`,
          );
          return async () => undefined;
        }
      }
      if (code !== "EEXIST") {
        // The lock directory is unwritable, or something else is structurally wrong. Proceed
        // unlocked rather than failing the caller.
        process.stderr.write(`praxarch: session lock unavailable (${code}), proceeding unlocked\n`);
        return async () => undefined;
      }
    }

    // Held. Break it if it is stale, otherwise wait.
    try {
      const st = await stat(path);
      if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        try {
          await unlink(path);
        } catch {
          // Someone else broke it first — fall through and retry the create.
        }
        continue;
      }
    } catch {
      // Vanished between the failed create and the stat — retry the create immediately.
      continue;
    }

    if (Date.now() >= deadline) {
      process.stderr.write(
        `praxarch: session-state lock for ${sessionId} was held for more than ${LOCK_MAX_WAIT_MS}ms — proceeding without it\n`,
      );
      return async () => undefined;
    }
    await sleep(LOCK_RETRY_INTERVAL_MS);
  }
}

/**
 * Merge-write for callers (telemetry) that own only a subset of state's fields and may run
 * concurrently with another writer (verify-gate) that owns the rest. Re-reads the freshest
 * on-disk snapshot immediately before mutating and writing, rather than writing back whatever
 * was read at the start of a possibly-long-running caller — so a concurrent writer's change that
 * lands anywhere before this call still survives, instead of being silently overwritten by a
 * stale whole-object write. `mutate` must touch only the fields the caller owns; anything it
 * doesn't touch passes through unchanged from the fresh read. Serialized by a per-session
 * lockfile (see acquireSessionLock above), so two callers racing this function no longer
 * interleave read/write pairs. `writeSessionState` itself deliberately does NOT take the lock —
 * the lock is not reentrant, and a nested acquisition would self-deadlock; every concurrent
 * writer must go through this function.
 */
export async function updateSessionState(
  sessionId: string,
  mutate: (state: SessionState) => void,
): Promise<void> {
  const release = await acquireSessionLock(sessionId);
  try {
    const state = await readSessionState(sessionId);
    mutate(state);
    await writeSessionState(state);
  } finally {
    // Released even when `mutate` or the write throws — a held lock outliving its process is what
    // LOCK_STALE_MS exists to clean up, and leaking one on a routine error would make that the
    // common case.
    await release();
  }
}
