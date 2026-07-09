#!/usr/bin/env node
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { readSessionState, writeSessionState } from "./lib/session-state.js";
import { emit, readHookInput, type SessionStartInput, type SessionStartOutput } from "./lib/hook-io.js";

/**
 * SessionStart — ensures session state exists, and does a lightweight drift check (not the full
 * `praxarch doctor` check) so an obvious misconfiguration surfaces immediately instead of silently
 * degrading delegation for the whole session.
 */

const ROLE_FILES = ["scout", "Explore", "mech-executor", "executor", "verifier", "security-executor"];

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
  await writeSessionState(state);

  const warnings: string[] = [];

  if (process.env["CLAUDE_CODE_SUBAGENT_MODEL"]) {
    warnings.push(
      "CLAUDE_CODE_SUBAGENT_MODEL is set — this overrides every role's model binding and defeats " +
        "praxarch's tiered routing. Unset it unless that's intentional.",
    );
  }

  const agentsDir = join(homedir(), ".claude", "agents");
  const missing: string[] = [];
  for (const role of ROLE_FILES) {
    if (!(await fileExists(join(agentsDir, `${role}.md`)))) missing.push(role);
  }
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
