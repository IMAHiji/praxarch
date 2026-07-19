#!/usr/bin/env node
import { loadConfig } from "./lib/config.js";
import { emit, readHookInput, type PreToolUseInput, type PreToolUseOutput } from "./lib/hook-io.js";

/**
 * PreToolUse(Agent) — hard-enforces three orchestration rules the policy text alone can't
 * guarantee under pressure: (1) security-sensitive delegations must go to security-executor,
 * (2) ad-hoc fan-out calls that don't use a defined role must declare `model` explicitly rather
 * than silently inheriting the main session's tier, (3) defined-role calls must NOT pass an
 * explicit `model`, which would override the role's frontmatter binding.
 */

// The six praxarch-installed roles. Config (routeGuard.knownRoles) extends this set at runtime
// for defined roles praxarch doesn't own — see RouteGuardConfig.
const BUILTIN_ROLES = [
  "scout",
  "Explore",
  "mech-executor",
  "executor",
  "verifier",
  "security-executor",
];

// Keywords match at word boundaries, case-insensitively. A trailing "*" makes it a stem
// (open-ended suffix); without it the match is exact-word. Substring matching is what made
// "auth" flag every prompt containing "author" or "Co-Authored-By".
const BUILTIN_SECURITY_KEYWORDS = [
  "auth",
  "authenticat*",
  "authoriz*",
  "authoris*",
  "secret",
  "secrets",
  "credential*",
  "password*",
  "jwt",
  "oauth*",
  "crypto",
  "cryptograph*",
  "encrypt*",
  "decrypt*",
  "cve",
  "vulnerab*",
  "exploit*",
  "sql injection",
  "xss",
  "csrf",
  "penetration test*",
  "pentest*",
];

function keywordPattern(keyword: string): RegExp {
  const isStem = keyword.endsWith("*");
  const body = isStem ? keyword.slice(0, -1) : keyword;
  const escaped = body.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}${isStem ? "" : "\\b"}`, "i");
}

function allow(): PreToolUseOutput {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
}

function decide(strict: boolean, reason: string): PreToolUseOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: strict ? "deny" : "allow",
      permissionDecisionReason: reason,
    },
    systemMessage: strict ? `praxarch route-guard: blocked — ${reason}` : `praxarch route-guard: ${reason}`,
  };
}

async function main(): Promise<void> {
  const input = await readHookInput<PreToolUseInput>();

  if (input.tool_name !== "Agent") {
    emit(allow());
    return;
  }

  const { subagent_type: subagentType, model, prompt = "", description = "" } = input.tool_input;
  const config = await loadConfig(input.cwd);

  const haystack = `${prompt} ${description}`;
  const securityKeywords = [...BUILTIN_SECURITY_KEYWORDS, ...config.routeGuard.securityKeywords];
  const matchedKeyword = securityKeywords.find((kw) => keywordPattern(kw).test(haystack));

  // "verifier" is exempt (user-approved 2026-07-08): it is a read-only review role that never
  // edits source, and blocking it here conflicts with verify-gate, which requires a
  // verifier-role pass on exactly these security-sensitive tickets.
  if (matchedKeyword !== undefined && subagentType !== "security-executor" && subagentType !== "verifier") {
    emit(
      decide(
        config.routeGuard.strict,
        `this delegation looks security-sensitive (matched keyword "${matchedKeyword}") but ` +
          `subagent_type is "${subagentType ?? "unset"}", not "security-executor". Route ` +
          `auth/secrets/crypto/validation work to security-executor per the orchestration policy.`,
      ),
    );
    return;
  }

  const knownRoles = new Set([...BUILTIN_ROLES, ...config.routeGuard.knownRoles]);
  const isKnownRole = subagentType !== undefined && knownRoles.has(subagentType);

  // The inverse of the fan-out rule: an explicit model on a defined role silently overrides the
  // role's frontmatter binding. Live telemetry (2026-07-09) showed this defeating tiered routing
  // on 40/40 delegations — every opus-pinned role actually ran on the model passed in the call.
  if (isKnownRole && model) {
    emit(
      decide(
        config.routeGuard.strict,
        `delegation to defined role "${subagentType}" passes explicit model "${model}", which ` +
          `overrides the role's frontmatter binding and defeats tiered routing. Omit model — ` +
          `role→model bindings live in the agent file.`,
      ),
    );
    return;
  }

  if (!isKnownRole && !model) {
    emit(
      decide(
        config.routeGuard.strict,
        `ad-hoc fan-out Agent call (subagent_type "${subagentType ?? "unset"}") has no explicit ` +
          `model. Fan-out calls must declare model explicitly rather than inheriting the main ` +
          `session's tier — see the orchestration policy.`,
      ),
    );
    return;
  }

  emit(allow());
}

main().catch((err: unknown) => {
  // A route-guard crash must never block the session — fail open with a visible warning.
  process.stderr.write(`praxarch route-guard error (failing open): ${String(err)}\n`);
  emit(allow());
});
