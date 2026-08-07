import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface DiffStat {
  changedLines: number;
  changedFiles: number;
}

function parseNumstat(stdout: string, ignorePatterns: string[]): DiffStat {
  let changedLines = 0;
  let changedFiles = 0;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const [added, removed, path] = line.split("\t");
    if (path === undefined) continue;
    if (ignorePatterns.some((pattern) => path.includes(pattern))) continue;
    changedFiles += 1;
    const addedNum = added === "-" ? 0 : Number(added);
    const removedNum = removed === "-" ? 0 : Number(removed);
    changedLines += addedNum + removedNum;
  }
  return { changedLines, changedFiles };
}

/**
 * Sizes the session's real diff: changes against `baseline` (the HEAD sha recorded at
 * SessionStart) when given, so committed work still gets measured — plus untracked new files,
 * which `git diff` never sees. Excludes paths matching any ignorePattern substring. Returns
 * zeros if cwd isn't a git repo — the verify-gate treats that as "nothing to gate on" rather
 * than failing the hook.
 */
export async function diffStat(
  cwd: string,
  ignorePatterns: string[],
  baseline?: string | null,
): Promise<DiffStat> {
  let tracked: DiffStat = { changedLines: 0, changedFiles: 0 };
  try {
    let stdout: string;
    const target = baseline ? baseline : "HEAD";
    try {
      ({ stdout } = await execFileAsync("git", ["diff", target, "--numstat"], { cwd }));
    } catch {
      if (!baseline) throw new Error("no HEAD diff available");
      // Baseline sha may be stale/unknown (e.g. repo reset) — fall back to HEAD diff.
      ({ stdout } = await execFileAsync("git", ["diff", "HEAD", "--numstat"], { cwd }));
    }
    tracked = parseNumstat(stdout, ignorePatterns);
  } catch {
    // No usable committed diff (e.g. no commits yet, or not a git repo) — tracked portion is
    // zero, but untracked-file counting below still runs; a non-git cwd fails open via its own
    // catch, yielding zeros overall rather than throwing.
  }

  let untrackedPaths: string[] = [];
  try {
    const { stdout: untrackedStdout } = await execFileAsync(
      "git",
      ["ls-files", "--others", "--exclude-standard"],
      { cwd },
    );
    untrackedPaths = untrackedStdout.split("\n").filter((line) => line.trim().length > 0);
  } catch {
    untrackedPaths = [];
  }

  let changedLines = tracked.changedLines;
  let changedFiles = tracked.changedFiles;
  for (const path of untrackedPaths) {
    if (ignorePatterns.some((pattern) => path.includes(pattern))) continue;
    changedFiles += 1;
    try {
      const contents = await readFile(join(cwd, path), "utf8");
      changedLines += (contents.match(/\n/g) ?? []).length;
    } catch {
      // Unreadable file (race, permissions, binary) — count the file itself but no lines.
    }
  }

  return { changedLines, changedFiles };
}
