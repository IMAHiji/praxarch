import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface DiffStat {
  changedLines: number;
  changedFiles: number;
}

/**
 * Sizes the working tree's uncommitted diff (against HEAD), excluding paths that match any
 * ignorePattern substring. Returns zeros if cwd isn't a git repo — the verify-gate treats that
 * as "nothing to gate on" rather than failing the hook.
 */
export async function diffStat(cwd: string, ignorePatterns: string[]): Promise<DiffStat> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("git", ["diff", "HEAD", "--numstat"], { cwd }));
  } catch {
    return { changedLines: 0, changedFiles: 0 };
  }

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
