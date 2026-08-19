import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { untrackedBaselinePath } from "./paths.js";

/**
 * The untracked-file SessionStart snapshot's own storage, separate from `SessionState` -- see
 * `untrackedBaselinePath`'s doc comment for why. `SessionState.baselineUntrackedCaptured` only
 * records that a capture was *attempted*; the snapshot's actual content (or its unusability) lives
 * here.
 *
 * The on-disk shape is the captured value itself, JSON-serialized directly (`null` literal for an
 * unusable capture, an object for a real one) -- never wrapped or defaulted, so `readUntrackedBaseline`
 * has exactly two outcomes to reason about: a well-formed value it can trust, or a failure it must
 * treat identically to `null`.
 */

export async function writeUntrackedBaseline(
  sessionId: string,
  baseline: Record<string, string> | null,
): Promise<void> {
  const path = untrackedBaselinePath(sessionId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(baseline), "utf8");
}

/**
 * Reads the snapshot written by `writeUntrackedBaseline`. Fails safe in the over-count direction on
 * every kind of trouble -- a missing file (never written, or deleted out from under the session), a
 * corrupt one (truncated write, disk issue, hand-edited), or a well-formed-but-wrong-shaped one
 * (array, string, number) -- by returning `null`, the same "count everything" contract
 * `captureUntrackedBaseline` itself already uses for "no usable snapshot." Never returns `{}` on
 * failure: an empty object is a real, distinct outcome (a session that started with zero untracked
 * files) and must not be confused with "the snapshot is gone" -- both currently cause the same
 * downstream behavior (nothing found for any lookup), but only one of them is actually captured
 * data, and collapsing them would make a corrupt-file bug undetectable by ever comparing what
 * `readUntrackedBaseline` returns.
 */
export async function readUntrackedBaseline(sessionId: string): Promise<Record<string, string> | null> {
  const path = untrackedBaselinePath(sessionId);
  try {
    const raw = await readFile(path, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null) return null;
    if (typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, string>;
  } catch {
    return null;
  }
}

