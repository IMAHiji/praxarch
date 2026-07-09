#!/usr/bin/env node
import { loadConfig } from "./lib/config.js";
import { emit, readHookInput, type PreToolUseInput, type PreToolUseOutput } from "./lib/hook-io.js";

/**
 * PreToolUse(Agent) — hard-enforces two orchestration rules the policy text alone can't guarantee
 * under pressure: (1) security-sensitive delegations must go to security-executor, (2) ad-hoc
 * fan-out calls that don't use a defined role must declare `model` explicitly rather than
 * silently inheriting the main session's tier.
 */

const KNOWN_ROLES = new Set([
  "scout",
  "Explore",
  "mech-executor",
  "executor",
  "verifier",
  "security-executor",
]);

const BUILTIN_SECURITY_KEYWORDS = [
  "auth",
  "secret",
  "credential",
  "password",
  "jwt",
  "oauth",
  "crypto",
  "encrypt",
  "decrypt",
  "cve",
  "vulnerab",
  "exploit",
  "sql injection",
  "xss",
  "csrf",
  "penetration test",
  "pentest",
];

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

  const haystack = `${prompt} ${description}`.toLowerCase();
  const securityKeywords = [...BUILTIN_SECURITY_KEYWORDS, ...config.routeGuard.securityKeywords];
  const looksSecuritySensitive = securityKeywords.some((kw) => haystack.includes(kw.toLowerCase()));

  if (looksSecuritySensitive && subagentType !== "security-executor") {
    emit(
      decide(
        config.routeGuard.strict,
        `this delegation looks security-sensitive (matched a security keyword) but subagent_type is ` +
          `"${subagentType ?? "unset"}", not "security-executor". Route auth/secrets/crypto/validation ` +
          `work to security-executor per the orchestration policy.`,
      ),
    );
    return;
  }

  const isKnownRole = subagentType !== undefined && KNOWN_ROLES.has(subagentType);
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
