// Model tiers, weakest first. The one ranking shared by route-guard's security tier and the
// report's role-binding sort.
export const TIER_ORDER = ["haiku", "sonnet", "opus", "fable"] as const;

export type Tier = (typeof TIER_ORDER)[number];

// Substring, not equality: a model may be a short tier name ("opus") or a full id
// ("claude-fable-5-1[1m]"). `unknown`, because route-guard passes untrusted tool_input straight
// through: anything that isn't a string, or names no known tier, is null. Never throws.
// Scans weakest first, so an id naming two tiers resolves to the lower one (fails closed).
export function tierOf(model: unknown): Tier | null {
  if (typeof model !== "string") return null;
  const lower = model.toLowerCase();
  return TIER_ORDER.find((tier) => lower.includes(tier)) ?? null;
}
