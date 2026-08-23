#!/usr/bin/env node
import { install } from "./install.js";
import { doctor } from "./doctor.js";
import { uninstall } from "./uninstall.js";
import { recordVerdict } from "./record-verdict.js";
import { verifyBundle } from "./verify-bundle.js";
import { prune } from "./prune.js";

function printUsage(): void {
  process.stdout.write(
    [
      "Usage: praxarch <command> [options]",
      "",
      "Commands:",
      "  install [--yes]     Merge praxarch config into ~/.claude (shows a plan, asks to confirm)",
      "  uninstall [--yes]   Remove praxarch config from ~/.claude",
      "  doctor              Check installation health, report drift",
      "  doctor --prune      Delete session state older than PRAXARCH_STATE_RETENTION_DAYS (30)",
      "                      and debug payloads older than PRAXARCH_DEBUG_RETENTION_DAYS (7)",
      "  record-verdict --session <id> --role <role> [--file <path>]",
      "                      Record a verdict (verifier output on stdin or --file) into session",
      "                      state so verify-gate sees it — for verdicts delivered by a resumed",
      "                      agent, which no hook observes.",
      "  verify-bundle [--base <ref>] [--out <path>] [--test-cmd <cmd>]",
      "                      Write a single markdown artifact (base ref, diff --stat, full diff,",
      "                      untracked-file contents, optional test output) for a verification",
      "                      pass to read instead of exploring the repo. Read-only; prints the",
      "                      output path.",
      "",
      "Options:",
      "  --yes    Skip the confirmation prompt (for scripted use)",
    ].join("\n") + "\n",
  );
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const yes = rest.includes("--yes");

  switch (command) {
    case "install":
      await install({ yes });
      return;
    case "uninstall":
      await uninstall({ yes });
      return;
    case "doctor":
      if (rest.includes("--prune")) {
        process.exitCode = await prune();
        return;
      }
      await doctor();
      return;
    case "record-verdict":
      process.exitCode = await recordVerdict(rest);
      return;
    case "verify-bundle":
      process.exitCode = await verifyBundle(rest);
      return;
    default:
      printUsage();
      process.exitCode = command ? 1 : 0;
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`praxarch error: ${String(err)}\n`);
  process.exitCode = 1;
});
