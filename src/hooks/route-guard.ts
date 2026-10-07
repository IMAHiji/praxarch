#!/usr/bin/env node
import { loadConfig } from "./lib/config.js";
import { appendJsonl } from "./lib/jsonl.js";
import { logFileForDate } from "./lib/paths.js";
import { TIER_ORDER, tierOf, type Tier } from "./lib/tiers.js";
import { emit, readHookInput, type PreToolUseInput, type PreToolUseOutput } from "./lib/hook-io.js";

/**
 * PreToolUse(Agent) — hard-enforces three orchestration rules the policy text alone can't
 * guarantee under pressure: (1) security-sensitive delegations must go to security-executor,
 * (2) ad-hoc fan-out calls that don't use a defined role must declare `model` explicitly rather
 * than silently inheriting the main session's tier, (3) defined-role calls must NOT pass an
 * explicit `model`, which would override the role's frontmatter binding.
 */

// The eleven praxarch-installed roles. Config (routeGuard.knownRoles) extends this set at runtime
// for defined roles praxarch doesn't own — see RouteGuardConfig.
const BUILTIN_ROLES = [
  "scout",
  "Explore",
  "claude-code-guide",
  "mech-executor",
  "executor",
  "verifier",
  "checker",
  "security-executor",
  "planner",
  "implementer",
  "plan-reviewer",
];

// The lowest model tier at which a security-keyword match warns instead of denying (issue #1):
// security-executor's own binding, pinned against templates/agents/security-executor.md by a
// route-guard test. Any tier ranked at or above it warns too (issue #18: fable outranks opus).
// Only an ad-hoc call's explicit `model` is compared against it. A defined role's real model
// depends on which agent file Claude Code loads, which a hook can't know.
const SECURITY_TIER: Tier = "opus";

// tierOf takes `unknown`, not the declared string type: tool_input is untrusted JSON, and a
// non-string model that threw here would land in the crash handler's fail-open allow instead of
// the hard deny. Unknown or non-string models rank nowhere, so they deny.
function atOrAboveSecurityTier(model: unknown): boolean {
  const tier = tierOf(model);
  return tier !== null && TIER_ORDER.indexOf(tier) >= TIER_ORDER.indexOf(SECURITY_TIER);
}

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
  // Password-hashing algorithms, always-match (issue #1); a bare `hash*` would fire on commit
  // hashes and hashmaps.
  "bcrypt*",
  "argon2*",
  "scrypt",
  "pbkdf2",
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

type RouteGuardRule = "security-keyword" | "explicit-model-on-role" | "ad-hoc-no-model";

// Issue #19: one row per deny and per soft-deny warning (plain allows aren't logged), so the
// security keywords can be tuned on logged false positives. Awaited only after the decision is
// emitted (AGENTS.md). Best-effort like verify-gate's logEscapeHatch: if a failure escaped here,
// main().catch would emit a second allow after the real decision and corrupt stdout.
// - matchedKeyword is set only on security-keyword rows. A keyword that matched but didn't cause
//   the deny (an exempt or security-executor role denied for its explicit model) would read as a
//   keyword false positive.
// - strict is config.routeGuard.strict. Under strict:false, a routeGuardDenied row went out as an
//   allow. A routeGuardWarned row is always an allow, so there it's just informational.
// - Neither the prompt nor the model is logged.
async function logDecision(
  sessionId: string,
  event: "routeGuardDenied" | "routeGuardWarned",
  fields: { subagentType: string | undefined; rule: RouteGuardRule; matchedKeyword: string | null; strict: boolean },
): Promise<void> {
  try {
    await appendJsonl(logFileForDate(), {
      at: new Date().toISOString(),
      sessionId,
      event,
      subagentType: fields.subagentType ?? null,
      rule: fields.rule,
      matchedKeyword: fields.matchedKeyword,
      strict: fields.strict,
    });
  } catch (err) {
    process.stderr.write(`praxarch route-guard: could not append the ${event} audit row: ${String(err)}\n`);
  }
}

// Set as soon as the hook input is parsed, so the crash handler at the bottom of this file can
// still attribute its guard-crash log row to a session even though the exception it's handling
// may have happened well past main()'s own scope (e.g. inside loadConfig). Stays null when the
// crash happens before input parses at all (malformed stdin JSON) — better an unattributed row
// than none.
let sessionIdForCrashLog: string | null = null;

