/**
 * Merges praxarch's settings fragment into the user's existing ~/.claude/settings.json
 * additively and non-destructively:
 *   - model / fallbackModel / statusLine: only SET if the key is currently absent. Never
 *     overwrite a value the user already chose (e.g. via `/model`) — surfaced as a "left
 *     unchanged" note instead.
 *   - hooks: merged per event+matcher group, appending only hook commands that aren't already
 *     present. Safe to run repeatedly (idempotent) and safe alongside hooks the user configured
 *     for other tools.
 */

interface HookCommand {
  type: string;
  command: string;
}

interface HookGroup {
  matcher?: string;
  hooks: HookCommand[];
}

type HooksMap = Record<string, HookGroup[]>;

export interface SettingsFragment {
  model?: unknown;
  fallbackModel?: unknown;
  statusLine?: unknown;
  hooks?: HooksMap;
  [key: string]: unknown;
}

export interface MergeResult {
  merged: Record<string, unknown>;
  changes: string[];
}

function sameMatcher(a: string | undefined, b: string | undefined): boolean {
  return (a ?? null) === (b ?? null);
}

function mergeHooks(existing: HooksMap | undefined, fragment: HooksMap): { merged: HooksMap; changes: string[] } {
  const merged: HooksMap = existing ? structuredClone(existing) : {};
  const changes: string[] = [];

  for (const [event, fragGroups] of Object.entries(fragment)) {
    const existingGroups = merged[event] ?? [];
    for (const fragGroup of fragGroups) {
      const target = existingGroups.find((g) => sameMatcher(g.matcher, fragGroup.matcher));
      if (!target) {
        existingGroups.push(structuredClone(fragGroup));
        changes.push(`hooks.${event}: added new hook group${fragGroup.matcher ? ` (matcher ${fragGroup.matcher})` : ""}`);
        continue;
      }
      for (const cmd of fragGroup.hooks) {
        if (target.hooks.some((h) => h.command === cmd.command)) {
          changes.push(`hooks.${event}: "${cmd.command}" already present, left unchanged`);
        } else {
          target.hooks.push(cmd);
          changes.push(`hooks.${event}: added "${cmd.command}"`);
        }
      }
    }
    merged[event] = existingGroups;
  }

  return { merged, changes };
}

export function mergeSettings(
  existing: Record<string, unknown>,
  fragment: SettingsFragment,
): MergeResult {
  const merged = structuredClone(existing);
  const changes: string[] = [];

  for (const key of ["model", "fallbackModel", "statusLine"] as const) {
    if (fragment[key] === undefined) continue;
    if (merged[key] === undefined) {
      merged[key] = fragment[key];
      changes.push(`${key}: set to ${JSON.stringify(fragment[key])}`);
    } else {
      changes.push(`${key}: left existing value unchanged (praxarch would set ${JSON.stringify(fragment[key])})`);
    }
  }

  if (fragment.hooks) {
    const existingHooks = merged["hooks"] as HooksMap | undefined;
    const { merged: mergedHooks, changes: hookChanges } = mergeHooks(existingHooks, fragment.hooks);
    merged["hooks"] = mergedHooks;
    changes.push(...hookChanges);
  }

  return { merged, changes };
}
