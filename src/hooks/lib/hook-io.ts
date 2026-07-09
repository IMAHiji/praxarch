/**
 * Shared stdin/stdout contract for Claude Code command hooks.
 *
 * The Agent tool's tool_input schema isn't enumerated in the hooks docs (tool_input varies per
 * tool and isn't guaranteed stable), so every field below except the common envelope is read
 * defensively — hooks must no-op or warn rather than throw when a field is absent.
 */

export interface HookInputBase {
  session_id: string;
  cwd: string;
  hook_event_name: string;
  transcript_path?: string;
}

export interface PreToolUseInput extends HookInputBase {
  hook_event_name: "PreToolUse";
  tool_name: string;
  tool_input: {
    subagent_type?: string;
    model?: string;
    prompt?: string;
    description?: string;
    isolation?: string;
    [key: string]: unknown;
  };
}

export interface PostToolUseInput extends HookInputBase {
  hook_event_name: "PostToolUse";
  tool_name: string;
  tool_use_id?: string;
  tool_input: PreToolUseInput["tool_input"];
  tool_output?: { type: string; text?: string };
}

export interface StopInput extends HookInputBase {
  hook_event_name: "Stop";
  last_assistant_message?: string;
  tool_results?: { tool_use_id: string; tool_name: string; was_successful: boolean }[];
}

export interface SessionStartInput extends HookInputBase {
  hook_event_name: "SessionStart";
  source: "startup" | "resume" | "clear" | "compact";
  model?: string;
}

export type PermissionDecision = "allow" | "deny" | "ask";

export interface PreToolUseOutput {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: PermissionDecision;
    permissionDecisionReason?: string;
  };
  systemMessage?: string;
}

export interface StopOutput {
  decision?: "block";
  reason?: string;
  hookSpecificOutput?: { hookEventName: "Stop"; additionalContext?: string };
}

export interface SessionStartOutput {
  hookSpecificOutput: { hookEventName: "SessionStart"; additionalContext?: string };
  systemMessage?: string;
}

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function readHookInput<T>(): Promise<T> {
  const raw = await readStdin();
  return JSON.parse(raw) as T;
}

export function emit(output: unknown): void {
  process.stdout.write(JSON.stringify(output));
}
