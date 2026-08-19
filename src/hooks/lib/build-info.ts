import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface BuildInfo {
  ref: string | null;
  branch: string | null;
  dirty: boolean | null;
  builtAt: string | null;
}

const NULL_INFO: BuildInfo = { ref: null, branch: null, dirty: null, builtAt: null };

/**
 * Reads the git ref this hook was built from — written by scripts/write-build-info.mjs as the
 * last step of `pnpm build`, sitting alongside the compiled hook at dist/hooks/build-info.json
 * (and therefore inside a dev-mode symlink install too, since that symlinks the whole hooks/
 * directory). Issue #14 Part B: lets a session tell whether its running gate is merged code or
 * branch code.
 *
 * Never throws: a tarball install predating this file, a build that ran with no git available, or
 * a build-info.json that fails to parse all degrade to nulls rather than crashing the hook that
 * calls this.
 */
export async function readBuildInfo(): Promise<BuildInfo> {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = await readFile(join(here, "..", "build-info.json"), "utf8");
    const parsed = JSON.parse(raw) as Partial<BuildInfo>;
    return {
      ref: typeof parsed.ref === "string" ? parsed.ref : null,
      branch: typeof parsed.branch === "string" ? parsed.branch : null,
      dirty: typeof parsed.dirty === "boolean" ? parsed.dirty : null,
      builtAt: typeof parsed.builtAt === "string" ? parsed.builtAt : null,
    };
  } catch {
    return NULL_INFO;
  }
}

/** `null` when no ref is known (degrade-gracefully case) — never a placeholder string. */
export function formatBuildRef(info: BuildInfo): string | null {
  if (!info.ref) return null;
  const shortRef = info.ref.slice(0, 12);
  const branchPart = info.branch ? `${info.branch}@${shortRef}` : shortRef;
  return info.dirty ? `${branchPart} (dirty)` : branchPart;
}
