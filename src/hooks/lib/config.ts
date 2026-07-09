import { readFile } from "node:fs/promises";
import { globalConfigPath, projectConfigPath } from "./paths.js";

export interface VerifyGateConfig {
  /** Minimum changed lines (insertions + deletions) in the session diff before a verifier pass is required. */
  minChangedLines: number;
  /** Minimum distinct changed files before a verifier pass is required. */
  minChangedFiles: number;
  /** Glob-ish path fragments to exclude from the diff-size calculation (lockfiles, generated files). */
  ignorePatterns: string[];
}

export interface RouteGuardConfig {
  /** When false, violations are warnings instead of hard denials. */
  strict: boolean;
  /** Extra keywords (beyond the built-in set) that force routing to security-executor. */
  securityKeywords: string[];
}

export interface PraxarchConfig {
  roleModelOverrides: Record<string, string>;
  verifyGate: VerifyGateConfig;
  routeGuard: RouteGuardConfig;
}

export const DEFAULT_CONFIG: PraxarchConfig = {
  roleModelOverrides: {},
  verifyGate: {
    minChangedLines: 80,
    minChangedFiles: 3,
    ignorePatterns: ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", ".min.js", "dist/"],
  },
  routeGuard: {
    strict: true,
    securityKeywords: [],
  },
};

async function readJsonIfExists(path: string): Promise<Partial<PraxarchConfig> | null> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as Partial<PraxarchConfig>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function mergeConfig(base: PraxarchConfig, override: Partial<PraxarchConfig> | null): PraxarchConfig {
  if (!override) return base;
  return {
    roleModelOverrides: { ...base.roleModelOverrides, ...(override.roleModelOverrides ?? {}) },
    verifyGate: { ...base.verifyGate, ...(override.verifyGate ?? {}) },
    routeGuard: {
      strict: override.routeGuard?.strict ?? base.routeGuard.strict,
      securityKeywords: [
        ...base.routeGuard.securityKeywords,
        ...(override.routeGuard?.securityKeywords ?? []),
      ],
    },
  };
}

export async function loadConfig(cwd: string): Promise<PraxarchConfig> {
  const global = await readJsonIfExists(globalConfigPath());
  const project = await readJsonIfExists(projectConfigPath(cwd));
  return mergeConfig(mergeConfig(DEFAULT_CONFIG, global), project);
}
