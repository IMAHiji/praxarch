#!/usr/bin/env node
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { readSessionState, writeSessionState } from "./lib/session-state.js";
import { writeUntrackedBaseline } from "./lib/untracked-baseline-store.js";
import { captureUntrackedBaseline } from "./lib/untracked.js";
import { emit, readHookInput, type SessionStartInput, type SessionStartOutput } from "./lib/hook-io.js";

const execFileAsync = promisify(execFile);

/**
 * SessionStart — ensures session state exists, and does a lightweight drift check (not the full
 * `praxarch doctor` check) so an obvious misconfiguration surfaces immediately instead of silently
 * degrading delegation for the whole session.
 */

// Lowercase "explore" — the installed file is explore.md (the agent *name* "Explore" comes from
// frontmatter). Checking "Explore.md" only passed on case-insensitive filesystems.
// Keep in sync with ROLE_FILES in src/cli/doctor.ts.
const ROLE_FILES = ["scout", "explore", "mech-executor", "executor", "verifier", "checker", "security-executor", "planner", "implementer", "plan-reviewer"];

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const input = await readHookInput<SessionStartInput>();

  const state = await readSessionState(input.session_id);
  // Only capture on first run — SessionStart also fires on resume/clear/compact, and
  // re-capturing then would move the verify-gate's baseline mid-session.
  if (state.baselineHead === undefined || state.baselineHead === null) {
    try {
      const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: input.cwd });
      state.baselineHead = stdout.trim();
    } catch {
      state.baselineHead = null;
    }
  }
  // Gated on `source === "startup"` AND the `in` check together, not either alone:
  //
  // - `source === "startup"` closes the legacy-state laundering hole: a session that began before
  //   `baselineUntrackedCaptured` existed only ever receives resume/clear/compact events from here
  //   on (a brand-new session_id is the only way to get a genuine "startup" event), so gating on
  //   source means such a session's marker is never set and its baseline stays permanently
  //   "unknown" (count everything) instead of capturing whatever untracked files happen to exist
  //   at the first post-upgrade SessionStart -- which would silently include the session's own
  //   in-progress work as if it pre-existed.
  // - `!== true` is what makes a single "startup" capture durable across the rest of the session:
  //   `baselineUntrackedCaptured` is `true` the moment a capture is attempted and is the only value
  //   ever written (see the field's doc comment in `lib/session-state.ts`), so re-capturing would
  //   only ever happen on a genuinely-never-set marker -- moving the baseline mid-session and
  //   laundering in-session files out of the measurement, the same class of bug the comment above
  //   guards `baselineHead` against.
  if (input.source === "startup" && state.baselineUntrackedCaptured !== true) {
    const baseline = await captureUntrackedBaseline(input.cwd);
    await writeUntrackedBaseline(input.session_id, baseline);
    state.baselineUntrackedCaptured = true;
  }
  // Same laundering trap as the untracked-baseline guard above: gating on `source === "startup"`
  // alone (dropping the `undefined` check) would move the anchor on every resume/clear/compact,
  // measuring later diffs from wherever the shell happened to `cd` to at that resume rather than
  // where the session's baselines were actually captured -- see baselineCwd's doc comment in
  // session-state.ts and this issue's repro (a `cd` into a worktree got charged against the
  // primary checkout's baseline). `undefined` (not `!= null`) is deliberate: baselineCwd, once
  // set, is always a real string -- there is no "attempted and unusable" null state to guard
  // against here, unlike baselineHead.
  if (input.source === "startup" && state.baselineCwd === undefined) {
    state.baselineCwd = input.cwd;
  }
  await writeSessionState(state);

  const warnings: string[] = [];

  if (process.env["CLAUDE_CODE_SUBAGENT_MODEL"]) {
    warnings.push(
      "CLAUDE_CODE_SUBAGENT_MODEL is set — this overrides every role's model binding and defeats " +
        "praxarch's tiered routing. Unset it unless that's intentional.",
    );
  }

  const agentsDir = join(homedir(), ".claude", "agents");
  // Ten independent `access` calls — run together rather than serially. `Promise.all` over a `map`
  // preserves ROLE_FILES order, so the warning below still names missing roles in the declared
  // order.
  const roleChecks = await Promise.all(
    ROLE_FILES.map(async (role) => ({ role, present: await fileExists(join(agentsDir, `${role}.md`)) })),
  );
  const missing = roleChecks.filter((check) => !check.present).map((check) => check.role);
  if (missing.length > 0) {
    warnings.push(
      `praxarch role file(s) missing from ~/.claude/agents: ${missing.join(", ")}. Run ` +
        `\`praxarch install\` or \`praxarch doctor\` to fix.`,
    );
  }

  const output: SessionStartOutput = {
    hookSpecificOutput: { hookEventName: "SessionStart" },
  };
  if (warnings.length > 0) {
    output.systemMessage = warnings.join(" ");
  }
  emit(output);
}

main().catch((err: unknown) => {
  process.stderr.write(`praxarch session-init error (non-blocking): ${String(err)}\n`);
  emit({ hookSpecificOutput: { hookEventName: "SessionStart" } });
});
