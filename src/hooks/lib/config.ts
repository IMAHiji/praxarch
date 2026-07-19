import { readFile } from "node:fs/promises";
import { globalConfigPath, projectConfigPath } from "./paths.js";

export interface VerifyGateConfig {
  /** Minimum changed lines (insertions + deletions) in the session diff before a verifier pass is required. */
  minChangedLines: number;
  /** Minimum distinct changed files before a verifier pass is required. */
  minChangedFiles: number;
  /** Glob-ish path fragments to exclude from the diff-size calculation (lockfiles, generated files). */
  ignorePatterns: string[];
  /**
   * Roles whose trailing JSON verdict telemetry records for the verify-gate. Without this, an
   * /orchestrate run's plan-reviewer pass goes unrecorded and the gate demands a second review
   * at stop. Additive over the default ["verifier"] — unlike verifyGate's other keys, which
   * override wholesale — so a config can add its own review roles but never drop the canonical
   * verifier. The added role's report contract must end with the same JSON verdict block the
   * verifier template mandates.
   */
  verdictRoles: string[];
}

export interface RouteGuardConfig {
  /** When false, violations are warnings instead of hard denials. */
  strict: boolean;
  /**
   * Extra keywords (beyond the built-in set) that force routing to security-executor.
   * Matched at word boundaries, case-insensitively; a trailing "*" matches the stem's suffixes.
   */
  securityKeywords: string[];
  /**
   * Extra subagent types (beyond the built-in six roles) treated as defined roles: their model
   * comes from agent-file frontmatter, so delegations to them must omit `model`. For agents
   * praxarch doesn't install (orchestrate-pipeline roles, plugin agents with frontmatter
   * bindings) — without this, strict mode denies them for lacking an explicit `model`, and
   * adding `model` to satisfy the guard overrides the very binding it exists to protect.
   */
  knownRoles: string[];
}

// Role→model bindings deliberately have no override key here: they live in agent frontmatter,
// and a project retunes them by shadowing the agent file in <project>/.claude/agents/ (project
// agents take precedence over user agents by name — verified empirically via resolvedModel).
export interface PraxarchConfig {
  verifyGate: VerifyGateConfig;
  routeGuard: RouteGuardConfig;
}

export const DEFAULT_CONFIG: PraxarchConfig = {
  verifyGate: {
    minChangedLines: 80,
    minChangedFiles: 3,
    ignorePatterns: ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", ".min.js", "dist/"],
    verdictRoles: ["verifier"],
  },
  routeGuard: {
    strict: true,
    securityKeywords: [],
    knownRoles: [],
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
    verifyGate: {
      ...base.verifyGate,
      ...(override.verifyGate ?? {}),
      verdictRoles: [
        ...base.verifyGate.verdictRoles,
        ...(override.verifyGate?.verdictRoles ?? []),
      ],
    },
    routeGuard: {
      strict: override.routeGuard?.strict ?? base.routeGuard.strict,
      securityKeywords: [
        ...base.routeGuard.securityKeywords,
        ...(override.routeGuard?.securityKeywords ?? []),
      ],
      knownRoles: [...base.routeGuard.knownRoles, ...(override.routeGuard?.knownRoles ?? [])],
    },
  };
}

export async function loadConfig(cwd: string): Promise<PraxarchConfig> {
  const global = await readJsonIfExists(globalConfigPath());
  const project = await readJsonIfExists(projectConfigPath(cwd));
  return mergeConfig(mergeConfig(DEFAULT_CONFIG, global), project);
}
