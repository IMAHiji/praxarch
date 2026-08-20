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

// The nine praxarch-installed roles. Config (routeGuard.knownRoles) extends this set at runtime
// for defined roles praxarch doesn't own — see RouteGuardConfig.
const BUILTIN_ROLES = [
  "scout",
  "Explore",
  "mech-executor",
  "executor",
  "verifier",
  "security-executor",
  "planner",
  "implementer",
  "plan-reviewer",
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

function allow(warnings: string[] = []): PreToolUseOutput {
  const output: PreToolUseOutput = {
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
  };
  if (warnings.length > 0) output.systemMessage = warnings.join(" ");
  return output;
}

// configWarnings are appended to whatever systemMessage the decision itself produces — a bad
// config must be visible, but it never changes the permissionDecision (strict default holds).
function decide(strict: boolean, reason: string, configWarnings: string[] = []): PreToolUseOutput {
  const base = strict ? `praxarch route-guard: blocked — ${reason}` : `praxarch route-guard: ${reason}`;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: strict ? "deny" : "allow",
      permissionDecisionReason: reason,
    },
    systemMessage: [base, ...configWarnings].join(" "),
  };
}

async function main(): Promise<void> {
  const input = await readHookInput<PreToolUseInput>();

  if (input.tool_name !== "Agent") {
    emit(allow());
    return;
  }

  const { subagent_type: subagentType, model, prompt = "", description = "" } = input.tool_input;
  const { config, warnings } = await loadConfig(input.cwd);

  const haystack = `${prompt} ${description}`;
  const securityKeywords = [...BUILTIN_SECURITY_KEYWORDS, ...config.routeGuard.securityKeywords];
  const matchedKeyword = securityKeywords.find((kw) => keywordPattern(kw).test(haystack));

  // Review roles are exempt (the 2026-07-08 verifier exemption, generalized to config): a
  // read-only reviewer of auth/secrets code necessarily mentions those keywords, and blocking
  // it here deadlocks against verify-gate, which requires a review pass on exactly these
  // security-sensitive tickets. Default is ["verifier"]; config adds, never removes.
  const reviewRoles = new Set(config.routeGuard.reviewRoles);
  const isReviewRole = subagentType !== undefined && reviewRoles.has(subagentType);
  // A soft-deny warning carried forward from the security-keyword check below, if any, to be
  // attached to the eventual decision. It must never short-circuit the known-role/ad-hoc rules
  // that run after this block — see the softDenyRoles handling below for why.
  let softDenyReason: string | undefined;

  if (matchedKeyword !== undefined && subagentType !== "security-executor" && !isReviewRole) {
    // Soft-deny roles (default ["executor"]) get a warning instead of the hard deny below: same
    // model tier as security-executor, so the deny was buying process overhead, not classifier
    // avoidance, at the cost of reword-and-retry loops. Checked only after the review-role
    // exemption above, so a role that's already exempt never gets this warning layered on top.
    const softDenyRoles = new Set(config.routeGuard.softDenyRoles);
    const isSoftDenyRole = subagentType !== undefined && softDenyRoles.has(subagentType);
    if (isSoftDenyRole) {
      // IMPORTANT: do not decide()+return here. A security-keyword match against a soft-deny
      // role must not bypass the explicit-model-override and ad-hoc-no-model rules below — those
      // rules exist independently of the security check and a known role passing an explicit
      // model (or an ad-hoc call passing none) is still wrong even when the prompt also happens
      // to look security-sensitive. Stash the warning and fall through; it's only ever surfaced
      // if nothing later in the chain decides to deny. If a later rule denies, that deny's
      // message wins outright and this warning is dropped — never silently downgrade a real deny
      // to "just a warning", and the later deny paths must stay byte-compatible with today's
      // messages regardless of whether a soft-deny warning was also pending.
      softDenyReason =
        `warning — this delegation looks security-sensitive (matched keyword "${matchedKeyword}") ` +
        `but is going to "${subagentType}"; if it touches auth/secrets/crypto/trust-boundary ` +
        `validation, route it to security-executor instead.`;
    } else {
      emit(
        decide(
          config.routeGuard.strict,
          `this delegation looks security-sensitive (matched keyword "${matchedKeyword}") but ` +
            `subagent_type is "${subagentType ?? "unset"}", not "security-executor". Route ` +
            `auth/secrets/crypto/validation work to security-executor per the orchestration policy.`,
          warnings,
        ),
      );
      return;
    }
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
        warnings,
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
        warnings,
      ),
    );
    return;
  }

  // Nothing later in the chain denied. If a soft-deny security warning was pending, surface it
  // now (unconditionally allow — strict=false to decide() — since the soft-deny posture doesn't
  // vary with routeGuard.strict); otherwise plain allow.
  if (softDenyReason !== undefined) {
    emit(decide(false, softDenyReason, warnings));
    return;
  }

  emit(allow(warnings));
}

main().catch((err: unknown) => {
  // A route-guard crash must never block the session — fail open with a visible warning.
  process.stderr.write(`praxarch route-guard error (failing open): ${String(err)}\n`);
  emit(allow());
});
