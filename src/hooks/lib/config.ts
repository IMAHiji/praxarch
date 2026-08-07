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
  /**
   * Read-only review roles exempt from the security-keyword redirect. A reviewer of
   * auth/secrets/crypto code necessarily mentions those keywords, and denying it deadlocks
   * against verify-gate — the hardcoded verifier exemption (approved 2026-07-08), generalized.
   * Additive over the default ["verifier"], so a config can add reviewers but never drop it.
   */
  reviewRoles: string[];
}

// Role→model bindings deliberately have no override key here: they live in agent frontmatter,
// and a project retunes them by shadowing the agent file in <project>/.claude/agents/ (project
// agents take precedence over user agents by name — verified empirically via resolvedModel).
export interface PraxarchConfig {
  verifyGate: VerifyGateConfig;
  routeGuard: RouteGuardConfig;
}

/** A parsed-and-shape-validated (but not yet merged/defaulted) config layer. */
export interface ConfigLayer {
  verifyGate?: Partial<VerifyGateConfig>;
  routeGuard?: Partial<RouteGuardConfig>;
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
    reviewRoles: ["verifier"],
  },
};

// Trust boundary: config.json / praxarch.json are project- or user-controlled files read on
// every hook invocation. A malformed or wrongly-shaped file must degrade to defaults-plus-warning,
// never propagate an exception up to the hook's top-level catch — that catch fails the whole
// enforcement layer open, which is exactly what a hostile or merely broken config could exploit.

function shortError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Filters an array down to its string elements, warning once if any were dropped. */
function stringArray(path: string, field: string, value: unknown, warnings: string[]): string[] | undefined {
  if (!Array.isArray(value)) {
    warnings.push(`praxarch config: ${path} ${field} must be an array of strings — ignoring it`);
    return undefined;
  }
  const strings = value.filter((el): el is string => typeof el === "string");
  if (strings.length !== value.length) {
    warnings.push(`praxarch config: ${path} ${field} contains non-string element(s) — dropping them`);
  }
  return strings;
}

/** Reads and JSON-parses a config layer. Never throws: unreadable/invalid JSON → null + warning. */
async function readJsonIfExists(path: string, warnings: string[]): Promise<unknown | null> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    warnings.push(`praxarch config: ${path} is unreadable or not valid JSON — ignoring it (${shortError(err)})`);
    return null;
  }
}

/**
 * Shape-validates one already-parsed config layer. Invalid fields are dropped individually (with
 * a warning naming the path/field/expected type) so one bad field doesn't discard the whole layer,
 * and the default/lower-layer value stands for anything dropped. Unknown keys are ignored silently.
 */
function validateLayer(path: string, raw: unknown, warnings: string[]): ConfigLayer {
  if (!isPlainObject(raw)) {
    warnings.push(`praxarch config: ${path} top-level value must be an object — ignoring it`);
    return {};
  }

  const result: ConfigLayer = {};

  if ("verifyGate" in raw) {
    const vg = raw["verifyGate"];
    if (isPlainObject(vg)) {
      const validated: Partial<VerifyGateConfig> = {};
      if ("minChangedLines" in vg) {
        if (isFiniteNonNegativeNumber(vg["minChangedLines"])) {
          validated.minChangedLines = vg["minChangedLines"];
        } else {
          warnings.push(
            `praxarch config: ${path} verifyGate.minChangedLines must be a finite number >= 0 — ignoring it`,
          );
        }
      }
      if ("minChangedFiles" in vg) {
        if (isFiniteNonNegativeNumber(vg["minChangedFiles"])) {
          validated.minChangedFiles = vg["minChangedFiles"];
        } else {
          warnings.push(
            `praxarch config: ${path} verifyGate.minChangedFiles must be a finite number >= 0 — ignoring it`,
          );
        }
      }
      if ("ignorePatterns" in vg) {
        const patterns = stringArray(path, "verifyGate.ignorePatterns", vg["ignorePatterns"], warnings);
        if (patterns !== undefined) validated.ignorePatterns = patterns;
      }
      if ("verdictRoles" in vg) {
        const roles = stringArray(path, "verifyGate.verdictRoles", vg["verdictRoles"], warnings);
        if (roles !== undefined) validated.verdictRoles = roles;
      }
      result.verifyGate = validated;
    } else {
      warnings.push(`praxarch config: ${path} verifyGate must be an object — ignoring it`);
    }
  }

  if ("routeGuard" in raw) {
    const rg = raw["routeGuard"];
    if (isPlainObject(rg)) {
      const validated: Partial<RouteGuardConfig> = {};
      if ("strict" in rg) {
        if (typeof rg["strict"] === "boolean") {
          validated.strict = rg["strict"];
        } else {
          warnings.push(`praxarch config: ${path} routeGuard.strict must be a boolean — ignoring it`);
        }
      }
      if ("securityKeywords" in rg) {
        const keywords = stringArray(path, "routeGuard.securityKeywords", rg["securityKeywords"], warnings);
        if (keywords !== undefined) validated.securityKeywords = keywords;
      }
      if ("knownRoles" in rg) {
        const roles = stringArray(path, "routeGuard.knownRoles", rg["knownRoles"], warnings);
        if (roles !== undefined) validated.knownRoles = roles;
      }
      if ("reviewRoles" in rg) {
        const roles = stringArray(path, "routeGuard.reviewRoles", rg["reviewRoles"], warnings);
        if (roles !== undefined) validated.reviewRoles = roles;
      }
      result.routeGuard = validated;
    } else {
      warnings.push(`praxarch config: ${path} routeGuard must be an object — ignoring it`);
    }
  }

  return result;
}

function mergeConfig(base: PraxarchConfig, override: ConfigLayer | null): PraxarchConfig {
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
      reviewRoles: [...base.routeGuard.reviewRoles, ...(override.routeGuard?.reviewRoles ?? [])],
    },
  };
}

export interface LoadedConfig {
  config: PraxarchConfig;
  /** Human-readable notices about ignored/dropped config content — never affects enforcement. */
  warnings: string[];
}

export async function loadConfig(cwd: string): Promise<LoadedConfig> {
  const warnings: string[] = [];

  const globalPath = globalConfigPath();
  const globalRaw = await readJsonIfExists(globalPath, warnings);
  const globalLayer = globalRaw === null ? null : validateLayer(globalPath, globalRaw, warnings);

  const projectPath = projectConfigPath(cwd);
  const projectRaw = await readJsonIfExists(projectPath, warnings);
  const projectLayer = projectRaw === null ? null : validateLayer(projectPath, projectRaw, warnings);

  const config = mergeConfig(mergeConfig(DEFAULT_CONFIG, globalLayer), projectLayer);
  return { config, warnings };
}
