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
  // Shape verified against a live capture (see fixtures/post-tool-use.agent.json). The field is
  // tool_response — NOT tool_output — and the subagent's text lives in the content array.
  tool_response?: {
    status?: string;
    agentType?: string;
    content?: { type: string; text?: string }[];
    resolvedModel?: string;
    totalTokens?: number;
    totalDurationMs?: number;
    [key: string]: unknown;
  };
}

export interface StopInput extends HookInputBase {
  hook_event_name: "Stop";
  /** True when this stop attempt follows a continuation that a Stop hook itself forced. */
  stop_hook_active?: boolean;
  last_assistant_message?: string;
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
  systemMessage?: string;
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

async function capturePayload(raw: string): Promise<void> {
  if (process.env["PRAXARCH_DEBUG_PAYLOADS"] !== "1") return;
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { praxarchHome } = await import("./paths.js");
  let event = "unknown";
  try {
    event = String((JSON.parse(raw) as { hook_event_name?: string }).hook_event_name ?? "unknown");
  } catch {
    // keep "unknown" — capture the raw payload regardless of whether it parses
  }
  const dir = join(praxarchHome(), "debug");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${Date.now()}-${process.pid}-${event}.json`), raw, "utf8");
}

export async function readHookInput<T>(): Promise<T> {
  const raw = await readStdin();
  await capturePayload(raw);
  return JSON.parse(raw) as T;
}

export function emit(output: unknown): void {
  process.stdout.write(JSON.stringify(output));
}
