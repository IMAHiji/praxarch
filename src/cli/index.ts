#!/usr/bin/env node
import { install } from "./install.js";
import { doctor } from "./doctor.js";
import { uninstall } from "./uninstall.js";

function printUsage(): void {
  process.stdout.write(
    [
      "Usage: praxarch <command> [options]",
      "",
      "Commands:",
      "  install [--yes]     Merge praxarch config into ~/.claude (shows a plan, asks to confirm)",
      "  uninstall [--yes]   Remove praxarch config from ~/.claude",
      "  doctor              Check installation health, report drift",
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
      await doctor();
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