async function main(): Promise<void> {
  const input = await readHookInput<PreToolUseInput>();
  sessionIdForCrashLog = input.session_id;

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
  // security-sensitive tickets. Default is ["verifier", "checker", "plan-reviewer", "planner"];
  // config adds, never removes.
  const reviewRoles = new Set(config.routeGuard.reviewRoles);
  const isReviewRole = subagentType !== undefined && reviewRoles.has(subagentType);
  // A soft-deny warning carried forward from the security-keyword check below, if any, to be
  // attached to the eventual decision. It must never short-circuit the known-role/ad-hoc rules
  // that run after this block — see the ad-hoc security-tier handling below for why.
  let softDenyReason: string | undefined;

  const knownRoles = new Set([...BUILTIN_ROLES, ...config.routeGuard.knownRoles]);
  const isKnownRole = subagentType !== undefined && knownRoles.has(subagentType);

  if (matchedKeyword !== undefined && subagentType !== "security-executor" && !isReviewRole) {
    // Warn-only for an ad-hoc call that itself asks for security-executor's tier (issue #1): there
    // the hard deny buys reword-and-retry loops, not a stronger model. Defined roles always take
    // the hard deny. Their model comes from whichever agent file Claude Code loads (managed,
    // --add-dir, --agents, ancestor and worktree sources a hook can't see), so this hook can't
    // know it. Checked only after the review-role exemption above, so an exempt role never gets
    // this warning layered on top.
    if (!isKnownRole && atOrAboveSecurityTier(model)) {
      // IMPORTANT: do not decide()+return here. A security-keyword match against an ad-hoc
      // security-tier call must not bypass the explicit-model-override and ad-hoc-no-model rules below — those
      // rules exist independently of the security check and a known role passing an explicit
      // model (or an ad-hoc call passing none) is still wrong even when the prompt also happens
      // to look security-sensitive. Stash the warning and fall through; it's only ever surfaced
      // if nothing later in the chain decides to deny. If a later rule denies, that deny's
      // message wins outright and this warning is dropped — never silently downgrade a real deny
      // to "just a warning", and the later deny paths must stay byte-compatible with today's
      // messages regardless of whether a soft-deny warning was also pending.
      softDenyReason =
        `warning — this delegation looks security-sensitive (matched keyword "${matchedKeyword}") ` +
        `but is going to "${subagentType ?? "unset"}"; if it touches auth/secrets/crypto/trust-boundary ` +
        `validation, route it to security-executor instead.`;
    } else {
      emit(
        decide(
          config.routeGuard.strict,
          `this delegation looks security-sensitive (matched keyword "${matchedKeyword}") but ` +
            `subagent_type is "${subagentType ?? "unset"}", not "security-executor". Route ` +
            `auth/secrets/crypto/validation work to security-executor per the orchestration policy; ` +
            `if this isn't security work, an ad-hoc dispatch (no defined role) with model ` +
            `"${SECURITY_TIER}" gets a warning instead of a block.`,
          warnings,
        ),
      );
      await logDecision(input.session_id, "routeGuardDenied", {
        subagentType,
        rule: "security-keyword",
        matchedKeyword,
        strict: config.routeGuard.strict,
      });
      return;
    }
  }

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
    await logDecision(input.session_id, "routeGuardDenied", {
      subagentType,
      rule: "explicit-model-on-role",
      matchedKeyword: null,
      strict: config.routeGuard.strict,
    });
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
    await logDecision(input.session_id, "routeGuardDenied", {
      subagentType,
      rule: "ad-hoc-no-model",
      matchedKeyword: null,
      strict: config.routeGuard.strict,
    });
    return;
  }

  // Nothing later in the chain denied. If a soft-deny security warning was pending, surface it
  // now (unconditionally allow — strict=false to decide() — since the soft-deny posture doesn't
  // vary with routeGuard.strict); otherwise plain allow.
  if (softDenyReason !== undefined) {
    emit(decide(false, softDenyReason, warnings));
    await logDecision(input.session_id, "routeGuardWarned", {
      subagentType,
      rule: "security-keyword",
      matchedKeyword: matchedKeyword ?? null,
      strict: config.routeGuard.strict,
    });
    return;
  }

  emit(allow(warnings));
}

main().catch(async (err: unknown) => {
  // A route-guard crash must never block the session — fail open with a visible warning. Before
  // #24, this crash was permanently unfalsifiable after the fact: the catch allowed and wrote
  // only a stderr line no one sees (postmortem for issue #7's unresolved "did the guard crash and
  // fail open?" hypothesis). The guard-crash row below closes that gap. It is itself try-wrapped —
  // a logging failure must not turn fail-open into fail-closed, and must not mask the original
  // error, so failure here is swallowed and the fail-open allow still ships.
  const detail = String(err);
  process.stderr.write(`praxarch route-guard error (failing open): ${detail}\n`);
  try {
    await appendJsonl(logFileForDate(), {
      at: new Date().toISOString(),
      sessionId: sessionIdForCrashLog,
      event: "guard-crash",
      hook: "route-guard",
      error: detail,
    });
  } catch {
    // Best-effort — a logging failure must not compound the original crash or block the session.
  }
  emit(allow());
});
